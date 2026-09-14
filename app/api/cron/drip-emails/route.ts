import Stripe from 'stripe';
import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { arrivalCoordinationCustomerEmail, finalChecklistCustomerEmail, getInternalEmailRecipients, insuranceReminderCustomerEmail, paymentConfirmedCustomerEmail, preparationCustomerEmail, sendEmail } from '@/lib/email';
import { getLifecycleEmailSchedule } from '@/lib/lifecycle-email-schedule.mjs';
import { getDryRun, reconcileStripeSessions, selectPacedLifecycleCandidate } from '@/lib/public-lifecycle.mjs';
import { isSupabaseAdminConfigured } from '@/lib/ops-config';
import { createSupabaseAdminClient } from '@/lib/supabase-admin';

const LIFECYCLE_KEYS = ['payment_confirmed', 'preparation_packing', 'insurance_final_check', 'arrival_coordination', 'final_checklist'];
type TemplateKey = typeof LIFECYCLE_KEYS[number];
type BookingRow = { id:string; public_reference:string; customer_id:string|null; tour_date:string|null; status:string; online_paid_usd:number|null; customer?: {first_name?:string|null;email?:string|null}|{first_name?:string|null;email?:string|null}[]|null };

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
  const input = { reference: booking.public_reference, firstName: customer(booking).firstName, tourDate: booking.tour_date || 'TBC' };
  if (template === 'payment_confirmed') return paymentConfirmedCustomerEmail({ ...input, amountUsd: booking.online_paid_usd || 0 });
  if (template === 'preparation_packing') return preparationCustomerEmail(input);
  if (template === 'insurance_final_check') return insuranceReminderCustomerEmail(input);
  if (template === 'arrival_coordination') return arrivalCoordinationCustomerEmail(input);
  return finalChecklistCustomerEmail(input);
}
async function paidSessions() {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('stripe_unavailable');
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { maxNetworkRetries: 0, timeout: 5000 });
  const rows: Array<{id:string;client_reference_id:string|null;payment_status:string}> = [];
  let count = 0;
  for await (const session of stripe.checkout.sessions.list({ limit: 100 })) {
    rows.push({ id: session.id, client_reference_id: session.client_reference_id, payment_status: session.payment_status });
    if (++count >= 1000) break;
  }
  return rows;
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ ok:false, error:'Unauthorized' }, { status:401 });
  if (!isSupabaseAdminConfigured) return NextResponse.json({ ok:false, error:'Supabase admin is not configured' }, { status:503 });
  const dryRun = getDryRun(new URL(request.url));
  const headers = { 'Cache-Control':'no-store' };
  try {
    const db = createSupabaseAdminClient();
    const { data: bookings, error } = await db.from('bookings').select('id, public_reference, customer_id, tour_date, status, online_paid_usd, customer:customers(first_name, email)').in('status',['awaiting_payment','confirmed','prep_sent','ready_for_departure']).limit(200);
    if (error) throw error;
    const rows = (bookings || []) as BookingRow[];
    const sessions = await paidSessions();
    const reconciliation = reconcileStripeSessions({ bookings:rows.map(row=>({id:row.id,reference:row.public_reference})), sessions });
    const verified = new Set((reconciliation as Array<{ reference:string; status:string }>).filter((row:{reference:string;status:string})=>row.status==='verified_paid').map((row:{reference:string;status:string})=>row.reference));
    const { data: events, error: eventsError } = await db.from('email_events').select('booking_id, template_key, status').in('booking_id',rows.map(row=>row.id)).in('template_key',LIFECYCLE_KEYS);
    if (eventsError) throw eventsError;
    const existing = new Map<string, Set<string>>();
    for (const event of events || []) if (event.booking_id && ['queued','sent','delivered'].includes(event.status)) { const set=existing.get(event.booking_id)||new Set<string>(); set.add(event.template_key); existing.set(event.booking_id,set); }
    const results: Array<Record<string,unknown>> = [];
    for (const booking of rows) {
      const schedule = getLifecycleEmailSchedule({ now:new Date(), tourDate:booking.tour_date });
      const template = selectPacedLifecycleCandidate({ verifiedStripe:verified.has(booking.public_reference), daysUntilDeparture:schedule.daysUntilDeparture, sentTemplates:existing.get(booking.id)||new Set() }) as TemplateKey|null;
      if (!template) { results.push({ reference:booking.public_reference, status:verified.has(booking.public_reference) ? 'not_due_or_complete' : 'no_verified_payment' }); continue; }
      if (dryRun) { results.push({ reference:booking.public_reference, status:'candidate', template, days_until_departure:schedule.daysUntilDeparture }); continue; }
      const recipient = customer(booking).email;
      if (!recipient) { results.push({ reference:booking.public_reference, status:'missing_customer_email', template }); continue; }
      const email = message(template, booking);
      const claim = await db.from('email_events').insert({ booking_id:booking.id, customer_id:booking.customer_id, template_key:template, to_email:recipient, subject:email.subject, body_snapshot:email.text, sent_by:'drip-cron', status:'queued', is_canonical:true, claim_token:crypto.randomUUID(), claimed_at:new Date().toISOString() }).select('id').single();
      if (claim.error || !claim.data) { results.push({ reference:booking.public_reference, status:'already_claimed', template }); continue; }
      const result = await sendEmail({ to:recipient, replyTo:getInternalEmailRecipients()[0], ...email, idempotencyKey:`8l-lifecycle-${booking.id}-${template}` });
      await db.from('email_events').update({ status:result.sent?'sent':'failed', provider_message_id:result.id||null, provider_completed_at:new Date().toISOString(), raw_response:result }).eq('id',claim.data.id).eq('status','queued');
      if (result.sent) await db.from('booking_events').insert({ booking_id:booking.id,event_type:'email',direction:'outbound',title:`Lifecycle email sent: ${template}`,body:`Resend email id: ${result.id || 'unknown'}`,created_by:'drip-cron' });
      results.push({ reference:booking.public_reference, status:result.sent?'sent':'failed', template });
    }
    return NextResponse.json({ ok:true, dry_run:dryRun, stripe:'reachable', checked:rows.length, results }, { headers });
  } catch { return NextResponse.json({ ok:false, error:'lifecycle_run_incomplete' }, { status:503, headers }); }
}
