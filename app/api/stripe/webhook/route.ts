import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import { isSupabaseAdminConfigured } from '@/lib/ops-config';
import { createSupabaseAdminClient } from '@/lib/supabase-admin';
import { getInternalEmailRecipients, paymentConfirmedCustomerEmail, paymentReceivedInternalEmail, sendEmail } from '@/lib/email';
import {
  calculateRefundState,
  claimPaymentAsPaid,
  findExistingStripePayment,
  isSupportedPaymentCurrency,
  paymentProcessingDecision,
  resolveStripePaymentBooking,
  shouldProcessRefundStatus,
} from '@/lib/stripe-payment-match.mjs';
import { canAutomaticallyConfirmBooking } from '@/lib/tour-booking.mjs';

// Keep the provider side-effect window well inside the five-minute booking lease.
// Vercel terminates this invocation before an operator may reclaim a stale lease.
export const maxDuration = 60;

const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
const ga4MeasurementId = process.env.GA4_MEASUREMENT_ID || 'G-E9PW7T08LZ';
const ga4ApiSecret = process.env.GA4_MEASUREMENT_API_SECRET;
const stripe = new Stripe('sk_tes...only');

function jsonError(message: string, status = 400) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

function usdFromCents(amount: number | null | undefined) {
  if (!amount || amount <= 0) return 0;
  return Math.round(amount) / 100;
}

function eventTimestamp(event: Stripe.Event) {
  return new Date(event.created * 1000).toISOString();
}

function getCheckoutReference(session: Stripe.Checkout.Session) {
  return (
    session.client_reference_id ||
    session.metadata?.booking_reference ||
    session.metadata?.public_reference ||
    ''
  ).trim();
}

function getPaymentIntentId(value: Stripe.PaymentIntent | string | null) {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id;
}

function extractGaClientId(notes: unknown) {
  if (typeof notes !== 'string') return '';
  const match = notes.match(/^GA client ID:\s*(.+)$/im);
  return match?.[1]?.trim() || '';
}

function extractGaSessionId(notes: unknown) {
  if (typeof notes !== 'string') return '';
  const match = notes.match(/^GA session ID:\s*(.+)$/im);
  const sessionId = match?.[1]?.trim() || '';
  return /^\d{1,20}$/.test(sessionId) ? sessionId : '';
}

async function sendGa4PaymentReceived(input: {
  clientId: string;
  sessionId: string;
  amountUsd: number;
  currency: string;
  tourDate: string;
  eventId: string;
}) {
  if (!ga4ApiSecret || !ga4MeasurementId) {
    return { sent: false as const, retryable: false as const, reason: 'missing_ga4_config' };
  }
  if (!input.clientId) {
    return { sent: false as const, retryable: false as const, reason: 'missing_ga4_client_id' };
  }

  const endpoint = `https://www.google-analytics.com/mp/collect?measurement_id=${encodeURIComponent(ga4MeasurementId)}&api_secret=${encodeURIComponent(ga4ApiSecret)}`;
  // Session attribution is a documented Measurement Protocol use case that
  // requires the GA session_id event parameter, the request arriving within
  // 24 hours of the online session's start, and — when timestamp_micros is
  // overridden — a timestamp inside the session. This server sends promptly
  // after payment, so the session_id is included only when the booking
  // captured one from the consented browser; it is never defaulted or
  // invented, and no engagement time or timestamp is fabricated.
  const eventParams: Record<string, string | number> = {
    event_id: input.eventId,
    event_category: 'booking_funnel',
    currency: input.currency,
    value: input.amountUsd,
    tour_date: input.tourDate || 'TBC',
  };
  if (input.sessionId) eventParams.session_id = input.sessionId;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: input.clientId,
        // This server-side event is measurement-only: deny advertising signals
        // explicitly, consistent with the site's Consent Mode design.
        consent: { ad_user_data: 'DENIED', ad_personalization: 'DENIED' },
        events: [
          {
            name: 'payment_received',
            params: eventParams,
          },
        ],
      }),
    });
  } catch {
    // Never log error.message here: fetch errors can embed the full request
    // URL, which contains the Measurement Protocol API secret.
    console.warn('GA4 Measurement Protocol request failed', { reason: 'ga4_network_error' });
    return { sent: false as const, retryable: true as const, reason: 'ga4_network_error' };
  }

  if (!response.ok) {
    console.warn('GA4 Measurement Protocol request rejected', { status: response.status });
    return { sent: false as const, retryable: true as const, reason: `ga4_http_${response.status}` };
  }

  return { sent: true as const };
}

const GA4_EVENT_SENT_TITLE = 'GA4 payment_received event sent';
const GA4_EVENT_SKIPPED_TITLE = 'GA4 payment_received event skipped';

/**
 * Send the GA4 payment_received conversion at most once per Stripe session,
 * durably recorded on the booking timeline. A retryable GA4 failure throws so
 * the Stripe event is retried and analytics recovery still happens after the
 * payment itself is already recorded — a non-OK GA4 response must never write
 * a terminal record that blocks later retries. Permanent skips (missing GA4
 * config or a booking without a GA client id) are recorded once and do not
 * throw, so they can never strand payment processing. This is at-least-once
 * analytics delivery behind a durable local record, not an exactly-once
 * guarantee: a GA4 acceptance whose confirmation is lost (timeout/crash before
 * the record lands) can still duplicate, and GA4's event_id handling is
 * best-effort rather than a dedupe contract.
 *
 * With `recoveryOnly`, the helper only retries a genuine legacy terminal skip
 * record (missing reason or a retryable reason). A completed payment with no
 * GA4 timeline record at all is left untouched: no surprise writes or
 * retroactive conversions for bookings that predate GA4 collection.
 */
