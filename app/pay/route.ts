import { loadPayableBooking } from '@/lib/booking-checkout';
import { canAutomaticallyConfirmBooking } from '@/lib/tour-booking.mjs';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = {
  'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://checkout.stripe.com; base-uri 'none'; frame-ancestors 'none'",
};
function escape(value: string) { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'); }
function page(content: string, status = 200) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Complete your booking | 8 Lakes Tours</title><style>body{font:18px/1.7 system-ui,sans-serif;background:#171209;color:#fff8ea;margin:0}main{max-width:640px;margin:auto;padding:3rem 1.5rem}h1{font-family:Georgia,serif;line-height:1.2}button{background:#c8a96e;color:#171209;border:0;padding:1rem 1.5rem;font:inherit;cursor:pointer;border-radius:6px}a{color:#c8a96e}button:focus-visible,a:focus-visible{outline:3px solid #fff;outline-offset:4px}</style></head><body><main>${content}</main></body></html>`, { status, headers });
}
// Deliberately a standalone document: never load the marketing analytics layout
// on a bearer-token recovery URL.
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const reference = params.get('reference') || '';
  const token = params.get('token') || '';
  let booking;
  try { ({ booking } = await loadPayableBooking(reference, token)); }
  catch { return page('<h1>Payment link unavailable</h1><p>Please use the private payment link in your booking email, or contact info@8lakestours.com.</p>', 404); }
  const paid = Number(booking.online_due_usd) > 0 && Number(booking.online_paid_usd) >= Number(booking.online_due_usd);
  const payable = !paid && booking.status === 'awaiting_payment' && Number(booking.online_paid_usd) === 0 && canAutomaticallyConfirmBooking(booking.tour_date, booking.guest_count);
  const next = params.get('result') === 'complete' && !paid
    ? '<p role="status">Stripe checkout has returned. Payment confirmation may take a moment. Please wait for your confirmation email; do not pay again.</p>'
    : payable ? `<form method="post" action="/api/checkout"><input type="hidden" name="reference" value="${escape(reference)}"><input type="hidden" name="token" value="${escape(token)}"><button type="submit">Continue to secure Stripe checkout</button></form>`
    : `<p>${paid ? 'Thank you. We will send your payment confirmation by email.' : 'Please contact Rob to confirm the next payment step.'}</p>`;
  return page(`<h1>${paid ? '✓ Online payment received' : 'Payment pending — complete your checkout'}</h1><p>Reference: ${escape(reference)}</p><p>${Number(booking.guest_count)} guests · ${escape(booking.tour_date)}</p><p>Online reservation: <strong>$${Number(booking.online_due_usd).toLocaleString('en-US')} USD</strong><br>Host-family cash: $${Number(booking.family_cash_due_usd).toLocaleString('en-US')} USD, paid separately in Mongolia.</p>${next}<p>Keep this private link to return without submitting another booking. Questions? <a href="mailto:info@8lakestours.com">Contact Rob</a>.</p>`);
}
