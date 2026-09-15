const escape = value => String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');
export function recoveryEmail(booking, url) {
 const firstName=String(booking.first_name || booking.customer_name || '').trim().split(/\s+/)[0] || 'there';
 const text=`Hi ${firstName},

You started a booking with 8 Lakes Tours, but the online payment has not gone through yet. Your place is not confirmed.

If you still want to come, you can finish booking through your private checkout link. It keeps the details you already entered:
${url}

If you have just paid, please wait for the payment confirmation rather than paying again. If you no longer want to continue, no problem, you can ignore this reminder. Any questions, just reply to this email.

Rob Zaher
8 Lakes Tours`;
 return {to:booking.email, replyTo:'info@8lakestours.com',subject:'Continue your 8 Lakes checkout',text,html:`<div style="display:none;max-height:0;overflow:hidden;color:transparent;opacity:0">Your 8 Lakes checkout is still open. Your place is not confirmed until payment.</div><div style="margin:0;padding:24px 16px;background:#ffffff"><div style="max-width:640px;margin:0 auto;text-align:left;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#222222;font-size:15px;line-height:1.6"><p style="margin:0 0 16px">Hi ${escape(firstName)},</p><p style="margin:0 0 16px">You started a booking with 8 Lakes Tours, but the online payment has not gone through yet. Your place is not confirmed.</p><p style="margin:0 0 16px">If you still want to come, you can finish booking through your private checkout link. It keeps the details you already entered:</p><p style="margin:0 0 16px"><a href="${escape(url)}" style="color:#1155cc">${escape(url)}</a></p><p style="margin:0 0 16px">If you have just paid, please wait for the payment confirmation rather than paying again. If you no longer want to continue, no problem, you can ignore this reminder. Any questions, just reply to this email.</p><p style="margin:24px 0 0">Rob Zaher<br>8 Lakes Tours</p></div></div>`};
}

export async function runAbandonedCheckoutRecovery({db,allowedDates,recoveryUrl,sendEmail,retrieveSession,dryRun=false}) {
 const {data:rows,error}=await db.rpc('list_abandoned_checkouts',{p_allowed_dates:allowedDates});
 if(error) throw new Error('Recovery queue unavailable');
 const totals={sent:0,failed:0,suppressed:0};
 for(const booking of rows || []) {
  const {data:evidence,error:evidenceError}=await db.rpc('read_abandoned_checkout_evidence',{p_booking_id:booking.booking_id,p_allowed_dates:allowedDates});
  if(evidenceError || !evidence?.generation || !evidence.session_id || !Array.isArray(evidence.session_ids) || !evidence.session_ids.includes(evidence.session_id) || !retrieveSession){totals.suppressed++;continue;}
  let verified=true;
  try {
   for(const id of evidence.session_ids) {
    const session=await retrieveSession(id);
    if(session.id!==id || session.status!=='expired' || session.payment_status!=='unpaid'
      || session.client_reference_id!==booking.public_reference
      || (session.metadata?.booking_reference && session.metadata.booking_reference!==booking.public_reference)
      || session.metadata?.booking_id!==booking.booking_id
      || session.metadata?.customer_id!==evidence.customer_id
      || (id===evidence.session_id && (session.metadata?.guest_count!==String(evidence.guest_count) || session.amount_total!==evidence.amount_cents))
      || session.currency!=='usd') {verified=false;break;}
   }
  } catch {verified=false;}
  if(!verified){totals.suppressed++;continue;}
  // Dry runs retrieve and validate provider evidence but never claim queue work or contact a guest.
  if (dryRun) {
   totals.eligible = (totals.eligible || 0) + 1;
   continue;
  }
  const {data:claim,error:claimError}=await db.rpc('claim_abandoned_checkout',{p_booking_id:booking.booking_id,p_allowed_dates:allowedDates,p_payload:recoveryEmail(booking,recoveryUrl(booking.public_reference))});
  if(claimError) throw new Error('Recovery claim unavailable');
  if(!claim?.should_send){totals.suppressed++;continue;}
  // Re-read canonical booking + payment ledger immediately before the provider call.
  const {data:authorized,error:authError}=await db.rpc('authorize_abandoned_checkout_v2',{p_booking_id:booking.booking_id,p_claim_token:claim.claim_token,p_allowed_dates:allowedDates,p_generation:evidence.generation,p_expired_sessions:evidence.session_ids});
  if(authError) throw new Error('Recovery authorization unavailable');
  if(!authorized){totals.suppressed++;continue;}
  let result;
  try {result=await sendEmail({...claim.payload,idempotencyKey:`public-booking-${booking.booking_id}-abandoned_checkout`});}
  catch {result={sent:false,error:'Email provider exception'};}
  const {error:finalizeError}=await db.rpc('finalize_public_booking_email_v2',{p_email_event_id:claim.email_event_id,p_claim_token:claim.claim_token,p_sent:result.sent,p_provider_message_id:result.id??null,p_raw_response:result});
  if(finalizeError) throw new Error('Recovery finalization unavailable');
  totals[result.sent?'sent':'failed']++;
 }
 return totals;
}
