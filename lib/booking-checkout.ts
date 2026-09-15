import Stripe from 'stripe';
import { runBookingCheckout } from './shared-booking-checkout.mjs';
import { createSupabaseAdminClient } from './supabase-admin';
import { checkoutSpec, paymentToken, validPaymentToken } from './public-checkout.mjs';
import { canAutomaticallyConfirmBooking } from './tour-booking.mjs';

const SITE = 'https://www.8lakestours.com';
export function recoveryUrl(reference: string) {
  return `${SITE}/pay?reference=${encodeURIComponent(reference)}&token=${paymentToken(reference, process.env.SUPABASE_SERVICE_ROLE_KEY)}`;
}
export async function loadPayableBooking(reference: string, token: string) {
  if (!/^8L-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{7}$/.test(reference) || !validPaymentToken(reference, token, process.env.SUPABASE_SERVICE_ROLE_KEY)) throw new Error('Invalid payment link. Please use the link in your booking email.');
  const db = createSupabaseAdminClient();
  const { data: project, error: projectError } = await db.from('tour_projects').select('id').eq('slug', '8-lakes-tours').eq('active', true).single();
  if (projectError || !project) throw new Error('Booking system is temporarily unavailable.');
  const { data: booking, error } = await db.from('bookings').select('id,customer_id,public_reference,tour_date,guest_count,online_due_usd,online_paid_usd,total_trip_value_usd,family_cash_due_usd,status,submission_key').eq('public_reference', reference).eq('project_id', project.id).single();
  if (error || !booking || !booking.submission_key) throw new Error('Booking is unavailable. Please contact our team.');
  return { db, booking };
}
export async function createBookingCheckout(reference: string, token: string) {
  const { db, booking } = await loadPayableBooking(reference, token);
  if (!canAutomaticallyConfirmBooking(booking.tour_date, booking.guest_count)) throw new Error('Our team must confirm availability before payment.');
  const { data: lead, error: leadError } = await db.from('booking_travellers').select('email').eq('booking_id', booking.id).eq('position', 1).single();
  if (leadError || !lead?.email) throw new Error('Booking contact details are unavailable.');
  const spec = checkoutSpec(booking, lead.email, recoveryUrl(reference));
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('Secure checkout is temporarily unavailable. Your booking is saved; please retry this link or contact our team.');
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const session = await runBookingCheckout({ db, stripe, booking, spec });
  return session.url;
}
