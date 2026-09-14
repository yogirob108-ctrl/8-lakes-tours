export function getDryRun(url) {
  return url.searchParams.get('dry_run') === '1' || url.searchParams.get('dryRun') === '1';
}

export function reconcileStripeSessions({ bookings, sessions }) {
  const paid = new Map();
  for (const session of sessions) {
    if (session?.payment_status === 'paid' && typeof session.client_reference_id === 'string' && typeof session.id === 'string') {
      paid.set(session.client_reference_id, session.id);
    }
  }
  return bookings.map((booking) => {
    const stripeReference = paid.get(booking.reference);
    return stripeReference
      ? { reference: booking.reference, status: 'verified_paid', stripe_reference: stripeReference }
      : { reference: booking.reference, status: 'no_verified_payment' };
  });
}

export function selectPacedLifecycleCandidate({ verifiedStripe, daysUntilDeparture, sentTemplates }) {
  if (!verifiedStripe || !Number.isInteger(daysUntilDeparture) || daysUntilDeparture < 0) return null;
  const order = [
    ['payment_confirmed', Infinity],
    ['preparation_packing', 60],
    ['insurance_final_check', 30],
    ['arrival_coordination', 14],
    ['final_checklist', 3],
  ];
  for (const [template, threshold] of order) {
    if (!sentTemplates.has(template) && daysUntilDeparture <= threshold) return template;
  }
  return null;
}
