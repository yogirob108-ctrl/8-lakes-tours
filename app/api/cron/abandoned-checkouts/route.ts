import Stripe from 'stripe';
import { timingSafeEqual } from 'node:crypto';
import { createSupabaseAdminClient } from '@/lib/supabase-admin';
import { recoveryUrl } from '@/lib/booking-checkout';
import { sendEmail } from '@/lib/email';
import { runCapacityReconciliation } from '@/lib/capacity-reconciliation.mjs';
import { runAbandonedCheckoutRecovery } from '@/lib/abandoned-checkout.mjs';
import { runPreSubmitDraftRecovery } from '@/lib/pre-submit-draft-recovery.mjs';
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
 const postSubmitEnabled=process.env.ABANDONED_CHECKOUT_RECOVERY_ENABLED==='true';
 // Pre-submit drafts have their own customer-send control. Never let post-submit approval imply draft email approval.
 const preSubmitEnabled=process.env.PRE_SUBMIT_DRAFT_RECOVERY_ENABLED==='true';
 // A credentialed dry run remains safe and verifies both queues without claiming or sending.
 if(!postSubmitEnabled && !preSubmitEnabled && !dryRun) return Response.json({post_submit_enabled:false,pre_submit_draft_enabled:false},{headers});
 try {
  const allowedDates=getVisibleTourDates(TOUR_DATES).filter((date: {date:string})=>canAutomaticallyConfirmBooking(date.date,1)).map((date: {date:string})=>date.date);
  const db=createSupabaseAdminClient();
  const draftResult=(preSubmitEnabled || dryRun)
   ? await runPreSubmitDraftRecovery({db,recoveryUrl:(token:string)=>`https://www.8lakestours.com/resume-draft?token=${encodeURIComponent(token)}`,sendEmail,dryRun})
   : {eligible:0,sent:0,failed:0,suppressed:0,enabled:false};
  let result: {sent:number;failed:number;suppressed:number;eligible?:number}={sent:0,failed:0,suppressed:0,eligible:0};
  let capacity={scanned:0,released_expired:0,released_cancelled_refunded:0,retained:0,provider_errors:0};
  if(postSubmitEnabled || dryRun) {
   if(!process.env.STRIPE_SECRET_KEY) throw new Error('Provider evidence unavailable');
   const stripe=new Stripe(process.env.STRIPE_SECRET_KEY,{maxNetworkRetries:0,timeout:5000});
   const retrieveSession=(id:string)=>stripe.checkout.sessions.retrieve(id,{expand:['payment_intent.latest_charge']});
   // Capacity is reconciled before the reminder queue so it is never coupled to
   // email eligibility, email presence, or exhausted reminder stages.
   capacity=await runCapacityReconciliation({db,retrieveSession,dryRun});
   result=await runAbandonedCheckoutRecovery({db,allowedDates,recoveryUrl,sendEmail,retrieveSession,dryRun});
  }
  return Response.json({dry_run:dryRun,post_submit_enabled:postSubmitEnabled,pre_submit_draft_enabled:preSubmitEnabled,...result,capacity_reconciliation:capacity,draft_recovery:draftResult},{headers});
 } catch { return Response.json({error:'Recovery run incomplete; retry safely.'},{status:503,headers}); }
}
