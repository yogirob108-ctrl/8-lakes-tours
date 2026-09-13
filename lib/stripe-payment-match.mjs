/**
 * Resolve an existing Stripe payment deterministically. Operator-created checkout
 * rows exist before Stripe assigns a Payment Intent, so the Checkout Session ID
 * is always the primary key and Payment Intent is only a fallback.
 */
export async function findExistingStripePayment({ sessionId, paymentIntentId, lookup }) {
  const bySession = sessionId ? await lookup('stripe_checkout_session_id', sessionId) : null;
  if (bySession) return bySession;
  if (!paymentIntentId) return null;
  return lookup('stripe_payment_intent_id', paymentIntentId);
}

/**
 * An existing payment row owns the booking relationship. Stripe metadata may
 * confirm that relationship but may never move the payment to another booking.
 */
export async function resolveStripePaymentBooking({
  existingPayment,
  stripeReference,
  lookupBookingById,
  lookupBookingByReference,
}) {
  if (existingPayment) {
    const booking = await lookupBookingById(existingPayment.booking_id);
    if (!booking) return { ok: false, reason: 'payment_booking_not_found' };
    if (stripeReference && stripeReference !== booking.public_reference) {
      return { ok: false, reason: 'booking_reference_conflict' };
    }
    return { ok: true, booking };
  }

  if (!stripeReference) return { ok: false, reason: 'missing_reference' };
  const booking = await lookupBookingByReference(stripeReference);
  if (!booking) return { ok: false, reason: 'booking_not_found' };
  return { ok: true, booking };
}

export function isSupportedPaymentCurrency(currency) {
  return typeof currency === 'string' && currency.toUpperCase() === 'USD';
}

export function paymentProcessingDecision({ status, amountUsd, processingComplete = false }) {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    return { process: false, reason: 'invalid_payment_amount', needsClaim: false };
  }
  if (status === 'refunded' || status === 'partially_refunded') {
    return processingComplete
      ? { process: false, reason: 'payment_already_refunded', needsClaim: false }
      : { process: true, reason: 'recover_incomplete_processing', needsClaim: false };
  }
  if (status === 'paid') {
    return processingComplete
      ? { process: false, reason: 'payment_already_recorded', needsClaim: false }
      : { process: true, reason: 'recover_incomplete_processing', needsClaim: false };
  }
  if (status !== null && status !== 'pending') {
    return { process: false, reason: 'payment_state_requires_review', needsClaim: false };
  }
  return { process: true, reason: 'ready', needsClaim: true };
}

export function shouldProcessRefundStatus(status) {
  return status === 'succeeded';
}

export function calculateRefundState({
  originalAmountUsd,
  previousRawEvent,
  refundId,
  individualRefundUsd,
  chargeCumulativeRefundedUsd,
}) {
  const safeRawEvent = previousRawEvent && typeof previousRawEvent === 'object' ? previousRawEvent : {};
  const previousRefunds = safeRawEvent.refunds_by_id && typeof safeRawEvent.refunds_by_id === 'object'
    ? safeRawEvent.refunds_by_id
    : {};
  const refundsById = { ...previousRefunds };
  const legacyRefund = safeRawEvent.latest_refund_event && typeof safeRawEvent.latest_refund_event === 'object'
    ? safeRawEvent.latest_refund_event
    : null;
  const legacyRefundId = legacyRefund && typeof legacyRefund.refund_id === 'string' ? legacyRefund.refund_id : '';
  const legacyRefundAmount = Number(legacyRefund?.individual_refunded_usd ?? legacyRefund?.refunded_usd ?? 0) || 0;
  if (legacyRefundId && refundsById[legacyRefundId] === undefined) {
    refundsById[legacyRefundId] = legacyRefundAmount;
  }

  if (refundId && Number.isFinite(individualRefundUsd) && individualRefundUsd >= 0) {
    refundsById[refundId] = individualRefundUsd;
  }

  const itemizedRefundedUsd = Object.values(refundsById)
    .map(value => Number(value) || 0)
    .reduce((total, value) => total + value, 0);
  const previousCumulativeUsd = Number(safeRawEvent.cumulative_refunded_usd ?? 0) || 0;
  const chargeCumulativeUsd = Number(chargeCumulativeRefundedUsd) || 0;
  const cumulativeRefundedUsd = Math.min(
    Math.max(0, Number(originalAmountUsd) || 0),
    Math.max(previousCumulativeUsd, chargeCumulativeUsd, itemizedRefundedUsd),
  );
  const remainingPaidUsd = Math.max(0, (Number(originalAmountUsd) || 0) - cumulativeRefundedUsd);
  const status = remainingPaidUsd <= 0 ? 'refunded' : 'partially_refunded';

  return {
    cumulativeRefundedUsd,
    remainingPaidUsd,
    status,
    changed: cumulativeRefundedUsd !== previousCumulativeUsd,
    rawEvent: {
      ...safeRawEvent,
      refunds_by_id: refundsById,
      cumulative_refunded_usd: cumulativeRefundedUsd,
    },
  };
}

/**
 * Claim the right to run booking/email side effects. Existing rows use a
 * compare-and-set status transition; new rows rely on Stripe's unique indexes.
 */
export async function claimPaymentAsPaid({ existingPayment, updateExisting, insertNew }) {
  if (existingPayment) {
    const updated = await updateExisting(existingPayment);
    return updated
      ? { claimed: true, paymentId: updated.id }
      : { claimed: false, reason: 'concurrent_or_duplicate' };
  }

  try {
    const inserted = await insertNew();
    return { claimed: true, paymentId: inserted.id };
  } catch (error) {
    if (error && typeof error === 'object' && error.code === '23505') {
      return { claimed: false, reason: 'concurrent_or_duplicate' };
    }
    throw error;
  }
}
