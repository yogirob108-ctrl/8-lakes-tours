import { createHmac, randomInt } from 'node:crypto';
import { NextResponse } from 'next/server';
import { isSupabaseAdminConfigured } from '@/lib/ops-config';
import { createSupabaseAdminClient } from '@/lib/supabase-admin';
import { bookingCustomerEmail, bookingInternalEmail, getInternalEmailRecipients, sendEmail } from '@/lib/email';
import { subscribeToNewsletter } from '@/lib/newsletter';
import { hasExplicitNewsletterOptIn } from '@/lib/newsletter-consent.mjs';
import { GROUP_INVOICE, isBookableTourDate, manualPaymentReason, requiresManualPaymentLink } from '@/lib/tour-booking.mjs';
import { getGroupPricing } from '@/lib/group-pricing.mjs';
import { normalizePublicBookingPayload } from '@/lib/public-booking.mjs';
import { recoveryUrl } from '@/lib/booking-checkout';

export const runtime = 'nodejs';
const MAX_REQUEST_BYTES = 64 * 1024;

type PublicBookingPayload = Record<string, unknown> & {
  newsletter_opt_in?: unknown;
  companion_details_permission?: unknown;
};

type EmailContent = { subject: string; html: string; text: string };
type BookingRpcRow = { booking_id: string; customer_id: string; public_reference: string; created: boolean };

function clean(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function attributionNote(attribution: Record<string, string>) {
  const labels: Record<string, string> = {
    source: 'UTM source', medium: 'UTM medium', campaign: 'UTM campaign', term: 'UTM term', content: 'UTM content',
    gclid: 'Google click ID', fbclid: 'Meta click ID', ttclid: 'TikTok click ID', msclkid: 'Microsoft click ID',
    referrer: 'Referrer', landing_url: 'Landing URL', current_url: 'Current URL', ga_client_id: 'GA client ID',
  };
  const lines = Object.entries(labels).flatMap(([key, label]) => attribution[key] ? [`${label}: ${attribution[key]}`] : []);
  return lines.length ? ['--- Attribution ---', ...lines].join('\n') : '';
}

function jsonError(message: string, status = 400) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

function generateBookingReference() {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const code = Array.from({ length: 7 }, () => alphabet[randomInt(alphabet.length)]).join('');
  return `8L-${code}`;
}

function requestIp(request: Request) {
  return clean(request.headers.get('x-vercel-forwarded-for') || request.headers.get('x-forwarded-for')).split(',')[0]?.trim()
    || clean(request.headers.get('x-real-ip'))
    || 'unknown';
}

function hmacKey(kind: 'ip' | 'email', value: string) {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) throw new Error('Server key is unavailable');
  return createHmac('sha256', secret).update(`public-booking:${kind}:${value}`).digest('hex');
}

async function claimAndSendEmail(
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  booking: BookingRpcRow,
  templateKey: string,
  to: string | string[],
  replyTo: string,
  content: EmailContent,
) {
  const { data: claim, error: claimError } = await supabase.rpc('claim_public_booking_email_v2', {
    p_booking_id: booking.booking_id,
    p_customer_id: booking.customer_id,
    p_template_key: templateKey,
    p_payload: { to, replyTo, ...content },
  });
  const row = Array.isArray(claim) ? claim[0] : claim;
  if (claimError || !row?.should_send || !row.email_event_id || !row.claim_token || !row.payload) return;

  let result: { sent: boolean; id?: string; error?: string };
  try {
    result = await sendEmail({
      ...row.payload,
      idempotencyKey: `public-booking-${booking.booking_id}-${templateKey}`,
    });
  } catch (error) {
    result = { sent: false, error: error instanceof Error ? error.message : 'Email provider exception' };
  }

  try {
    await supabase.rpc('finalize_public_booking_email_v2', {
      p_email_event_id: row.email_event_id,
      p_claim_token: row.claim_token,
      p_sent: result.sent,
      p_provider_message_id: result.id ?? null,
      p_raw_response: result,
    });
  } catch {
    // Booking remains durable. The stable provider idempotency key protects a later retry.
  }
}

