import Stripe from 'stripe';
import { timingSafeEqual } from 'node:crypto';
import { createSupabaseAdminClient } from '@/lib/supabase-admin';

export const runtime = 'nodejs';
export const maxDuration = 30;

// Narrow, authenticated, operator-approved bind action for exactly ONE
// provider payment object. It never lists, scans, charges, or refunds: it
// verifies the exact provider object against the operator-supplied expected
// facts (settled amount, customer email, currency, zero refunds, one
// succeeded canonical PaymentIntent) and only then writes the durable binding
// through the atomic idempotent RPC. Any mismatch refuses without a write.
function authorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  const supplied = Buffer.from(request.headers.get('authorization') || '');
  const expected = Buffer.from(`Bearer ${secret || ''}`);
  return Boolean(secret) && supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function verifiedEmailOf(invoice: any, intent: any): string {
  return String(invoice?.customer_email || intent?.receipt_email || intent?.latest_charge?.billing_details?.email || '').trim().toLowerCase();
}

export async function POST(request: Request) {
  const headers = { 'Cache-Control': 'no-store' };
  if (!authorized(request)) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401, headers });
  if (!process.env.STRIPE_SECRET_KEY) return Response.json({ ok: false, error: 'stripe_unavailable' }, { status: 503, headers });

  let body: { bookingId?: string; provider_object_id?: string; approvedBy?: string; expected?: { amountCents?: number; customerEmail?: string } } = {};
  try { body = await request.json(); } catch { body = {}; }
  const providerObjectId = typeof body.provider_object_id === 'string' ? body.provider_object_id.trim() : '';
  const bookingId = typeof body.bookingId === 'string' ? body.bookingId.trim() : '';
  const approvedBy = typeof body.approvedBy === 'string' ? body.approvedBy.trim() : '';
  const expectedAmount = Number(body.expected?.amountCents);
  const expectedEmail = String(body.expected?.customerEmail || '').trim().toLowerCase();
  if (!bookingId || !providerObjectId || !approvedBy || !Number.isInteger(expectedAmount) || expectedAmount <= 0 || !expectedEmail) {
    return Response.json({ ok: false, error: 'invalid_request' }, { status: 400, headers });
  }

  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { maxNetworkRetries: 0, timeout: 10000 });
    // Exact-object verification only; nothing else is touched.
    const invoice = await stripe.invoices.retrieve(providerObjectId, { expand: ['payments.data.payment.payment_intent'] });
    if (!invoice || invoice.id !== providerObjectId) {
      return Response.json({ ok: false, error: 'invoice_identity_mismatch' }, { status: 422, headers });
    }
    const nested = Array.isArray(invoice?.payments?.data) ? invoice.payments.data : [];
    const paymentIntentIds = nested
      .map((p: any) => p?.payment?.payment_intent?.id)
      .filter((id: any): id is string => typeof id === 'string' && id.startsWith('pi_'));
    if (invoice.status !== 'paid'
      || Number(invoice.amount_paid) !== expectedAmount
      || String(invoice.currency || '').toLowerCase() !== 'usd'
      || Number(invoice.amount_remaining || 0) !== 0
      || paymentIntentIds.length !== 1) {
      return Response.json({ ok: false, error: 'invoice_not_verified', verified: false }, { status: 422, headers });
    }
    const paymentIntentId = paymentIntentIds[0];
    const listed = await stripe.paymentIntents.list({ limit: 100 });
    const matching = (listed?.data || []).filter((pi: any) => pi.id === paymentIntentId);
    const intent = matching.length === 1 ? matching[0] : null;
    const refunded = Number((intent as any)?.latest_charge && typeof (intent as any).latest_charge === 'object'
      ? (intent as any).latest_charge.amount_refunded
      : 0);
    if (!intent || intent.status !== 'succeeded'
      || Number(intent.amount_received) !== expectedAmount
      || refunded !== 0) {
      return Response.json({ ok: false, error: 'intent_not_verified', verified: false }, { status: 422, headers });
    }
    if (verifiedEmailOf(invoice, intent) !== expectedEmail) {
      return Response.json({ ok: false, error: 'customer_mismatch', verified: false }, { status: 422, headers });
    }

    // All gates passed: write the durable binding atomically.
    const db = createSupabaseAdminClient();
    const { data, error } = await db.rpc('bind_approved_payment', {
      p_booking_id: bookingId,
      p_provider_object_id: providerObjectId,
      p_approved_by: approvedBy,
      p_payment_intent_id: paymentIntentId,
      p_amount_usd: Math.round(expectedAmount / 100),
      p_paid_at: new Date(Number(invoice.status_transitions?.paid_at) * 1000 || Date.now()).toISOString(),
      p_payment_evidence: {
        invoice_id: invoice.id, amount_paid: invoice.amount_paid, currency: invoice.currency,
        payment_intent_id: paymentIntentId, status: invoice.status, amount_remaining: invoice.amount_remaining,
      },
      p_approval_context: { operator_approved: true, bound_via: 'ops_bind_approved_payment' },
    });
    if (error) return Response.json({ ok: false, error: 'bind_rpc_failed' }, { status: 502, headers });
    return Response.json({ ok: true, verified: true, result: data }, { headers });
  } catch {
    return Response.json({ ok: false, error: 'bind_verification_unavailable' }, { status: 503, headers });
  }
}
