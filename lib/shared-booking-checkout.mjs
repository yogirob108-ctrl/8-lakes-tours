// Mirrored byte-for-byte in the public and Ops repos; schema owns arbitration.
// Network boundaries are injected so tests execute this actual orchestration.
export async function runBookingCheckout({ db, stripe, booking, spec }) {
  const { data: payments, error } = await db.from('payments').select('id,stripe_checkout_session_id,status').eq('booking_id', booking.id).order('created_at', { ascending: false });
  if (error) throw new Error('Payment history is unavailable. Please retry later.');
  if ((payments ?? []).some(p => p.status !== 'pending')) throw new Error('This booking has payment activity. Please contact our team.');
  const matches = session => session.amount_total === spec.line_items[0].price_data.unit_amount
    && session.currency === 'usd' && session.client_reference_id === booking.public_reference
    && session.metadata?.booking_id === booking.id && session.metadata?.customer_id === booking.customer_id
    && session.metadata?.guest_count === String(booking.guest_count);
  const expired = [];
  let reusable;
  for (const payment of payments ?? []) {
    if (!payment.stripe_checkout_session_id) throw new Error('An operator payment needs review.');
    const existing = await stripe.checkout.sessions.retrieve(payment.stripe_checkout_session_id);
    if (existing.status === 'complete' || existing.payment_status !== 'unpaid') throw new Error('Payment has been submitted. Please wait for confirmation.');
    if (existing.status === 'expired') { expired.push(existing.id); continue; }
    if (existing.status !== 'open' || !existing.url || !matches(existing) || reusable) throw new Error('An existing checkout needs operator review.');
    reusable = existing;
  }
  // Stripe's exact terminal state, not a client timer, is the only release
  // authority. The session id fences a stale expired generation from deleting a
  // newer allocation. A missing rollout RPC is unknown evidence: do not mint a
  // replacement Session that could strand or overbook capacity.
  for (const sessionId of expired) {
    const { error: releaseError } = await db.rpc('release_departure_capacity_if_safe', {
      p_booking_id: booking.id, p_session_id: sessionId, p_provider_terminal: 'expired',
    });
    if (releaseError) throw new Error('Provider evidence unavailable; operator review required.');
  }
  const { data: attempt, error: claimError } = await db.rpc('prepare_booking_checkout', {
    p_booking_id: booking.id, p_expected: booking, p_spec: spec,
    p_expired_sessions: expired, p_reuse_session: reusable?.id ?? null,
  });
  if (claimError || !attempt?.key || !attempt.spec) {
    // A retrieved URL must not stay payable after a cancellation/activity fence.
    // Expiring conservatively on a DB outage sacrifices availability, not money:
    // the next generation still requires provider-confirmed expiry.
    if (reusable) await stripe.checkout.sessions.expire(reusable.id);
    throw new Error('Booking changed or checkout needs operator review or retry.');
  }
  const session = attempt.session_id
    ? await stripe.checkout.sessions.retrieve(attempt.session_id)
    : await stripe.checkout.sessions.create(attempt.spec, { idempotencyKey: attempt.key });
  if (!session.url || session.status !== 'open' || session.payment_status !== 'unpaid' || !matches(session)) throw new Error('Checkout is unavailable; operator review required.');
  const { data: finalized, error: finishError } = await db.rpc('finalize_booking_checkout', {
    p_booking_id: booking.id, p_key: attempt.key, p_session_id: session.id,
    p_url: session.url, p_expires_at: session.expires_at ?? null,
  });
  // Transport failure may have committed: retry the SAME durable generation.
  if (finishError) throw new Error('Checkout is being prepared. Your booking is saved; please retry this same link.');
  if (finalized !== true) {
    await stripe.checkout.sessions.expire(session.id);
    throw new Error('Booking or payment activity changed; operator review required.');
  }
  return session;
}