export async function POST(request: Request) {
  if (!isSupabaseAdminConfigured) return jsonError('Booking system is temporarily unavailable. Please email info@8lakestours.com.', 503);

  const declaredLength = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) return jsonError('Booking submission is too large.', 413);

  let rawBody: string;
  let payload: PublicBookingPayload;
  try {
    rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_REQUEST_BYTES) return jsonError('Booking submission is too large.', 413);
    payload = JSON.parse(rawBody) as PublicBookingPayload;
  } catch {
    return jsonError('Invalid booking submission.');
  }

  const normalized = normalizePublicBookingPayload(payload) as
    | { ok: false; error: string }
    | { ok: true; value: {
      submission_key: string;
      tour_date: string;
      emergency_contact: string;
      how_heard: string;
      notes: string;
      signature: string;
      attribution: Record<string, string>;
      travellers: Array<{
        position: number; is_lead: boolean; first_name: string; last_name: string;
        email: string | null; phone: string | null; nationality: string; gender: string | null;
        date_of_birth: string; riding_experience: string; dietary_notes: string | null;
      }>;
    } };
  if (!normalized.ok) return jsonError(normalized.error ?? 'Invalid booking submission.');
  const bookingInput = normalized.value;
  const travellers = bookingInput.travellers;
  const leadTraveller = travellers[0];
  const email = leadTraveller.email as string;
  const firstName = leadTraveller.first_name;
  const lastName = leadTraveller.last_name;
  const tourDate = bookingInput.tour_date;

  if (travellers.length > 1 && clean(payload.companion_details_permission) !== 'on') {
    return jsonError('The lead booker must confirm permission to provide companion details.');
  }
  if (!tourDate || !isBookableTourDate(tourDate)) return jsonError('Please choose a currently available departure or request option.');

  const supabase = createSupabaseAdminClient();
  const ipKeyHash = hmacKey('ip', requestIp(request));
  const emailKeyHash = hmacKey('email', email.toLowerCase());
  const { data: rateData, error: rateError } = await supabase.rpc('consume_public_booking_rate_limits', {
    p_ip_key_hash: ipKeyHash,
    p_email_key_hash: emailKeyHash,
  });
  const rate = Array.isArray(rateData) ? rateData[0] : rateData;
  if (rateError) return jsonError('Booking system is temporarily unavailable. Please try again shortly.', 503);
  if (!rate?.allowed) {
    return NextResponse.json({ ok: false, error: 'Too many booking attempts. Please try again later.' }, {
      status: 429,
      headers: { 'Retry-After': String(rate?.retry_after_seconds || 3600) },
    });
  }

  const groupPricing = getGroupPricing(travellers.length);
  const manualPaymentRequired = requiresManualPaymentLink(tourDate, groupPricing.guestCount);
  const manualReason = manualPaymentReason(tourDate, groupPricing.guestCount);
  const attributionBlock = attributionNote(bookingInput.attribution);
  const travellerNames = travellers
    .map(traveller => `${traveller.position}. ${traveller.first_name} ${traveller.last_name}${traveller.is_lead ? ' (lead)' : ''}${traveller.gender ? ` — ${traveller.gender}` : ''}`)
    .join('\n');
  const bookingNotes = [
    `Guests booking together: ${groupPricing.guestCount}`,
    `Group rate: $${groupPricing.perPersonUsd.toLocaleString('en-US')} per person ($${groupPricing.onlinePerPersonUsd.toLocaleString('en-US')} online + $${groupPricing.localFamilyPerPersonUsd.toLocaleString('en-US')} local family cash)`,
    manualReason === GROUP_INVOICE
      ? `GROUP INVOICE REQUIRED: send one personal Stripe invoice for $${groupPricing.onlinePaymentUsd.toLocaleString('en-US')} covering all ${groupPricing.guestCount} guests.`
      : manualPaymentRequired ? 'CONFIRMATION REQUIRED: confirm capacity before sending a custom Stripe payment link.' : '',
    bookingInput.how_heard ? `How they heard about us: ${bookingInput.how_heard}` : '',
    bookingInput.notes,
    `Traveller manifest:\n${travellerNames}`,
    attributionBlock,
  ].filter(Boolean).join('\n\n');
  const customerNotes = [`Waiver signed online as: ${bookingInput.signature}`, attributionBlock].filter(Boolean).join('\n\n');

  const { data: rpcData, error: rpcError } = await supabase.rpc('create_public_booking', {
    p_submission_key: bookingInput.submission_key,
    p_public_reference: generateBookingReference(),
    p_project_slug: '8-lakes-tours',
    p_tour_date: tourDate,
    p_guest_count: groupPricing.guestCount,
    p_status: 'awaiting_payment',
    p_total_trip_value_usd: groupPricing.totalTripValueUsd,
    p_online_due_usd: groupPricing.onlinePaymentUsd,
    p_family_cash_due_usd: groupPricing.localFamilyPaymentUsd,
    p_emergency_contact: bookingInput.emergency_contact || null,
    p_customer_notes: customerNotes,
    p_booking_notes: bookingNotes,
    p_travellers: travellers,
  });
  const booking = (Array.isArray(rpcData) ? rpcData[0] : rpcData) as BookingRpcRow | null;
  if (rpcError?.message === 'submission key already belongs to a different booking payload') {
    return jsonError('This submission was already saved with different details. Your changes have not been saved. Please contact Rob to update the existing booking; do not submit a duplicate booking.', 409);
  }
  if (rpcError || !booking) return jsonError('Booking could not be saved. Please try again or email info@8lakestours.com.', 500);
  const reference = booking.public_reference;
  const paymentUrl = recoveryUrl(reference);
  // The transactional RPC compared the complete immutable intake payload. A
  // replay must resume notification claims after commit/send/ack failures, not
  // return early. Claims freeze the exact provider payload across deployments.

  // Everything below is best-effort post-persistence work and must never turn a
  // durable booking into a misleading HTTP 500 response.
  try {
    if (booking.created && hasExplicitNewsletterOptIn(payload.newsletter_opt_in)) {
      await subscribeToNewsletter(supabase, {
        firstName,
        lastName,
        email,
        source: 'booking_form_explicit_opt_in',
        interest: '8 Lakes Tours newsletter, offers, deals, blog posts, field notes, and business updates',
        consentContext: 'Explicit optional newsletter checkbox selected on the 8 Lakes Tours booking form',
        attribution: bookingInput.attribution,
      });
    }
  } catch {
    // No raw PII is logged; Ops can still see the durable booking.
  }

  const internalEmail = bookingInternalEmail({
    reference, firstName, lastName, email, phone: leadTraveller.phone ?? '', tourDate,
    guestCount: groupPricing.guestCount, pricePerPersonUsd: groupPricing.perPersonUsd,
    onlinePaymentUsd: groupPricing.onlinePaymentUsd, localFamilyPaymentUsd: groupPricing.localFamilyPaymentUsd,
    totalTripValueUsd: groupPricing.totalTripValueUsd, requiresManualPaymentLink: manualPaymentRequired,
    manualPaymentReason: manualReason, ridingExperience: leadTraveller.riding_experience,
    travellerNames, notes: bookingNotes,
  });
  const customerEmail = bookingCustomerEmail({
    reference, firstName, tourDate, guestCount: groupPricing.guestCount,
    pricePerPersonUsd: groupPricing.perPersonUsd, onlinePaymentUsd: groupPricing.onlinePaymentUsd,
    localFamilyPaymentUsd: groupPricing.localFamilyPaymentUsd, totalTripValueUsd: groupPricing.totalTripValueUsd,
    requiresManualPaymentLink: manualPaymentRequired, manualPaymentReason: manualReason, travellerNames, paymentUrl: manualPaymentRequired ? undefined : paymentUrl,
  });
  const internalRecipients = getInternalEmailRecipients();

  await Promise.all([
    // Internal alert is operational only. Customer confirmation is dispatched only by the server-verified payment webhook.
    claimAndSendEmail(supabase, booking, 'internal_booking_notification', internalRecipients, email, internalEmail),
  ]);

  return NextResponse.json({ ok: true, reference, created: booking.created, paymentUrl: manualPaymentRequired ? null : paymentUrl }, { headers: { 'Cache-Control': 'no-store' } });
}
