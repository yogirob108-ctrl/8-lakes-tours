import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { NextResponse } from 'next/server.js';

// Execute the real route handlers; replace only booking/provider boundaries.
export function checkoutRoutes(checkoutUrl = 'https://checkout.stripe.com/c/pay/cs_test_fixture') {
  function load(path) {
    const exports = {};
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    vm.runInNewContext(code, { exports, Response, URL, URLSearchParams, console: { error() {} }, require(name) {
      if (name === 'next/server') return { NextResponse };
      if (name === '@/lib/booking-checkout') return {
        createBookingCheckout: async () => checkoutUrl,
        loadPayableBooking: async () => ({ booking: { status: 'awaiting_payment', guest_count: 2, tour_date: 'Scheduled fixture', online_paid_usd: 0, online_due_usd: 1998, family_cash_due_usd: 2000 } }),
      };
      if (name === '@/lib/tour-booking.mjs') return { canAutomaticallyConfirmBooking: () => true };
      throw new Error(`Unexpected import: ${name}`);
    } });
    return exports;
  }
  return { GET: load('../app/pay/route.ts').GET, POST: load('../app/api/checkout/route.ts').POST };
}
