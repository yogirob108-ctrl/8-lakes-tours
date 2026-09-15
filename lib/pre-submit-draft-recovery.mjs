import { createHash, randomBytes, randomUUID } from 'node:crypto';

const escape = value => String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');
export const draftRecoveryToken = () => randomBytes(32).toString('base64url');
export const draftRecoveryTokenHash = token => createHash('sha256').update(token).digest('hex');

export function draftRecoveryEmail(draft, url) {
 const firstName=String(draft.first_name || '').trim().split(/\s+/)[0] || 'there';
 const text=`Hi ${firstName},

You started an 8 Lakes booking but did not reach secure checkout. Your place is not confirmed.

You can continue with the same saved booking details through your private link:
${url}

If you no longer want to continue, no problem, you can ignore this reminder. Any questions, just reply to this email.

Rob Zaher
8 Lakes Tours`;
 return {to:draft.email,replyTo:'info@8lakestours.com',subject:'Continue your 8 Lakes booking',text,html:`<div style="display:none;max-height:0;overflow:hidden;color:transparent;opacity:0">Your 8 Lakes booking is still saved. Your place is not confirmed until checkout and payment.</div><div style="margin:0;padding:24px 16px;background:#ffffff"><div style="max-width:640px;margin:0 auto;text-align:left;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#222222;font-size:15px;line-height:1.6"><p style="margin:0 0 16px">Hi ${escape(firstName)},</p><p style="margin:0 0 16px">You started an 8 Lakes booking but did not reach secure checkout. Your place is not confirmed.</p><p style="margin:0 0 16px">You can continue with the same saved booking details through your private link:</p><p style="margin:0 0 16px"><a href="${escape(url)}" style="color:#1155cc">${escape(url)}</a></p><p style="margin:0 0 16px">If you no longer want to continue, no problem, you can ignore this reminder. Any questions, just reply to this email.</p><p style="margin:24px 0 0">Rob Zaher<br>8 Lakes Tours</p></div></div>`};
}

export async function runPreSubmitDraftRecovery({db,recoveryUrl,sendEmail,dryRun=false}) {
 const {data:rows,error}=await db.rpc('list_abandoned_public_checkout_drafts');
 if(error) throw new Error('Draft recovery queue unavailable');
 const totals={eligible:0,sent:0,failed:0,suppressed:0};
 for(const draft of rows || []) {
  totals.eligible++;
  if(dryRun) continue;
  const token=draftRecoveryToken();
  const claimToken=randomUUID();
  const payload=draftRecoveryEmail(draft,recoveryUrl(token));
  const {data:claim,error:claimError}=await db.rpc('claim_abandoned_public_checkout_draft',{p_draft_id:draft.draft_id,p_recovery_token_hash:draftRecoveryTokenHash(token),p_claim_token:claimToken,p_payload:payload});
  if(claimError) throw new Error('Draft recovery claim unavailable');
  if(!claim?.should_send){totals.suppressed++;continue;}
  let result;
  try { result=await sendEmail({...payload,idempotencyKey:`public-checkout-draft-${draft.draft_id}-recovery`}); }
  catch { result={sent:false,error:'Email provider exception'}; }
  const {error:finalizeError}=await db.rpc('finalize_abandoned_public_checkout_draft',{p_draft_id:draft.draft_id,p_claim_token:claimToken,p_sent:result.sent,p_provider_message_id:result.id??null,p_raw_response:result});
  if(finalizeError) throw new Error('Draft recovery finalization unavailable');
  totals[result.sent?'sent':'failed']++;
 }
 return totals;
}
