import Stripe from 'stripe';
import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { arrivalCoordinationCustomerEmail, finalChecklistCustomerEmail, getInternalEmailRecipients, insuranceReminderCustomerEmail, paymentConfirmedCustomerEmail, preparationCustomerEmail, sendEmail } from '@/lib/email';
import { getLifecycleEmailSchedule } from '@/lib/lifecycle-email-schedule.mjs';
import { getDryRun, reconcileStripeProviderEvidence, selectPacedLifecycleCandidate } from '@/lib/public-lifecycle.mjs';
import { collectStripeLifecycleEvidence } from '@/lib/stripe-lifecycle-evidence.mjs';
import { isSupabaseAdminConfigured } from '@/lib/ops-config';
import { createSupabaseAdminClient } from '@/lib/supabase-admin';

const LIFECYCLE_KEYS = ['payment_confirmed', 'preparation_packing', 'insurance_final_check', 'arrival_coordination', 'final_checklist'];
type TemplateKey = typeof LIFECYCLE_KEYS[number];
type BookingRow = { id:string; public_reference:string; customer_id:string|null; tour_date:string|null; status:string; online_due_usd:number|null; online_paid_usd:number|null; family_cash_due_usd:number|null; customer?: {first_name?:string|null;email?:string|null}|{first_name?:string|null;email?:string|null}[]|null };
type DispatchClaim = { should_send:boolean; event_id?:string; idempotency_key?:string; reason?:string };

export const runtime = 'nodejs';
export const maxDuration = 60;

function isAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  const supplied = Buffer.from(request.headers.get('authorization') || '');
  const expected = Buffer.from(`Bearer ${secret || ''}`);
  return Boolean(secret) && supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
