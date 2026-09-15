export function getDryRun(url) {
  return url.searchParams.get('dry_run') === '1' || url.searchParams.get('dryRun') === '1';
}

function normalEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function exactReference(value, reference) {
  return typeof value === 'string' && value === reference;
}

function evidenceKey(item) {
  return item.payment_intent_id || `${item.source || 'unknown'}:${item.id || 'unknown'}`;
}

function evidenceIssue(booking, item) {
  if (Number(item.amount_cents) !== Number(booking.amount_cents)) return 'review_amount_mismatch';
  if (String(item.currency || '').toLowerCase() !== String(booking.currency || '').toLowerCase()) return 'review_currency_mismatch';
  if (!normalEmail(item.customer_email) || normalEmail(item.customer_email) !== normalEmail(booking.customer_email)) return 'review_customer_mismatch';
  if (item.source === 'checkout_session' && (item.checkout_status !== 'complete' || item.payment_status !== 'paid')) return 'review_payment_not_complete';
  if (item.payment_intent_status !== 'succeeded') return 'review_payment_not_complete';
  const net = Number(item.charge_amount_cents) - Number(item.charge_amount_refunded_cents || 0);
  if (!Number.isFinite(net) || net !== Number(booking.amount_cents)) return 'review_refunded_or_partial';
  return null;
}

function providerPaymentDiagnostic(item) {
  return {
    source: item.source,
    id: item.id,
    payment_intent_id: item.payment_intent_id,
    amount_cents: item.amount_cents,
    currency: item.currency,
    checkout_status: item.checkout_status,
    payment_status: item.payment_status,
    payment_intent_status: item.payment_intent_status,
    charge_amount_cents: item.charge_amount_cents,
    charge_amount_refunded_cents: item.charge_amount_refunded_cents,
  };
}

// An explicit operator-approved binding is durable evidence that this provider
// object belongs to this booking. It selects the transaction to evaluate, but
// never relaxes the amount/currency/customer/refund/status evidence gates.
function approvedBindingFor(booking, approvedBindings) {
  if (!Array.isArray(approvedBindings) || approvedBindings.length === 0) return null;
  const bookingId = typeof booking === 'object' ? booking?.id : undefined;
  return approvedBindings.filter(item =>
    item?.provider_object_id
    && (!item.booking_id || item.booking_id === bookingId)
  );
}

/**
 * Read-only provider evidence classification. It never treats a historical
 * payment as sufficient after the current booking terms change.
 * @param {{ bookings: object[], evidence: object[], approvedBindings?: Array<{booking_id?: string, provider_object_id: string}>, scanComplete: boolean, scanIncompleteReason?: string, scanIncompleteCollection?: string }} input
 */