async function ensureGa4PaymentEvent(supabase: ReturnType<typeof createSupabaseAdminClient>, input: {
  booking: { id: string; tour_date: string | null; notes: string | null };
  sessionId: string;
  amountUsd: number;
  currency: string;
  recoveryOnly?: boolean;
}) {
  const { data: existingGaEvents, error: existingGaEventError } = await supabase
    .from('booking_events')
    .select('id, title, metadata')
    .eq('booking_id', input.booking.id)
    .in('title', [GA4_EVENT_SENT_TITLE, GA4_EVENT_SKIPPED_TITLE])
    .contains('metadata', { stripe_checkout_session_id: input.sessionId })
    .limit(100);
  if (existingGaEventError) {
    throw new Error(`GA4 event lookup failed: ${existingGaEventError.message}`);
  }
  const existingRows = (existingGaEvents ?? []) as Array<{ id: string; title: string; metadata: unknown }>;
  const toReason = (metadata: unknown) => {
    const raw = (metadata ?? {}) as Record<string, unknown>;
    return typeof raw.reason === 'string' ? raw.reason : '';
  };
  // A sent row always wins regardless of physical row order: an unsorted
  // limit(1) pick could return a legacy skip and re-send the conversion.
  const existingSent = existingRows.find(row => row.title === GA4_EVENT_SENT_TITLE);
  const existingSkip = existingRows.find(row => row.title === GA4_EVENT_SKIPPED_TITLE);
  const isPermanentSkip = (reason: string) => reason === 'missing_ga4_config' || reason === 'missing_ga4_client_id';

  let repairRow: { id: string } | null = null;
  if (input.recoveryOnly) {
    // Recovery only retries a genuine legacy terminal skip (missing reason or a
    // retryable reason). A completed payment with no GA4 timeline record at all
    // is left untouched: no surprise writes or retroactive conversions for
    // bookings that predate GA4 collection.
    if (existingSent) return;
    const skipReason = existingSkip ? toReason(existingSkip.metadata) : '';
    if (!existingSkip || isPermanentSkip(skipReason)) return;
    repairRow = existingSkip;
  } else if (existingSent || (existingSkip && isPermanentSkip(toReason(existingSkip.metadata)))) {
    return;
  }

  const eventId = crypto.randomUUID();
  const gaResult = await sendGa4PaymentReceived({
    clientId: extractGaClientId(input.booking.notes),
    sessionId: extractGaSessionId(input.booking.notes),
    amountUsd: input.amountUsd,
    currency: input.currency,
    tourDate: input.booking.tour_date || 'TBC',
    eventId,
  });

  if (!gaResult.sent && gaResult.retryable) {
    // No terminal record is written: throwing keeps the Stripe event eligible
    // for redelivery so a recovered GA4 dependency is not lost forever.
    throw new Error(`GA4 payment event send failed (${gaResult.reason}); retry the Stripe event.`);
  }

  // The persisted identifier is random and non-linkable, never a raw booking
  // reference or provider id; keep the dedupe boundary internal.
  const recordPayload = {
    booking_id: input.booking.id,
    event_type: 'system',
    direction: 'system',
    title: gaResult.sent ? GA4_EVENT_SENT_TITLE : GA4_EVENT_SKIPPED_TITLE,
    body: gaResult.sent
      ? 'Server-side GA4 Measurement Protocol event sent for confirmed Stripe payment.'
      : `Reason: ${gaResult.reason}. No GA4 Measurement Protocol request was made; this skip is permanent for this payment unless GA4 configuration or the booking's GA client id changes.`,
    metadata: gaResult.sent
      ? { stripe_checkout_session_id: input.sessionId, ga4_event_id: eventId }
      : { stripe_checkout_session_id: input.sessionId, reason: gaResult.reason },
    created_by: 'stripe-webhook',
  };

  if (repairRow) {
    // Converge the legacy skip row on sent in place: repairing must never add a
    // second GA4 timeline row for the same session.
    const { error: repairError } = await supabase
      .from('booking_events')
      .update({ title: recordPayload.title, body: recordPayload.body, metadata: recordPayload.metadata })
      .eq('id', repairRow.id);
    if (repairError) throw new Error(`GA4 event record repair failed: ${repairError.message}`);
    return;
  }

  const { error: gaEventError } = await supabase.from('booking_events').insert(recordPayload);
  if (gaEventError) throw new Error(`GA4 event record failed: ${gaEventError.message}`);
}

const PAYMENT_PROCESSING_LEASE_MS = 10 * 60 * 1000;

async function claimPaymentProcessingLease(paymentId: string) {
  const supabase = createSupabaseAdminClient();

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const { data: payment, error } = await supabase
      .from('payments')
      .select('id, status, raw_event, refunded_at')
      .eq('id', paymentId)
      .single();
    if (error) throw new Error(`Payment processing lease lookup failed: ${error.message}`);

    const rawEvent = typeof payment.raw_event === 'object' && payment.raw_event
      ? payment.raw_event as Record<string, unknown>
      : {};
    if (rawEvent.processing_complete === true) {
      return { acquired: false as const, complete: true as const, token: null };
    }

    const existingToken = typeof rawEvent.processing_token === 'string' ? rawEvent.processing_token : '';
    const claimedAtMs = typeof rawEvent.processing_claimed_at === 'string'
      ? Date.parse(rawEvent.processing_claimed_at)
      : 0;
    if (existingToken && Number.isFinite(claimedAtMs) && Date.now() - claimedAtMs < PAYMENT_PROCESSING_LEASE_MS) {
      return { acquired: false as const, complete: false as const, token: null };
    }

    const token = crypto.randomUUID();
    const claimedAt = new Date().toISOString();
    let leaseUpdate = supabase
      .from('payments')
      .update({
        raw_event: {
          ...rawEvent,
          processing_token: token,
          processing_claimed_at: claimedAt,
          processing_complete: false,
        },
      })
      .eq('id', payment.id)
      .eq('status', payment.status);
    leaseUpdate = payment.refunded_at
      ? leaseUpdate.eq('refunded_at', payment.refunded_at)
      : leaseUpdate.is('refunded_at', null);
    leaseUpdate = existingToken
      ? leaseUpdate.eq('raw_event->>processing_token', existingToken)
      : leaseUpdate.is('raw_event->>processing_token', null);

    const { data: leasedPayment, error: leaseError } = await leaseUpdate.select('id').maybeSingle();
    if (leaseError) throw new Error(`Payment processing lease claim failed: ${leaseError.message}`);
    if (leasedPayment) return { acquired: true as const, complete: false as const, token };
  }

  return { acquired: false as const, complete: false as const, token: null };
}

