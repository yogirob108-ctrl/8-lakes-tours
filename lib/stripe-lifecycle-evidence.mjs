function string(...values) {
  return values.find(value => typeof value === 'string' && value.length > 0);
}

function safeProviderError(error) {
  const safeString = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(value) ? value : undefined;
  const status = Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode <= 599
    ? error.statusCode
    : undefined;
  const metadata = { type: safeString(error?.type), code: safeString(error?.code), status };
  return Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== undefined));
}

function referenceOf(row) {
  const metadata = row?.metadata || {};
  const intentMetadata = row?.payment_intent && typeof row.payment_intent === 'object' ? row.payment_intent.metadata || {} : {};
  const candidates = [row?.client_reference_id, metadata.booking_reference, metadata.public_reference, metadata.bookingReference, intentMetadata.booking_reference, intentMetadata.public_reference, intentMetadata.bookingReference].filter(value => typeof value === 'string' && value.length > 0);
  return candidates.length && candidates.every(value => value === candidates[0]) ? candidates[0] : undefined;
}

function nestedInvoicePaymentIntent(row) {
  const payment = row?.payments?.data?.find(item => item?.payment?.type === 'payment_intent')?.payment?.payment_intent;
  return payment || undefined;
}

function paymentIntentOf(source, row) {
  if (source === 'payment_intent') return row;
  if (row?.payment_intent && typeof row.payment_intent === 'object') return row.payment_intent;
  const nested = nestedInvoicePaymentIntent(row);
  return nested && typeof nested === 'object' ? nested : undefined;
}

function paymentIntentIdOf(source, row, intent) {
  if (typeof row?.payment_intent === 'string' && row.payment_intent.length > 0) return row.payment_intent;
  const nested = nestedInvoicePaymentIntent(row);
  if (typeof nested === 'string' && nested.length > 0) return nested;
  return source === 'payment_intent' ? row?.id : intent?.id;
}

function normalize(source, row) {
  const intent = paymentIntentOf(source, row);
  const charge = intent?.latest_charge && typeof intent.latest_charge === 'object' ? intent.latest_charge : {};
  return {
    source,
    id: row?.id,
    payment_intent_id: paymentIntentIdOf(source, row, intent),
    reference: referenceOf(row),
    amount_cents: source === 'checkout_session' ? row?.amount_total : (row?.amount_received ?? row?.amount_paid ?? row?.amount),
    currency: row?.currency,
    customer_email: string(row?.customer_details?.email, row?.customer_email, row?.receipt_email, charge?.billing_details?.email),
    checkout_status: source === 'checkout_session' ? row?.status : undefined,
    payment_status: source === 'checkout_session' ? row?.payment_status : (source === 'invoice' && row?.status === 'paid' ? 'paid' : undefined),
    payment_intent_status: intent?.status,
    charge_amount_cents: charge?.amount ?? intent?.amount_received ?? row?.amount_paid ?? row?.amount_received,
    charge_amount_refunded_cents: charge?.amount_refunded ?? 0,
  };
}

async function collectCollection({ list, source, options, budget, evidence }) {
  let startingAfter;
  while (true) {
    if (budget.remaining <= 0) return false;
    const page = await list({ limit: 100, ...options, ...(startingAfter ? { starting_after: startingAfter } : {}) });
    budget.remaining -= 1;
    const data = Array.isArray(page?.data) ? page.data : [];
    evidence.push(...data.map(row => normalize(source, row)));
    if (!page?.has_more) return true;
    const last = data.at(-1)?.id;
    if (!last) throw new Error('stripe_pagination_cursor_missing');
    startingAfter = last;
  }
}

/** Read-only, explicitly bounded Stripe collector for lifecycle reconciliation. */
export async function collectStripeLifecycleEvidence({ stripe, pageBudget = 90 }) {
  const budget = { remaining: pageBudget };
  const evidence = [];
  const collections = [
    { list: stripe.checkout.sessions.list.bind(stripe.checkout.sessions), source: 'checkout_session', options: { expand: ['data.payment_intent.latest_charge'] } },
    { list: stripe.paymentIntents.list.bind(stripe.paymentIntents), source: 'payment_intent', options: { expand: ['data.latest_charge'] } },
    { list: stripe.invoices.list.bind(stripe.invoices), source: 'invoice', options: { expand: ['data.payment_intent.latest_charge'] } },
  ];
  for (const collection of collections) {
    let complete;
    try {
      complete = await collectCollection({ ...collection, budget, evidence });
    } catch (error) {
      return { evidence, scanComplete: false, scanIncompleteReason: 'provider_collection_unavailable', scanIncompleteCollection: collection.source, scanIncompleteProviderError: safeProviderError(error) };
    }
    if (!complete) return { evidence, scanComplete: false, scanIncompleteReason: 'page_budget_exhausted' };
  }
  // A legacy Invoice observation can carry its paying PaymentIntent as an
  // unexpanded id (no intent status/charge state on the row). Resolve exactly
  // those rows from the authoritative PaymentIntent endpoint — read-only,
  // budgeted, fail-closed — so a verifiable transaction is not rejected for
  // the provider's expansion shape. Evidence gates still apply in full.
  const incomplete = evidence.filter(item => item.source === 'invoice' && item.id && !item.payment_intent_status);
  if (incomplete.length > 10 || budget.remaining < incomplete.length) {
    return { evidence, scanComplete: false, scanIncompleteReason: 'page_budget_exhausted' };
  }
  for (const item of incomplete) {
    budget.remaining -= 1;
    try {
      if (!item.payment_intent_id) {
        const full = await stripe.invoices.retrieve(item.id, { expand: ['payments.data.payment.payment_intent'] });
        Object.assign(item, normalize('invoice', full));
      }
      if (item.payment_intent_id && !item.payment_intent_status) {
        const intent = await stripe.paymentIntents.retrieve(item.payment_intent_id, { expand: ['latest_charge'] });
        const charge = intent?.latest_charge && typeof intent.latest_charge === 'object' ? intent.latest_charge : undefined;
        item.payment_intent_status = intent?.status;
        item.charge_amount_cents = charge ? charge.amount : intent?.amount_received;
        item.charge_amount_refunded_cents = charge ? (charge.amount_refunded ?? 0) : 0;
        // Same customer-email chain the verified bind action uses: the
        // invoice row's own email wins; intent/charge fields fill the gap.
        item.customer_email = item.customer_email || string(intent?.receipt_email, charge?.billing_details?.email);
      }
    } catch (error) {
      return { evidence, scanComplete: false, scanIncompleteReason: 'provider_collection_unavailable', scanIncompleteCollection: 'invoice', scanIncompleteProviderError: safeProviderError(error) };
    }
  }
  return { evidence, scanComplete: true };
}
