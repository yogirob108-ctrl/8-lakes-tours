import { createHmac, timingSafeEqual } from 'node:crypto';
import { getGroupPricing } from './group-pricing.mjs';

export function paymentToken(reference, secret) {
  if (!secret) throw new Error('Payment recovery is not configured');
  return createHmac('sha256', secret).update(`8l-payment-v1:${reference}`).digest('hex');
}
export function validPaymentToken(reference, token, secret) {
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token) || !secret) return false;
  return timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(paymentToken(reference, secret), 'hex'));
}
export function checkoutSpec(booking, email, recoveryUrl) {
  if (!Number.isInteger(booking.guest_count) || booking.guest_count < 1 || booking.guest_count > 8) throw new Error('Invalid group pricing');
  const price = getGroupPricing(booking.guest_count);
  if (Number(booking.online_due_usd) !== price.onlinePaymentUsd || Number(booking.total_trip_value_usd) !== price.totalTripValueUsd || Number(booking.family_cash_due_usd) !== price.localFamilyPaymentUsd) throw new Error('Booking pricing needs operator review');
  if (booking.status !== 'awaiting_payment' || Number(booking.online_paid_usd) !== 0) throw new Error('Booking is not payable online; contact our team for assistance');
  const metadata = { booking_reference: booking.public_reference, booking_id: booking.id, customer_id: booking.customer_id, guest_count: String(booking.guest_count), source: 'public_exact_checkout' };
  return {
    mode: 'payment', customer_email: email, client_reference_id: booking.public_reference,
    metadata, payment_intent_data: { metadata }, allow_promotion_codes: false,
    line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: price.onlinePaymentUsd * 100, product_data: { name: `8 Lakes Tours — ${booking.guest_count} guest${booking.guest_count === 1 ? '' : 's'} online reservation`, description: `Booking ${booking.public_reference}. Host-family cash is paid separately in Mongolia.` } } }],
    success_url: `${recoveryUrl}&result=complete`, cancel_url: recoveryUrl,
  };
}