async function reconcileBookingPaymentBalance({
  paymentId,
  bookingId,
  processingToken,
}: {
  paymentId: string;
  bookingId: string;
  processingToken?: string;
}) {
  const supabase = createSupabaseAdminClient();

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const { data: payment, error: paymentError } = await supabase
      .from('payments')
      .select('id, amount_usd, status, raw_event, refunded_at')
      .eq('id', paymentId)
      .single();
    if (paymentError) throw new Error(`Payment reconciliation lookup failed: ${paymentError.message}`);

    const rawEvent = typeof payment.raw_event === 'object' && payment.raw_event
      ? payment.raw_event as Record<string, unknown>
      : {};
    const {data:reconciledAmount,error:bookingError}=await supabase.rpc('reconcile_paid_booking_v2',{p_booking_id:bookingId});
    if(bookingError || reconciledAmount == null) throw new Error('Booking ledger reconciliation unavailable; retry.');
    const onlinePaidUsd=Number(reconciledAmount);

    if (processingToken) {
      let completionUpdate = supabase
        .from('payments')
        .update({
          raw_event: {
            ...rawEvent,
            processing_token: null,
            processing_claimed_at: null,
            processing_complete: true,
            processing_completed_at: new Date().toISOString(),
          },
        })
        .eq('id', payment.id)
        .eq('status', payment.status)
        .eq('raw_event->>processing_token', processingToken);
      completionUpdate = payment.refunded_at
        ? completionUpdate.eq('refunded_at', payment.refunded_at)
        : completionUpdate.is('refunded_at', null);
      const { data: completedPayment, error: completionError } = await completionUpdate.select('id').maybeSingle();
      if (completionError) throw new Error(`Payment completion marker failed: ${completionError.message}`);
      if (completedPayment) return { onlinePaidUsd, status: payment.status };
      continue;
    }

    let verifyQuery = supabase
      .from('payments')
      .select('id')
      .eq('id', payment.id)
      .eq('status', payment.status);
    verifyQuery = payment.refunded_at
      ? verifyQuery.eq('refunded_at', payment.refunded_at)
      : verifyQuery.is('refunded_at', null);
    const { data: verifiedPayment, error: verifyError } = await verifyQuery.maybeSingle();
    if (verifyError) throw new Error(`Payment reconciliation verification failed: ${verifyError.message}`);
    if (verifiedPayment) return { onlinePaidUsd, status: payment.status };
  }

  throw new Error('Payment/booking reconciliation conflicted repeatedly; retry the Stripe event.');
}

async function transitionBookingAfterPaymentClaim(bookingId: string, confirmedAt: string, sessionId: string, expected: Record<string, unknown>, token: string) {
  const supabase = createSupabaseAdminClient();
  const {data,error}=await supabase.rpc('confirm_paid_booking_v2',{
    p_booking_id:bookingId,p_session_id:sessionId,p_expected:expected,p_token:token,p_confirmed_at:confirmedAt,
  });
  if(error || !data) throw new Error('Authoritative payment confirmation unavailable; retry.');
  return data;
}

async function readBookingStatus(bookingId: string) {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.from('bookings').select('status').eq('id', bookingId).single();
  if (error) throw new Error(`Booking status verification failed: ${error.message}`);
  return data.status;
}

async function releaseBookingConfirmationLease(bookingId: string, token: string) {
  const supabase = createSupabaseAdminClient();
  const { error } = await supabase
    .from('bookings')
    .update({ payment_confirmation_token: null, payment_confirmation_claimed_at: null })
    .eq('id', bookingId)
    .eq('payment_confirmation_token', token);
  if (error) throw new Error(`Booking confirmation lease release failed: ${error.message}`);
}

