const escape = value => String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');
export function recoveryEmail(booking, url, stage='abandoned_checkout_1') {
 const firstName=String(booking.first_name || booking.customer_name || '').trim().split(/\s+/)[0] || 'there';
 const finalFollowup=stage==='abandoned_checkout_2';
 const subject=finalFollowup?'A final note about your 8 Lakes booking':'A quick note about your 8 Lakes booking';
 const opening=finalFollowup
  ? 'I wanted to send one final reminder in case you still want to complete your booking.'
  : 'I noticed your booking was not finished, so I wanted to make it easy to pick up where you left off.';
 const closing=finalFollowup
  ? 'If you have already paid, please wait for the payment confirmation rather than paying again. If you have decided not to continue, you do not need to do anything. If you need a hand, just reply to this email.'
  : 'If you have just paid, please wait for the payment confirmation rather than paying again. If you need a hand with anything, just reply to this email.';
 const text=`Hi ${firstName},

${opening}

You can use your private checkout link below. It keeps the details you already entered:
${url}

${closing}

Rob Zaher
8 Lakes Tours
www.8lakestours.com
info@8lakestours.com`;
 return {to:booking.email,replyTo:'info@8lakestours.com',subject,text,html:`<div style="margin:0;padding:24px 16px;background:#ffffff"><div style="max-width:640px;margin:0 auto;text-align:left;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#222222;font-size:15px;line-height:1.6"><p style="margin:0 0 16px">Hi ${escape(firstName)},</p><p style="margin:0 0 16px">${escape(opening)}</p><p style="margin:0 0 16px">You can use your private checkout link below. It keeps the details you already entered:</p><p style="margin:0 0 16px"><a href="${escape(url)}" style="color:#1155cc">${escape(url)}</a></p><p style="margin:0 0 16px">${escape(closing)}</p><p style="margin:24px 0 0;font-size:13px;line-height:1.6;color:#767676">Rob Zaher<br>8 Lakes Tours<br>www.8lakestours.com<br>info@8lakestours.com</p></div></div>`};
}
// Stage cadence: at most two reminders per booking. Stage 1 ~1h after submission
// (gated on provider-verified expired+unpaid Sessions), stage 2 no earlier than
// 48h after stage 1 actually completed. Stage state lives in durable SQL.
export const STAGE_KEYS=['abandoned_checkout_1','abandoned_checkout_2'];
const STAGE_GAP_MS=48*60*60*1000;
const BLOCK_RETRY_MS=24*60*60*1000;
const RETRY_EXTENSION_MS=7*24*60*60*1000;
const STAGE2_WINDOW_MS=48*60*60*1000;
const SESSION_IDLE_MS=60*60*1000;
function stageState(entry){return !entry?'absent':entry.completed_at?'completed':entry.blocked_at?'blocked':'retryable';}
// Stage clock (mirrored in SQL due_abandoned_checkout_stage - keep aligned):
// - stage 1 due while the intake window is open; a provider block (no send was
//   accepted) mutes it for a bounded retry window so a DNS/provider fix recovers
//   the reminder (bounded by expires_at + RETRY_EXTENSION, never unbounded, and
//   never a batch catch-up of untouched historical rows: no attempt, no retry);
// - stage 2 due 48h after stage-1 DURABLE COMPLETION however late that was
//   (supports the delayed-by-domain case beyond the legacy 48h window), staying
//   open STAGE2_WINDOW then closing; max two reminders total.
export function dueStage(stages,now,window={}){
 const s1=stages?.abandoned_checkout_1,s2=stages?.abandoned_checkout_2;
 const st1=stageState(s1),st2=stageState(s2);
 if(st2==='completed')return null;
 if(st1==='completed'){
  if(st2==='blocked' && new Date(s2.blocked_at).getTime()>now.getTime()-BLOCK_RETRY_MS)return null;
  const dueAt=new Date(s1.completed_at).getTime()+STAGE_GAP_MS;
  return (dueAt<=now.getTime() && now.getTime()<dueAt+STAGE2_WINDOW_MS)?'abandoned_checkout_2':null;
 }
 if(st1==='blocked'){
  if(new Date(s1.blocked_at).getTime()>now.getTime()-BLOCK_RETRY_MS)return null;
  const retryUntil=window.expiresAt?new Date(window.expiresAt).getTime()+RETRY_EXTENSION_MS:Infinity;
  return now.getTime()<retryUntil?'abandoned_checkout_1':null;
 }
 if(window.expiresAt && now.getTime()>new Date(window.expiresAt).getTime())return null;
 return 'abandoned_checkout_1';
}
// A provider account/domain block (e.g. unverified sending domain) fails every
// send identically; record it durably once instead of retrying into the wall.
export function providerBlocked(error){
 return /not verified|domain is not verified|forbidden|unauthor|suspended|inactive sender|not verified sender/i.test(String(error||''));
}
export async function runAbandonedCheckoutRecovery({db,allowedDates,recoveryUrl,sendEmail,retrieveSession,dryRun=false,now=()=>new Date()}) {
 const {data:rows,error}=await db.rpc('list_abandoned_checkouts',{p_allowed_dates:allowedDates});
 if(error) throw new Error('Recovery queue unavailable');
 const at=()=>{const n=now() instanceof Date?now():new Date(now());return n instanceof Date && !Number.isNaN(n.getTime())?n:new Date();};
 const totals={sent:0,failed:0,suppressed:0,suppressed_reasons:{},stages:{}};
 const suppress=reason=>{totals.suppressed++;totals.suppressed_reasons[reason]=(totals.suppressed_reasons[reason]||0)+1;};
 for(const booking of rows || []) {
  const {data:evidence,error:evidenceError}=await db.rpc('read_abandoned_checkout_evidence',{p_booking_id:booking.booking_id,p_allowed_dates:allowedDates});
  if(evidenceError || !evidence?.generation || !evidence.session_id || !Array.isArray(evidence.session_ids) || !evidence.session_ids.includes(evidence.session_id) || !retrieveSession){suppress('evidence_unavailable');continue;}
  const due=dueStage(evidence.stages ?? {},at(),{expiresAt:evidence.expires_at});
  // The queue RPC already excludes not-yet-due stages; re-derive here so a
  // stale queue view can never send outside the accepted stage cadence.
  if(!due || (evidence.stage!=null && evidence.stage!==due)){suppress('no_due_stage');continue;}
  const stage=evidence.stage??due;
  let verified=true,verifyReason='evidence_mismatch';
  try {
   for(const id of evidence.session_ids) {
    let session;
    try {session=await retrieveSession(id);}
    catch {verified=false;verifyReason='provider_error';break;}
    // Exact binding to THIS booking is non-negotiable for every session: same
    // client_reference_id, booking_id/customer_id metadata, and for the owned
    // session also the exact amount and guest count. Evidence mismatch is the
    // conservative outcome whenever any identity field disagrees.
    if(session.id!==id || session.client_reference_id!==booking.public_reference
      || (session.metadata?.booking_reference && session.metadata.booking_reference!==booking.public_reference)
      || session.metadata?.booking_id!==booking.booking_id
      || session.metadata?.customer_id!==evidence.customer_id
      || (id===evidence.session_id && (session.metadata?.guest_count!==String(evidence.guest_count) || session.amount_total!==evidence.amount_cents))
      || session.currency!=='usd') {
     verified=false;verifyReason='evidence_mismatch';break;
    }
    // Payment outcome. Anything other than a provably untouched UNPAID session
    // must suppress: complete/processing/paid/unknown all mean the customer may
    // have money in flight, and an uncertain provider answer is never "safe".
    if(session.payment_status!=='unpaid'){verified=false;verifyReason='payment_submitted';break;}
    if(session.status==='complete'){verified=false;verifyReason='payment_submitted';break;}
    if(session.status==='open'){
     // An OPEN+UNPAID session after the delay is exactly the untouched-cart case:
     // the same session stays recoverable via the guarded pay route, which
     // reuses this exact Session id for payment (never a new amount). ~1h
     // reminders therefore do not need to wait for Session expiry, but they do
     // need the queue's own eligibility anchor (>=1h since submission, read
     // from durable SQL evidence) to have already passed independently.
     const createdMs=session.created?Number(session.created)*1000:null;
     const anchor=evidence.eligible_at!=null?new Date(evidence.eligible_at).getTime():null;
     if(!createdMs || createdMs>at().getTime()-SESSION_IDLE_MS || (anchor!=null && at().getTime()<anchor)){verified=false;verifyReason='session_not_expired';break;}
     continue;
    }
    if(session.status==='expired'){continue;}
    verified=false;verifyReason='provider_error';break;
   }
  } catch {verified=false;verifyReason='provider_error';}
  if(!verified){suppress(verifyReason);continue;}
  // Dry runs retrieve and validate provider evidence but never claim queue work or contact a guest.
  if (dryRun) {
   totals.eligible = (totals.eligible || 0) + 1;
   totals.stages[stage]=(totals.stages[stage]||0)+1;
   continue;
  }
  const {data:claim,error:claimError}=await db.rpc('claim_abandoned_checkout',{p_booking_id:booking.booking_id,p_allowed_dates:allowedDates,p_payload:{...recoveryEmail(booking,recoveryUrl(booking.public_reference),stage),stage}});
  if(claimError) throw new Error('Recovery claim unavailable');
  if(!claim?.should_send){suppress(claim?.gate?'gate_refused':'claim_refused');continue;}
  if(claim.payload?.stage!==stage){suppress('stage_advanced');continue;}
  // Re-read canonical booking + payment ledger + current stage immediately before the provider call.
  const {data:authorized,error:authError}=await db.rpc('authorize_abandoned_checkout_v3',{p_booking_id:booking.booking_id,p_claim_token:claim.claim_token,p_allowed_dates:allowedDates,p_generation:evidence.generation,p_expired_sessions:evidence.session_ids,p_stage:stage});
  if(authError) throw new Error('Recovery authorization unavailable');
  if(!authorized){suppress('authorization_refused');continue;}
  let result;
  try {result=await sendEmail({...claim.payload,idempotencyKey:`public-booking-${booking.booking_id}-${stage}`});}
  catch {result={sent:false,error:'Email provider exception'};}
  const blocked=!result.sent && providerBlocked(result.error);
  const {error:finalizeError}=await db.rpc('finalize_abandoned_checkout_stage',{p_email_event_id:claim.email_event_id,p_claim_token:claim.claim_token,p_stage:stage,p_sent:result.sent,p_provider_message_id:result.id??null,p_raw_response:result,p_provider_blocked:blocked});
  if(finalizeError) throw new Error('Recovery finalization unavailable');
  if(result.sent)totals.sent++;
  else if(blocked)suppress('provider_block');
  else totals.failed++;
 }
 return totals;
}
