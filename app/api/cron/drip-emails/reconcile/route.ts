import Stripe from 'stripe';
import { timingSafeEqual } from 'node:crypto';
import { createSupabaseAdminClient } from '@/lib/supabase-admin';
import { getDryRun, reconcileStripeSessions } from '@/lib/public-lifecycle.mjs';

export const runtime = 'nodejs';
export const maxDuration = 60;

function authorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  const supplied = Buffer.from(request.headers.get('authorization') || '');
  const expected = Buffer.from(`Bearer ${secret || ''}`);
  return Boolean(secret) && supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  if (!authorized(request)) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  if (!getDryRun(url)) return Response.json({ ok: false, error: 'dry_run_required' }, { status: 400 });
  if (!process.env.STRIPE_SECRET_KEY) return Response.json({ ok: false, error: 'stripe_unavailable' }, { status: 503 });

  try {
    const db = createSupabaseAdminClient();
    const { data: bookings, error } = await db
      .from('bookings')
      .select('id, public_reference')
      .in('status', ['awaiting_payment', 'confirmed', 'prep_sent', 'ready_for_departure'])
      .limit(200);
    if (error) throw error;

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { maxNetworkRetries: 0, timeout: 5000 });
    const sessions: Array<{ id: string; client_reference_id: string | null; payment_status: string }> = [];
    let pages = 0;
    for await (const session of stripe.checkout.sessions.list({ limit: 100 })) {
      sessions.push({ id: session.id, client_reference_id: session.client_reference_id, payment_status: session.payment_status });
      if (++pages >= 1000) break;
    }
    const candidates = reconcileStripeSessions({
      bookings: (bookings || []).map((row: { id: string; public_reference: string }) => ({ id: row.id, reference: row.public_reference })),
      sessions,
    });
    return Response.json({ ok: true, dry_run: true, stripe: 'reachable', checked: candidates.length, candidates }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ ok: false, error: 'stripe_reconciliation_unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