async function handleCheckoutSessionPaid(session: Stripe.Checkout.Session) {
  if (!isSupabaseAdminConfigured) {
    throw new Error('Supabase admin is not configured.');
  }

  const stripeReference = getCheckoutReference(session);

  if (session.payment_status !== 'paid') {
    console.info('Ignoring checkout session that is not paid', {
      sessionId: session.id,
      reference: stripeReference,
      paymentStatus: session.payment_status,
    });
    return { matched: false, reason: 'not_paid' };
  }

  const amountToRecord = usdFromCents(session.amount_total);
  const currency = session.currency?.toUpperCase() || '';
  if (!isSupportedPaymentCurrency(currency)) {
    console.warn('Ignoring Stripe checkout session with unsupported currency', { sessionId: session.id, currency: currency || null });
    return { matched: false, reason: 'unsupported_currency', currency: currency || null };
  }
  const paymentIntentId = getPaymentIntentId(session.payment_intent);
  const supabase = createSupabaseAdminClient();
  const bookingSelect = 'id, public_reference, status, online_paid_usd, online_due_usd, tour_date, guest_count, notes, customer_id, customer:customers(first_name, last_name, email)';

  const existingPayment = await findExistingStripePayment({
    sessionId: session.id,
    paymentIntentId,
    lookup: async (column: string, value: string) => {
      const { data, error } = await supabase
        .from('payments')
        .select('id, booking_id, stripe_checkout_session_id, stripe_payment_intent_id, status, amount_usd, raw_event, paid_at, refunded_at')
        .eq(column, value)
        .maybeSingle();
      if (error) throw new Error(`Payment lookup failed: ${error.message}`);
      return data;
    },
  });

  const bookingResolution = await resolveStripePaymentBooking({
    existingPayment,
    stripeReference,
    lookupBookingById: async (bookingId: string) => {
      const { data, error } = await supabase.from('bookings').select(bookingSelect).eq('id', bookingId).maybeSingle();
      if (error) throw new Error(`Payment booking lookup failed: ${error.message}`);
      return data;
    },
    lookupBookingByReference: async (reference: string) => {
      const { data, error } = await supabase.from('bookings').select(bookingSelect).eq('public_reference', reference).maybeSingle();
      if (error) throw new Error(`Booking reference lookup failed: ${error.message}`);
      return data;
    },
  });

  if (!bookingResolution.ok) {
    console.warn('Stripe payment could not be safely matched to a booking', {
      sessionId: session.id,
      stripeReference,
      existingPaymentId: existingPayment?.id ?? null,
      reason: bookingResolution.reason,
    });
    return { matched: false, reason: bookingResolution.reason };
  }

  const booking = bookingResolution.booking;
  if ((existingPayment?.stripe_checkout_session_id && existingPayment.stripe_checkout_session_id !== session.id)
    || (existingPayment?.stripe_payment_intent_id && existingPayment.stripe_payment_intent_id !== paymentIntentId)) {
    return { matched: false, reason: 'payment_relationship_conflict' };
  }
  // The frozen payment row is the amount authority on replay (including refunds).
  // A new public intake must never be confirmed by an old generic payment link.
  const expectedAmountUsd = existingPayment?.amount_usd ?? booking.online_due_usd;
  const expectedCents = Math.round(Number(expectedAmountUsd) * 100);
  if (!Number.isSafeInteger(session.amount_total) || !session.amount_total || session.amount_total <= 0
    || !Number.isSafeInteger(expectedCents) || expectedCents <= 0 || session.amount_total !== expectedCents) {
    return { matched: false, reason: 'payment_amount_conflict' };
  }
  const issuance = existingPayment?.raw_event?.checkout_issuance;
  // A ledger-bound Session remains money evidence after commercial edits.
  // Only frozen issuance (never mutable booking terms) validates its count/date.
  const frozenTerms = issuance?.expected ?? (existingPayment ? null : booking);
  if ([session.client_reference_id, session.metadata?.booking_reference, session.metadata?.public_reference]
    .some(value => value != null && value !== booking.public_reference)
    || (session.metadata?.booking_id && session.metadata.booking_id !== booking.id)
    || (session.metadata?.customer_id && session.metadata.customer_id !== booking.customer_id)
    || (session.metadata?.guest_count && frozenTerms && session.metadata.guest_count !== String(frozenTerms.guest_count))
    || (session.metadata?.tour_date && frozenTerms && session.metadata.tour_date !== frozenTerms.tour_date)) {
    return { matched: false, reason: 'payment_metadata_conflict' };
  }
  const reference = booking.public_reference;
  const existingRawEvent = typeof existingPayment?.raw_event === 'object' && existingPayment.raw_event
    ? existingPayment.raw_event as Record<string, unknown>
    : {};
  const decision = paymentProcessingDecision({
    status: existingPayment?.status ?? null,
    amountUsd: amountToRecord,
    processingComplete: existingRawEvent.processing_complete === true,
  });

  if (!decision.process) {
    const matched = decision.reason !== 'invalid_payment_amount';
    if (decision.reason === 'payment_already_recorded') {
      // Recovery path: the payment and its ordinary side effects are already
      // complete, but a legacy terminal GA4 skip (or a missed GA4 send) must
      // still converge on a later Stripe replay. Idempotent per session; a
      // retryable GA4 failure throws so recovery is never lost. Refunded
      // payments stay skipped on purpose: a refunded purchase must not emit a
      // fresh marketing conversion.
      await ensureGa4PaymentEvent(supabase, {
        booking,
        sessionId: session.id,
        amountUsd: amountToRecord,
        currency,
        recoveryOnly: true,
      });
    }
    console.info('Ignoring Stripe checkout payment without side effects', {
      sessionId: session.id,
      reference,
      paymentId: existingPayment?.id ?? null,
      reason: decision.reason,
    });
    return { matched, reason: decision.reason, reference, bookingId: booking.id, alreadyRecorded: matched };
  }

  const now = new Date().toISOString();

  const checkoutEvent = {
    checkout_session_id: session.id,
    payment_intent_id: paymentIntentId || null,
    event_source: 'checkout.session.completed',
    amount_total: session.amount_total,
    currency: session.currency,
  };
  let processingToken = crypto.randomUUID();
  const paymentPayload = {
    provider: 'stripe',
    stripe_checkout_session_id: session.id,
    stripe_payment_intent_id: paymentIntentId || null,
    amount_usd: amountToRecord,
    status: 'paid',
    paid_at: now,
    raw_event: {
      ...existingRawEvent,
      latest_checkout_event: checkoutEvent,
      processing_token: processingToken,
      processing_claimed_at: now,
      processing_complete: false,
    },
  };

  let paymentId = existingPayment?.id ?? '';
  if (decision.needsClaim) {
    const claim = await claimPaymentAsPaid({
      existingPayment,
      updateExisting: async (payment: { id: string; status: string }) => {
        const { data, error } = await supabase
          .from('payments')
          .update(paymentPayload)
          .eq('id', payment.id)
          .eq('status', payment.status)
          .select('id')
          .maybeSingle();
        if (error) throw new Error(`Payment claim update failed: ${error.message}`);
        return data;
      },
      insertNew: async () => {
        const { data, error } = await supabase
          .from('payments')
          .insert({ ...paymentPayload, booking_id: booking.id })
          .select('id')
          .single();
        if (error) {
          const claimError = new Error(`Payment claim insert failed: ${error.message}`) as Error & { code?: string };
          claimError.code = error.code;
          throw claimError;
        }
        return data;
      },
    });

    if (!claim.claimed) {
      throw new Error('Payment processing was claimed concurrently; retry the Stripe event.');
    }
    paymentId = claim.paymentId;
  } else {
    if (!paymentId) throw new Error('Recoverable payment is missing its database id.');
    const lease = await claimPaymentProcessingLease(paymentId);
    if (lease.complete) {
      return {
        matched: true,
        reason: 'payment_already_recorded',
        reference,
        bookingId: booking.id,
        paymentIntentId,
        alreadyRecorded: true,
      };
    }
    if (!lease.acquired || !lease.token) {
      throw new Error('Payment recovery lease is active; retry the Stripe event.');
    }
    processingToken = lease.token;
  }

  await reconcileBookingPaymentBalance({ paymentId, bookingId: booking.id });
  let currentBookingStatus = await readBookingStatus(booking.id);
  const alreadyRecorded = decision.reason === 'recover_incomplete_processing';
  let bookingConfirmationToken: string | null = null;

  const finishCancelledPayment = async () => {
    const { data: existingCancelledEvent, error: cancelledEventLookupError } = await supabase
      .from('booking_events')
      .select('id')
      .eq('booking_id', booking.id)
      .eq('title', 'Stripe payment received for cancelled booking')
      .contains('metadata', { stripe_checkout_session_id: session.id })
      .limit(1)
      .maybeSingle();
    if (cancelledEventLookupError) throw new Error(`Cancelled payment event lookup failed: ${cancelledEventLookupError.message}`);
    if (!existingCancelledEvent) {
      const { error: cancelledEventError } = await supabase.from('booking_events').insert({
        booking_id: booking.id,
        event_type: 'payment',
        direction: 'system',
        title: 'Stripe payment received for cancelled booking',
        body: `Stripe checkout session ${session.id} paid ${amountToRecord} ${currency}. Booking remains cancelled and requires operator review; confirmation processing stopped when cancellation was observed.`,
        metadata: { stripe_checkout_session_id: session.id, stripe_payment_intent_id: paymentIntentId },
        created_by: 'stripe-webhook',
      });
      if (cancelledEventError) throw new Error(`Cancelled payment event insert failed: ${cancelledEventError.message}`);
    }
    if (bookingConfirmationToken) {
      await releaseBookingConfirmationLease(booking.id, bookingConfirmationToken);
      bookingConfirmationToken = null;
    }
    await reconcileBookingPaymentBalance({ paymentId, bookingId: booking.id, processingToken });
    return {
      matched: true,
      reason: 'cancelled_booking_requires_review',
      reference,
      bookingId: booking.id,
      paymentIntentId,
      alreadyRecorded,
    };
  };

  if (currentBookingStatus === 'cancelled') return finishCancelledPayment();

  const inventoryAllowed = canAutomaticallyConfirmBooking(booking.tour_date, booking.guest_count)
    && !(session.metadata?.guest_count && session.metadata.guest_count !== String(booking.guest_count));
  const confirmationToken = crypto.randomUUID();
  const confirmation = inventoryAllowed ? await transitionBookingAfterPaymentClaim(booking.id, now, session.id, {
    customer_id: booking.customer_id, tour_date: booking.tour_date, guest_count: booking.guest_count,
    online_due_usd: booking.online_due_usd,
  }, confirmationToken) : {allowed:false};
  const automaticConfirmationAllowed = confirmation.allowed === true;
  if (automaticConfirmationAllowed) bookingConfirmationToken = confirmationToken;
  const finishManualReview = async () => {
    const { data: existingManualReviewEvent, error: manualReviewLookupError } = await supabase
      .from('booking_events')
      .select('id')
      .eq('booking_id', booking.id)
      .eq('title', 'Stripe payment received — manual confirmation required')
      .contains('metadata', { stripe_checkout_session_id: session.id })
      .limit(1)
      .maybeSingle();
    if (manualReviewLookupError) throw new Error(`Manual-review payment event lookup failed: ${manualReviewLookupError.message}`);

    if (!existingManualReviewEvent) {
      const { error: manualReviewEventError } = await supabase.from('booking_events').insert({
        booking_id: booking.id,
        event_type: 'payment',
        direction: 'system',
        title: 'Stripe payment received — manual confirmation required',
        body: `Stripe checkout session ${session.id} paid ${amountToRecord} ${currency}. Ordinary confirmation is not authorized by current funding, commercial terms, issuance evidence, or dispatch ownership. Payment/refund history is retained; an operator must review the booking before further confirmation.`,
        metadata: {
          stripe_checkout_session_id: session.id,
          stripe_payment_intent_id: paymentIntentId,
          automatic_confirmation_allowed: false,
        },
        created_by: 'stripe-webhook',
      });
      if (manualReviewEventError) throw new Error(`Manual-review payment event insert failed: ${manualReviewEventError.message}`);
    }

    if (bookingConfirmationToken) {
      await releaseBookingConfirmationLease(booking.id, bookingConfirmationToken);
      bookingConfirmationToken = null;
    }
    await reconcileBookingPaymentBalance({ paymentId, bookingId: booking.id, processingToken });
    return {
      matched: true,
      reason: 'manual_confirmation_required',
      reference,
      bookingId: booking.id,
      paymentIntentId,
      alreadyRecorded,
    };
  }

  if (!automaticConfirmationAllowed) return finishManualReview();

  // Dispatch authorization is a durable, booking-locked boundary, not the
  // earlier confirmation lease. Each destination is authorized separately.
  const authorizeDispatch = async (destination: string) => {
    const { data: livePayment, error: paymentError } = await supabase.from('payments')
      .select('status, raw_event').eq('id', paymentId).single();
    if (paymentError) throw new Error(`Dispatch payment read failed: ${paymentError.message}`);
    if (livePayment?.status !== 'paid' || Number(livePayment.raw_event?.cumulative_refunded_usd ?? 0) > 0) return false;
    const { data, error } = await supabase.rpc('authorize_payment_dispatch_v3', {
      p_booking_id: booking.id, p_session_id: session.id, p_token: bookingConfirmationToken, p_destination: destination,
    });
    if (error) throw new Error(`Payment dispatch authorization failed: ${error.message}`);
    if (data !== true) return false;
    // Narrow the unavoidable DB/network gap: a refund observed after dispatch
    // reservation still suppresses transport. Once transport starts we cannot
    // retract acceptance; the journal preserves any subsequent refund race.
    const { data: fence, error: fenceError } = await supabase.from('bookings')
      .select('payment_confirmation_token, status').eq('id', booking.id).single();
    if (fenceError) throw new Error(`Dispatch fence read failed: ${fenceError.message}`);
    if (fence?.payment_confirmation_token !== bookingConfirmationToken || fence?.status !== 'confirmed') {
      const { error: suppressError } = await supabase.from('payment_confirmation_dispatch')
        .update({ status: 'suppressed' }).eq('booking_id', booking.id).eq('session_id', session.id).eq('destination', destination);
      if (suppressError) throw new Error(`Dispatch suppression write failed: ${suppressError.message}`);
      return false;
    }
    return true;
  };

  const recordDispatch = async (destination: string, result: { sent: boolean; id?: string }) => {
    const { error } = await supabase.from('payment_confirmation_dispatch').update({
      status: result.sent ? 'accepted' : 'failed', provider_message_id: result.id ?? null,
    }).eq('booking_id', booking.id).eq('session_id', session.id).eq('destination', destination).eq('token', bookingConfirmationToken);
    if (error) throw new Error(`Payment dispatch outcome write failed: ${error.message}`);
  };

  currentBookingStatus = await readBookingStatus(booking.id);
  if (currentBookingStatus === 'cancelled') return finishCancelledPayment();

  {
    const { data: existingPaymentEvent, error: existingPaymentEventError } = await supabase
      .from('booking_events')
      .select('id')
      .eq('booking_id', booking.id)
      .eq('title', 'Stripe payment confirmed')
      .contains('metadata', { stripe_checkout_session_id: session.id })
      .limit(1)
      .maybeSingle();

    if (existingPaymentEventError) {
      throw new Error(`Payment event lookup failed: ${existingPaymentEventError.message}`);
    }

    const paymentEventWrite = existingPaymentEvent
      ? { error: null }
      : await supabase.from('booking_events').insert({
      booking_id: booking.id,
      event_type: 'payment',
      direction: 'system',
      title: 'Stripe payment confirmed',
      body: [
        `Stripe checkout session ${session.id} completed.`,
        `Payment intent: ${paymentIntentId ?? 'unknown'}.`,
        `Amount recorded: ${amountToRecord} ${currency}.`,
      ].join('\n'),
      metadata: {
        stripe_checkout_session_id: session.id,
        stripe_payment_intent_id: paymentIntentId,
      },
      created_by: 'stripe-webhook',
    });

    if (paymentEventWrite.error) {
      throw new Error(`Payment event insert failed: ${paymentEventWrite.error.message}`);
    }

    // Durable bounded GA4 conversion: idempotent per session, retryable
    // failures throw so Stripe redelivers and analytics recovery works even
    // when this replay reaches payment_already_recorded.
    await ensureGa4PaymentEvent(supabase, {
      booking,
      sessionId: session.id,
      amountUsd: amountToRecord,
      currency,
    });

    if (!bookingConfirmationToken) {
      currentBookingStatus = await readBookingStatus(booking.id);
      if (currentBookingStatus === 'cancelled') return finishCancelledPayment();
      throw new Error('Booking confirmation email lease is active; retry the Stripe event.');
    }

    try {
      const customer = Array.isArray(booking.customer) ? booking.customer[0] : booking.customer;
    const customerEmail = typeof customer?.email === 'string' ? customer.email : '';
    const firstName = typeof customer?.first_name === 'string' ? customer.first_name : 'there';
    const lastName = typeof customer?.last_name === 'string' ? customer.last_name : '';
    const customerName = `${firstName === 'there' ? '' : firstName} ${lastName}`.trim() || customerEmail || booking.public_reference;
    const internalRecipients = getInternalEmailRecipients();

    currentBookingStatus = await readBookingStatus(booking.id);
    if (currentBookingStatus === 'cancelled') return finishCancelledPayment();

    if (customerEmail) {
      const { data: existingCustomerEmail, error: existingCustomerEmailError } = await supabase
        .from('email_events')
        .select('id')
        .eq('booking_id', booking.id)
        .eq('template_key', 'payment_confirmed')
        .eq('status', 'sent')
        .limit(1)
        .maybeSingle();
      if (existingCustomerEmailError) throw new Error(`Customer email lookup failed: ${existingCustomerEmailError.message}`);

      if (!existingCustomerEmail) {
        currentBookingStatus = await readBookingStatus(booking.id);
        if (currentBookingStatus === 'cancelled') return finishCancelledPayment();
        const confirmationEmail = paymentConfirmedCustomerEmail({
          reference: booking.public_reference,
          firstName,
          tourDate: booking.tour_date || 'TBC',
          amountUsd: amountToRecord,
        });
        if (!await authorizeDispatch('customer')) return finishManualReview();
        const emailResult = await sendEmail({
          to: customerEmail,
          replyTo: getInternalEmailRecipients()[0],
          idempotencyKey: `stripe-${session.id}-customer-payment`,
          ...confirmationEmail,
        });

        await recordDispatch('customer', emailResult);
        const { data: customerBookingEvent, error: customerBookingEventLookupError } = await supabase
          .from('booking_events')
          .select('id')
          .eq('booking_id', booking.id)
          .in('title', ['Payment confirmation email sent', 'Payment confirmation email failed'])
          .contains('metadata', { stripe_checkout_session_id: session.id })
          .limit(1)
          .maybeSingle();
        if (customerBookingEventLookupError) throw new Error(`Customer booking-event lookup failed: ${customerBookingEventLookupError.message}`);
        if (!customerBookingEvent) {
          const { error: customerBookingEventError } = await supabase.from('booking_events').insert({
            booking_id: booking.id,
            event_type: emailResult.sent ? 'email' : 'system',
            direction: 'outbound',
            title: emailResult.sent ? 'Payment confirmation email sent' : 'Payment confirmation email failed',
            body: emailResult.sent ? `Resend email id: ${emailResult.id ?? 'unknown'}` : emailResult.error,
            metadata: { stripe_checkout_session_id: session.id },
            created_by: 'resend',
          });
          if (customerBookingEventError) throw new Error(`Customer email event record failed: ${customerBookingEventError.message}`);
        }

        const { error: customerEmailEventError } = await supabase.from('email_events').insert({
          booking_id: booking.id,
          customer_id: booking.customer_id ?? null,
          template_key: 'payment_confirmed',
          to_email: customerEmail,
          subject: confirmationEmail.subject,
          body_snapshot: confirmationEmail.text,
          provider_message_id: emailResult.id ?? null,
          sent_by: 'stripe-webhook',
          status: emailResult.sent ? 'sent' : 'failed',
          raw_response: { ...emailResult, stripe_checkout_session_id: session.id },
        });
        if (customerEmailEventError) throw new Error(`Customer email audit insert failed: ${customerEmailEventError.message}`);
        if (!emailResult.sent) throw new Error(`Customer payment email failed: ${emailResult.error ?? 'unknown error'}`);
      }
    }

    currentBookingStatus = await readBookingStatus(booking.id);
    if (currentBookingStatus === 'cancelled') return finishCancelledPayment();

    if (internalRecipients.length) {
      const { data: existingInternalEmail, error: existingInternalEmailError } = await supabase
        .from('email_events')
        .select('id')
        .eq('booking_id', booking.id)
        .eq('template_key', 'internal_payment_received')
        .eq('status', 'sent')
        .limit(1)
        .maybeSingle();
      if (existingInternalEmailError) throw new Error(`Internal email lookup failed: ${existingInternalEmailError.message}`);

      if (!existingInternalEmail) {
        currentBookingStatus = await readBookingStatus(booking.id);
        if (currentBookingStatus === 'cancelled') return finishCancelledPayment();
        const internalPaymentEmail = paymentReceivedInternalEmail({
          reference: booking.public_reference,
          firstName,
          customerName,
          customerEmail: customerEmail || 'not provided',
          tourDate: booking.tour_date || 'TBC',
          amountUsd: amountToRecord,
          stripeReference: paymentIntentId ?? session.id,
        });
        if (!await authorizeDispatch('internal')) return finishManualReview();
        const internalEmailResult = await sendEmail({
          to: internalRecipients,
          replyTo: customerEmail || internalRecipients[0],
          idempotencyKey: `stripe-${session.id}-internal-payment`,
          ...internalPaymentEmail,
        });

        await recordDispatch('internal', internalEmailResult);
        const { data: internalBookingEvent, error: internalBookingEventLookupError } = await supabase
          .from('booking_events')
          .select('id')
          .eq('booking_id', booking.id)
          .in('title', ['Internal payment notification email sent', 'Internal payment notification email failed'])
          .contains('metadata', { stripe_checkout_session_id: session.id })
          .limit(1)
          .maybeSingle();
        if (internalBookingEventLookupError) throw new Error(`Internal booking-event lookup failed: ${internalBookingEventLookupError.message}`);
        if (!internalBookingEvent) {
          const { error: internalBookingEventError } = await supabase.from('booking_events').insert({
            booking_id: booking.id,
            event_type: internalEmailResult.sent ? 'email' : 'system',
            direction: 'outbound',
            title: internalEmailResult.sent ? 'Internal payment notification email sent' : 'Internal payment notification email failed',
            body: internalEmailResult.sent ? `Resend email id: ${internalEmailResult.id ?? 'unknown'}` : internalEmailResult.error,
            metadata: { stripe_checkout_session_id: session.id },
            created_by: 'resend',
          });
          if (internalBookingEventError) throw new Error(`Internal email event record failed: ${internalBookingEventError.message}`);
        }

        const { error: internalEmailEventError } = await supabase.from('email_events').insert({
          booking_id: booking.id,
          customer_id: booking.customer_id ?? null,
          template_key: 'internal_payment_received',
          to_email: internalRecipients.join(', '),
          subject: internalPaymentEmail.subject,
          body_snapshot: internalPaymentEmail.text,
          provider_message_id: internalEmailResult.id ?? null,
          sent_by: 'stripe-webhook',
          status: internalEmailResult.sent ? 'sent' : 'failed',
          raw_response: { ...internalEmailResult, stripe_checkout_session_id: session.id },
        });
        if (internalEmailEventError) throw new Error(`Internal email audit insert failed: ${internalEmailEventError.message}`);
        if (!internalEmailResult.sent) throw new Error(`Internal payment email failed: ${internalEmailResult.error ?? 'unknown error'}`);
      }
    }
    } finally {
      if (bookingConfirmationToken) {
        await releaseBookingConfirmationLease(booking.id, bookingConfirmationToken);
        bookingConfirmationToken = null;
      }
    }
    await reconcileBookingPaymentBalance({ paymentId, bookingId: booking.id, processingToken });
  }

  return { matched: true, reference, bookingId: booking.id, amount: amountToRecord, paymentIntentId, alreadyRecorded };
}

