const escape = value => String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');
export function recoveryEmail(booking, url) {
 const text = `Hello,

You started a booking with 8 Lakes Tours, but we have not verified an online payment. Your place is not confirmed.

If you would like to continue, use this private link to resume secure checkout without submitting your details again:
${url}

If you have just paid, please wait for your payment confirmation rather than paying again. If you no longer want to continue, you can ignore this one-time reminder. Questions? Reply to me.

Rob Zaher
8 Lakes Tours`;
 return {to:booking.email, replyTo:'info@8lakestours.com',subject:'Continue your 8 Lakes checkout',text,html:`<div style="font-family:Arial,sans-serif;line-height:1.6">${escape(text).replaceAll('\n','<br>')}<p><a href="${escape(url)}">Resume secure checkout</a></p></div>`};
}
export async function runAbandonedCheckoutRecovery({db,allowedDates,recoveryUrl,sendEmail,retrieveSession}) {
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
