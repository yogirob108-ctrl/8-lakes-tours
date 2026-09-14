import Stripe from 'stripe';
import { timingSafeEqual } from 'node:crypto';
import { createSupabaseAdminClient } from '@/lib/supabase-admin';
import { getDryRun, reconcileStripeProviderEvidence } from '@/lib/public-lifecycle.mjs';
import { collectStripeLifecycleEvidence } from '@/lib/stripe-lifecycle-evidence.mjs';

export const runtime = 'nodejs';
export const maxDuration = 60;

function authorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  const supplied = Buffer.from(request.headers.get('authorization') || '');
  const expected = Buffer.from(`Bearer ${secret || ''}`);
  return Boolean(secret) && supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function customerEmail(row: { customer?: { email?: string | null } | { email?: string | null }[] | null }) {
  const customer = Array.isArray(row.customer) ? row.customer[0] : row.customer;
  return customer?.email || '';
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const headers = { 'Cache-Control': 'no-store' };
  if (!authorized(request)) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401, headers });
  if (!getDryRun(url)) return Response.json({ ok: false, error: 'dry_run_required' }, { status: 400, headers });
  if (!process.env.STRIPE_SECRET_KEY) return Response.json({ ok: false, error: 'stripe_unavailable' }, { status: 503, headers });

  try {
    const db = createSupabaseAdminClient();
    const { data: bookings, error } = await db
      .from('bookings')
      .select('id, public_reference, online_due_usd, customer:customers(email)')
      .in('status', ['awaiting_payment', 'confirmed', 'prep_sent', 'ready_for_departure'])
      .limit(200);
    if (error) throw error;

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { maxNetworkRetries: 0, timeout: 5000 });
    const provider = await collectStripeLifecycleEvidence({ stripe, pageBudget: 90 });
    const candidates = reconcileStripeProviderEvidence({
      bookings: (bookings || []).map((row: { id: string; public_reference: string; online_due_usd: number; customer?: { email?: string | null } | { email?: string | null }[] | null }) => ({
        id: row.id,
        reference: row.public_reference,
        amount_cents: Number(row.online_due_usd) * 100,
        currency: 'usd',
        customer_email: customerEmail(row),
      })),
      evidence: provider.evidence,
      scanComplete: provider.scanComplete,
    });
    return Response.json({ ok: true, dry_run: true, stripe: 'reachable', checked: candidates.length, scan_complete: provider.scanComplete, ...(provider.scanIncompleteReason ? { scan_incomplete_reason: provider.scanIncompleteReason } : {}), ...(provider.scanIncompleteCollection ? { scan_incomplete_collection: provider.scanIncompleteCollection } : {}), candidates }, { headers });
  } catch {
    return Response.json({ ok: false, error: 'stripe_reconciliation_unavailable' }, { status: 503, headers });
  }
}