export function reconcileStripeProviderEvidence({ bookings, evidence, approvedBindings, scanComplete, scanIncompleteReason, scanIncompleteCollection }) {
  return bookings.map((booking) => {
    const referenceMatches = evidence.filter(item => exactReference(item?.reference, booking.reference));
    const bindings = approvedBindingFor(booking, approvedBindings);
    if (bindings?.length > 1) return { reference: booking.reference, status: 'review_multiple_bindings' };
    const bound = bindings?.[0] || null;
    const possiblyBound = evidence.filter(item =>
      !exactReference(item?.reference, booking.reference)
      && Number(item?.amount_cents) === Number(booking.amount_cents)
      && String(item?.currency || '').toLowerCase() === String(booking.currency || '').toLowerCase()
      && normalEmail(item?.customer_email) === normalEmail(booking.customer_email)
      && normalEmail(booking.customer_email),
    );
    if (bound) {
      // The operator-approved binding selects the exact transaction anywhere in
      // the provider evidence — before any reference-based classification: a
      // manually issued invoice can carry no booking reference at all, which is
      // why the operator bound it, and unrelated failed attempts that happen to
      // carry the reference must not create a false conflict.
      // The binding names the bound provider object; the transaction it
      // represents is identified by that object's observed payment_intent_id.
      const boundObject = evidence.find(item => item.id === bound.provider_object_id);
      const canonicalId = boundObject?.payment_intent_id;
      const boundObservations = evidence.filter(item =>
        item.id === bound.provider_object_id
        || (item.payment_intent_id && item.payment_intent_id === bound.provider_object_id)
        || (canonicalId && item.id === canonicalId)
        || (canonicalId && item.payment_intent_id === canonicalId),
      );
      // One canonical transaction can be observed several times: through the
      // bound object's payment relationship (possibly unexpanded: no intent
      // status/charge) and through the PaymentIntent list (full live state).
      // Evaluate exactly one representative per provider payment, preferring
      // the observation that carries the intent's live status/charge state —
      // the evidence gates below still apply in full to what is kept.
      const representatives = new Map();
      for (const item of boundObservations) {
        const key = evidenceKey(item);
        const prior = representatives.get(key);
        if (!prior || (!prior.payment_intent_status && item.payment_intent_status)) representatives.set(key, item);
      }
      const boundMatches = [...representatives.values()];
      if (boundMatches.length === 0) return scanComplete
        ? { reference: booking.reference, status: 'review_binding_object_missing', bound_provider_object: bound.provider_object_id }
        : { reference: booking.reference, status: 'scan_incomplete_unknown', bound_provider_object: bound.provider_object_id };
      if (boundMatches.length > 1) return { reference: booking.reference, status: 'review_multiple_bindings', bound_provider_object: bound.provider_object_id };
      const boundItem = boundMatches[0];
      const boundIssue = evidenceIssue(booking, boundItem);
      if (boundIssue) return { reference: booking.reference, status: boundIssue, bound_provider_object: bound.provider_object_id };
      return {
        reference: booking.reference,
        status: 'verified_paid',
        stripe_reference: boundItem.payment_intent_id || boundItem.id,
        source: boundItem.source,
        bound_provider_object: bound.provider_object_id,
        bound_via_approved_binding: true,
      };
    }
    if (!referenceMatches.length) {
      if (possiblyBound.length) return { reference: booking.reference, status: 'review_ambiguous_unbound_evidence' };
      return scanComplete ? { reference: booking.reference, status: 'no_verified_payment' } : { reference: booking.reference, status: 'scan_incomplete_unknown' };
    }

    // A truncated scan cannot rule out an undiscovered refund or conflicting
    // provider object. An inaccessible Invoice collection is different: an
    // exact, independently listed PaymentIntent with its expanded latest
    // Charge still establishes its own amount/refund state.
    const independentlyVerifiedPaymentIntent = !scanComplete
      && scanIncompleteReason === 'provider_collection_unavailable'
      && scanIncompleteCollection === 'invoice'
      && referenceMatches.some(item => item.source === 'payment_intent');
    if (!scanComplete && !independentlyVerifiedPaymentIntent) return { reference: booking.reference, status: 'scan_incomplete_unknown' };

    const byProviderPayment = new Map();
    for (const item of referenceMatches) {
      const key = evidenceKey(item);
      const prior = byProviderPayment.get(key);
      // In the Invoice-unavailable exception, use independently listed
      // PaymentIntent/Charge evidence instead of a Checkout representation.
      if (!prior || (independentlyVerifiedPaymentIntent && item.source === 'payment_intent') || (!independentlyVerifiedPaymentIntent && item.source === 'checkout_session')) byProviderPayment.set(key, item);
    }
    let matches = [...byProviderPayment.values()];
    if (matches.length !== 1) return {
      reference: booking.reference,
      status: 'review_multiple_conflicting_matches',
      // Authenticated reconciliation needs stable provider evidence to decide
      // whether the entries are genuinely separate payments.  Do not expose
      // customer details or mutable payment metadata in this diagnostic.
      provider_payments: matches.map(providerPaymentDiagnostic),
      unbound_provider_payments: possiblyBound
        .filter(item => !referenceMatches.includes(item))
        .map(providerPaymentDiagnostic),
    };

    const item = matches[0];
    const issue = evidenceIssue(booking, item);
    if (issue) {
      const result = { reference: booking.reference, status: issue };
      if (item.id) result.historical_provider_payment = { stripe_reference: item.id, source: item.source };
      return result;
    }
    return { reference: booking.reference, status: 'verified_paid', stripe_reference: item.id, source: item.source };
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
