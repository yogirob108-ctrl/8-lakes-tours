import Stripe from 'stripe';
import { timingSafeEqual } from 'node:crypto';
import { createSupabaseAdminClient } from '@/lib/supabase-admin';
import { recoveryUrl } from '@/lib/booking-checkout';
import { sendEmail } from '@/lib/email';
import { runAbandonedCheckoutRecovery } from '@/lib/abandoned-checkout.mjs';
import { getVisibleTourDates, TOUR_DATES } from '@/lib/tour-dates.mjs';
import { canAutomaticallyConfirmBooking } from '@/lib/tour-booking.mjs';
export const runtime = 'nodejs';
export const maxDuration = 60;
export async function GET(request: Request) {
 const secret=process.env.CRON_SECRET;
 const supplied=Buffer.from(request.headers.get('authorization') || '');
 const expected=Buffer.from(`Bearer ${secret || ''}`);
 if(!secret || supplied.length!==expected.length || !timingSafeEqual(supplied,expected)) return new Response('Unauthorized',{status:401});
 const headers={'Cache-Control':'no-store'};
 const dryRun=String(request.url || '').includes('?dry_run=1') || String(request.url || '').includes('&dry_run=1');
 // The rollout switch blocks sending, but a credentialed dry run remains safe and verifies the real queue.
 if(process.env.ABANDONED_CHECKOUT_RECOVERY_ENABLED!=='true' && !dryRun) return Response.json({enabled:false},{headers});
 try {
  const allowedDates=getVisibleTourDates(TOUR_DATES).filter((date: {date:string})=>canAutomaticallyConfirmBooking(date.date,1)).map((date: {date:string})=>date.date);
  if(!process.env.STRIPE_SECRET_KEY) throw new Error('Provider evidence unavailable');
  const stripe=new Stripe(process.env.STRIPE_SECRET_KEY,{maxNetworkRetries:0,timeout:5000});
  const result=await runAbandonedCheckoutRecovery({db:createSupabaseAdminClient(),allowedDates,recoveryUrl,sendEmail,retrieveSession:(id:string)=>stripe.checkout.sessions.retrieve(id),dryRun});
  return Response.json({dry_run:dryRun,...result},{headers});
 } catch { return Response.json({error:'Recovery run incomplete; retry safely.'},{status:503,headers}); }
}