async function handleStripeRefund(event: Stripe.Event) {
  if (!isSupabaseAdminConfigured) {
    throw new Error('Supabase admin is not configured.');
  }

  const object = event.data.object;
  const isCharge = object.object === 'charge';
  const isRefund = object.object === 'refund';

  if (!isCharge && !isRefund) {
    return { matched: false, reason: 'unsupported_refund_object' };
  }

  const charge = isCharge ? object as Stripe.Charge : null;
  const refund = isRefund ? object as Stripe.Refund : null;
  if (refund && !shouldProcessRefundStatus(refund.status)) {
    return { matched: true, ignored: true, reason: `refund_${refund.status ?? 'unknown'}` };
  }
  const paymentIntentId = typeof (charge?.payment_intent ?? refund?.payment_intent) === 'string'
    ? String(charge?.payment_intent ?? refund?.payment_intent)
    : null;

  if (!paymentIntentId) {
    console.warn('Stripe refund event has no payment intent', { eventId: event.id, eventType: event.type });
    return { matched: false, reason: 'missing_payment_intent' };
  }

  const supabase = createSupabaseAdminClient();
  const occurredAt = eventTimestamp(event);
  const individualRefundUsd = isRefund ? usdFromCents(refund?.amount) : 0;
  const chargeCumulativeRefundedUsd = isCharge ? usdFromCents(charge?.amount_refunded) : 0;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const { data: payment, error: paymentError } = await supabase
      .from('payments')
      .select('id, booking_id, amount_usd, status, raw_event, refunded_at')
      .eq('stripe_payment_intent_id', paymentIntentId)
      .maybeSingle();

    if (paymentError) throw new Error(`Refund payment lookup failed: ${paymentError.message}`);
    if (!payment) {
      throw new Error(`Refund payment ${paymentIntentId} is not available yet; retry the Stripe event.`);
    }

    const originalAmountUsd = Number(payment.amount_usd ?? 0);
    const previousRawEvent = typeof payment.raw_event === 'object' && payment.raw_event
      ? payment.raw_event as Record<string, unknown>
      : {};
    const legacyCumulativeUsd = payment.status === 'refunded'
      ? originalAmountUsd
      : Number((previousRawEvent.latest_refund_event as { refunded_usd?: unknown } | undefined)?.refunded_usd ?? 0) || 0;
    const refundState = calculateRefundState({
      originalAmountUsd,
      previousRawEvent: {
        ...previousRawEvent,
        cumulative_refunded_usd: Math.max(Number(previousRawEvent.cumulative_refunded_usd ?? 0) || 0, legacyCumulativeUsd),
      },
      refundId: refund?.id ?? null,
      individualRefundUsd,
      chargeCumulativeRefundedUsd,
    });
    const previousRefundVersionMs = payment.refunded_at ? Date.parse(payment.refunded_at) : 0;
    const refundVersion = new Date(Math.max(Date.now(), previousRefundVersionMs + 1)).toISOString();
    const rawEvent = {
      ...refundState.rawEvent,
      latest_refund_event: {
        event_id: event.id,
        event_type: event.type,
        payment_intent_id: paymentIntentId,
        charge_id: charge?.id ?? refund?.charge ?? null,
        refund_id: refund?.id ?? null,
        individual_refunded_usd: individualRefundUsd,
        cumulative_refunded_usd: refundState.cumulativeRefundedUsd,
        original_amount_usd: originalAmountUsd,
        occurred_at: occurredAt,
      },
    };

    const existingProcessingToken = typeof previousRawEvent.processing_token === 'string'
      ? previousRawEvent.processing_token
      : '';
    let updatePayment = supabase
      .from('payments')
      .update({ status: refundState.status, refunded_at: refundVersion, raw_event: rawEvent })
      .eq('id', payment.id)
      .eq('status', payment.status);
    updatePayment = payment.refunded_at
      ? updatePayment.eq('refunded_at', payment.refunded_at)
      : updatePayment.is('refunded_at', null);
    updatePayment = existingProcessingToken
      ? updatePayment.eq('raw_event->>processing_token', existingProcessingToken)
      : updatePayment.is('raw_event->>processing_token', null);
    const { data: updatedPayment, error: updatePaymentError } = await updatePayment.select('id').maybeSingle();
    if (updatePaymentError) throw new Error(`Refund payment update failed: ${updatePaymentError.message}`);
    if (!updatedPayment) continue;

    const reconciliation = await reconcileBookingPaymentBalance({
      paymentId: payment.id,
      bookingId: payment.booking_id,
    });

    const { data: existingRefundEvent, error: existingRefundEventError } = await supabase
      .from('booking_events')
      .select('id')
      .eq('booking_id', payment.booking_id)
      .contains('metadata', { event_id: event.id })
      .limit(1)
      .maybeSingle();
    if (existingRefundEventError) throw new Error(`Refund event lookup failed: ${existingRefundEventError.message}`);

    if (!existingRefundEvent) {
      const { error: eventError } = await supabase.from('booking_events').insert({
        booking_id: payment.booking_id,
        event_type: 'payment',
        direction: 'system',
        title: refundState.status === 'refunded' ? 'Stripe payment refunded' : 'Stripe payment partially refunded',
        body: [
          `Stripe refund event ${event.id} received.`,
          `Payment intent: ${paymentIntentId}.`,
          `Cumulative refunded amount: ${refundState.cumulativeRefundedUsd} USD.`,
          'Booking status was not automatically changed; review cancellation/transfer status manually if needed.',
        ].join('\n'),
        metadata: {
          event_id: event.id,
          event_type: event.type,
          payment_intent_id: paymentIntentId,
          cumulative_refunded_usd: refundState.cumulativeRefundedUsd,
          remaining_paid_usd: refundState.remainingPaidUsd,
        },
        created_by: 'stripe-webhook',
        occurred_at: occurredAt,
      });
      if (eventError) throw new Error(`Refund event insert failed: ${eventError.message}`);
    }

    return {
      matched: true,
      paymentIntentId,
      cumulativeRefundedUsd: refundState.cumulativeRefundedUsd,
      remainingPaidUsd: reconciliation.onlinePaidUsd,
      status: reconciliation.status,
      changed: refundState.changed,
    };
  }

  throw new Error('Refund payment update conflicted repeatedly; retry the Stripe event.');
}

export async function POST(request: Request) {
  if (!stripeWebhookSecret) {
    return jsonError('Stripe webhook is not configured.', 503);
  }

  const signature = request.headers.get('stripe-signature');

  if (!signature) {
    return jsonError('Missing Stripe signature.', 400);
  }

  let event: Stripe.Event;

  try {
    const body = await request.text();
    event = stripe.webhooks.constructEvent(body, signature, stripeWebhookSecret);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid Stripe webhook payload.';
    return jsonError(`Webhook signature verification failed: ${message}`, 400);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        const result = await handleCheckoutSessionPaid(event.data.object as Stripe.Checkout.Session);
        return NextResponse.json({ ok: true, received: true, type: event.type, result });
      }
      case 'charge.refunded':
      case 'refund.created':
      case 'refund.updated': {
        const result = await handleStripeRefund(event);
        return NextResponse.json({ ok: true, received: true, type: event.type, result });
      }
      default:
        return NextResponse.json({ ok: true, received: true, ignored: true, type: event.type });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Stripe webhook handling failed.';
    console.error('Stripe webhook handling failed', { eventId: event.id, eventType: event.type, error: message });
    return jsonError(message, 500);
  }
}