function customer(booking: BookingRow) { const row = Array.isArray(booking.customer) ? booking.customer[0] : booking.customer; return { firstName: row?.first_name || 'there', email: row?.email || '' }; }
function message(template: TemplateKey, booking: BookingRow) {
  const input = { reference: booking.public_reference, firstName: customer(booking).firstName, tourDate: booking.tour_date || 'TBC', familyCashDueUsd: booking.family_cash_due_usd };
  if (template === 'payment_confirmed') return paymentConfirmedCustomerEmail({ ...input, amountUsd: booking.online_paid_usd || 0 });
  if (template === 'preparation_packing') return preparationCustomerEmail(input);
  if (template === 'insurance_final_check') return insuranceReminderCustomerEmail(input);
  if (template === 'arrival_coordination') return arrivalCoordinationCustomerEmail(input);
  return finalChecklistCustomerEmail(input);
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ ok:false, error:'Unauthorized' }, { status:401 });
  if (!isSupabaseAdminConfigured) return NextResponse.json({ ok:false, error:'Supabase admin is not configured' }, { status:503 });
  const dryRun = getDryRun(new URL(request.url));
  const headers = { 'Cache-Control':'no-store' };
  // Sender is default-deny: a dry-run is reconciliation-only and makes no claim.
  if (!dryRun && process.env.PUBLIC_LIFECYCLE_SEND_ENABLED !== 'true') {
    return NextResponse.json({ ok:true, dry_run:false, disabled:true, reason:'public_lifecycle_send_disabled' }, { headers });
  }
  // Narrow targeted rollout: when targeting is configured — persistent env or
  // per-request query params on this authenticated endpoint — ONLY the exact
  // booking (reference AND id) may dispatch, and ONLY the named template. An
  // incomplete configuration fails closed.
  const url = new URL(request.url);
  const targetedReference = (process.env.PUBLIC_LIFECYCLE_TARGETED_REFERENCE || url.searchParams.get('target_reference') || '').trim();
  const targetedBookingId = (process.env.PUBLIC_LIFECYCLE_TARGETED_BOOKING_ID || url.searchParams.get('target_booking_id') || '').trim();
  const targetedTemplate = (process.env.PUBLIC_LIFECYCLE_TARGETED_TEMPLATE || url.searchParams.get('target_template') || '').trim();
  const targeted = Boolean(targetedReference) || Boolean(targetedBookingId) || Boolean(targetedTemplate);
  if (targeted && (!targetedReference || !targetedBookingId || !targetedTemplate)) {
    return NextResponse.json({ ok:false, error:'targeted_configuration_incomplete' }, { status:400, headers });
  }
  try {
    const db = createSupabaseAdminClient();
    let bookingQuery = db.from('bookings').select('id, public_reference, customer_id, tour_date, status, online_due_usd, online_paid_usd, family_cash_due_usd, customer:customers(first_name, email)').in('status',['awaiting_payment','confirmed','prep_sent','ready_for_departure']);
    if (targetedReference) bookingQuery = bookingQuery.eq('public_reference', targetedReference);
    const { data: bookings, error } = await bookingQuery.limit(200);
    if (error) throw error;
    const { data: approvedBindings, error: bindingsError } = await db.from('approved_payment_bindings').select('booking_id, provider_object_id').eq('provider','stripe');
    if (bindingsError) throw bindingsError;
    const rows = (bookings || []) as BookingRow[];
    if (!process.env.STRIPE_SECRET_KEY) throw new Error('stripe_unavailable');
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { maxNetworkRetries: 0, timeout: 5000 });
    const provider = await collectStripeLifecycleEvidence({ stripe, pageBudget: 90 });
    const reconciliation = reconcileStripeProviderEvidence({ bookings:rows.map(row=>({id:row.id,reference:row.public_reference,amount_cents:Number(row.online_due_usd)*100,currency:'usd',customer_email:customer(row).email})), evidence:provider.evidence, approvedBindings:(approvedBindings||[]) as Array<{booking_id:string;provider_object_id:string}>, scanComplete:provider.scanComplete });
    const verified = new Set((reconciliation as Array<{ reference:string; status:string }>).filter((row:{reference:string;status:string})=>row.status==='verified_paid').map((row:{reference:string;status:string})=>row.reference));
    const { data: events, error: eventsError } = await db.from('email_events').select('booking_id, template_key, status').in('booking_id',rows.map(row=>row.id)).in('template_key',LIFECYCLE_KEYS);
    if (eventsError) throw eventsError;
    const existing = new Map<string, Set<string>>();
    // Queued rows are deliberately not treated as sent: the durable dispatcher
    // will return their unresolved state and block every subsequent template.
    for (const event of events || []) if (event.booking_id && ['sent','delivered'].includes(event.status)) { const set=existing.get(event.booking_id)||new Set<string>(); set.add(event.template_key); existing.set(event.booking_id,set); }
    const results: Array<Record<string,unknown>> = [];
    for (const booking of rows) {
      const schedule = getLifecycleEmailSchedule({ now:new Date(), tourDate:booking.tour_date });
      const template = selectPacedLifecycleCandidate({ verifiedStripe:verified.has(booking.public_reference), daysUntilDeparture:schedule.daysUntilDeparture, sentTemplates:existing.get(booking.id)||new Set() }) as TemplateKey|null;
      if (!template) {
        const reconciliationResult = (reconciliation as Array<Record<string, unknown>>).find(row => row.reference===booking.public_reference);
        results.push(reconciliationResult || { reference:booking.public_reference, status:'scan_incomplete_unknown' });
        continue;
      }
      // Targeted rollout guard: only the exact approved booking may dispatch,
      // and only the explicitly approved template for it.
      if (targeted && !(booking.public_reference===targetedReference && booking.id===targetedBookingId && template===targetedTemplate)) {
        results.push({ reference:booking.public_reference, status:'targeted_guard_blocked', template });
        continue;
      }
      if (dryRun) { results.push({ reference:booking.public_reference, status:'candidate', template, days_until_departure:schedule.daysUntilDeparture }); continue; }
      const recipient = customer(booking).email;
      if (!recipient || !booking.customer_id) { results.push({ reference:booking.public_reference, status:'missing_customer_email', template }); continue; }
      const email = message(template, booking);
      const token = crypto.randomUUID();
      const { data, error: claimError } = await db.rpc('claim_lifecycle_email_dispatch', {
        p_booking_id:booking.id, p_customer_id:booking.customer_id, p_template_key:template,
        p_to_email:recipient, p_subject:email.subject, p_body_snapshot:email.text,
        p_sent_by:'drip-cron', p_claim_token:token,
      });
      if (claimError) throw new Error(`lifecycle claim failed: ${claimError.message}`);
      const claim = data as DispatchClaim | null;
      if (!claim?.should_send || !claim.event_id || !claim.idempotency_key) { results.push({ reference:booking.public_reference, status:claim?.reason || 'already_claimed', template }); continue; }
      const { data: attempted, error: attemptError } = await db.rpc('mark_lifecycle_email_provider_attempted', { p_booking_id:booking.id, p_event_id:claim.event_id, p_claim_token:token });
      if (attemptError || attempted !== true) throw new Error(`lifecycle provider-attempt persistence failed: ${attemptError?.message || 'claim lost'}`);
      let result: Awaited<ReturnType<typeof sendEmail>>;
      try {
        result = await sendEmail({ to:recipient, replyTo:getInternalEmailRecipients()[0], ...email, idempotencyKey:`8l-lifecycle-${claim.event_id}` });
      } catch (sendError) {
        // Transport exception is ambiguous: retain queued/reconciliation state;
        // it must never become an automatic resend.
        const { data: completed, error: completeError } = await db.rpc('complete_lifecycle_email_dispatch', { p_booking_id:booking.id, p_event_id:claim.event_id, p_claim_token:token, p_sent:false, p_definite_failure:false, p_provider_message_id:null, p_raw_response:{ error:sendError instanceof Error ? sendError.message : 'provider_transport_exception' } });
        if (completeError || completed !== true) throw new Error(`lifecycle ambiguous completion persistence failed: ${completeError?.message || 'claim lost'}`);
        results.push({ reference:booking.public_reference, status:'reconciliation_required', template });
        continue;
      }
      const { data: completed, error: completeError } = await db.rpc('complete_lifecycle_email_dispatch', { p_booking_id:booking.id, p_event_id:claim.event_id, p_claim_token:token, p_sent:result.sent, p_definite_failure:!result.sent, p_provider_message_id:result.id || null, p_raw_response:result });
      if (completeError || completed !== true) throw new Error(`lifecycle post-send persistence failed: ${completeError?.message || 'claim lost'}`);
      if (result.sent) {
        const { error: timelineError } = await db.from('booking_events').insert({ booking_id:booking.id,event_type:'email',direction:'outbound',title:`Lifecycle email sent: ${template}`,body:`Resend email id: ${result.id || 'unknown'}`,created_by:'drip-cron' });
        // The canonical sent row remains durable; surface this failure rather
        // than making an accepted provider send eligible for a duplicate.
        if (timelineError) throw new Error(`lifecycle sent but timeline persistence failed: ${timelineError.message}`);
      }
      results.push({ reference:booking.public_reference, status:result.sent?'sent':'failed', template });
    }
    return NextResponse.json({ ok:true, dry_run:dryRun, stripe:'reachable', checked:rows.length, scan_complete:provider.scanComplete, ...(provider.scanIncompleteReason ? { scan_incomplete_reason:provider.scanIncompleteReason } : {}), ...(provider.scanIncompleteCollection ? { scan_incomplete_collection:provider.scanIncompleteCollection } : {}), results }, { headers });
  } catch { return NextResponse.json({ ok:false, error:'lifecycle_run_incomplete' }, { status:503, headers }); }
}
