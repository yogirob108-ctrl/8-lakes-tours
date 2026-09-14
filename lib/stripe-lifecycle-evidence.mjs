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

function paymentIntentOf(row) {
  return row?.payment_intent && typeof row.payment_intent === 'object' ? row.payment_intent : row;
}

function normalize(source, row) {
  const intent = paymentIntentOf(row);
  const charge = intent?.latest_charge && typeof intent.latest_charge === 'object' ? intent.latest_charge : {};
  return {
    source,
    id: row?.id,
    payment_intent_id: intent?.id,
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
  return { evidence, scanComplete: true };
}
