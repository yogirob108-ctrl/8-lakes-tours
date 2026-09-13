import { NextResponse } from 'next/server';
import { createBookingCheckout } from '@/lib/booking-checkout';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  if (Number(request.headers.get('content-length') || 0) > 2048) return new Response('Request too large', { status: 413 });
  const text = await request.text();
  if (text.length > 2048) return new Response('Request too large', { status: 413 });
  const form = new URLSearchParams(text);
  try {
    const url = await createBookingCheckout(form.get('reference') || '', form.get('token') || '');
    const destination = new URL(url);
    // Provider and persisted session URLs must never become an open redirect.
    if (destination.origin !== 'https://checkout.stripe.com' || destination.username || destination.password) throw new Error('Untrusted checkout URL');
    if (request.headers.get('accept') === 'application/json') return NextResponse.json({ url }, { headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
    return NextResponse.redirect(url, { status: 303, headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
  } catch (error) {
    // Never return provider internals or credentials to the browser.
    console.error('Public checkout unavailable', error instanceof Error ? error.name : 'unknown');
    return new Response('Checkout could not be opened. Your booking is saved. Go back and retry the same payment link, or contact info@8lakestours.com. Do not submit another booking.', { status: 409, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
  }
}
