import test from 'node:test';
import assert from 'node:assert/strict';
import {runAbandonedCheckoutRecovery,recoveryEmail,dueStage} from '../lib/abandoned-checkout.mjs';
const HOUR=3600*1000;
const NOW=new Date('2026-09-18T12:00:00Z');
const ago=hours=>new Date(NOW.getTime()-hours*HOUR).toISOString();
const secsAgo=hours=>Math.floor(NOW.getTime()/1000-hours*3600);
const row={booking_id:'b',public_reference:'8L-TEST234',email:'test@example.invalid'};
const payload=(stage)=>({...recoveryEmail(row,'https://example.invalid/pay?token=private'),stage});
function harness({authorize=true,claim=true,claimStage='abandoned_checkout_1',error=false,stages={},sendResult=null}={}) {
 const sent=[],calls=[];
 const evidence=()=>({generation:'g',session_id:'cs',session_ids:['cs'],customer_id:'c',guest_count:1,amount_cents:99900,stage:claimStage,stages:{...stages},eligible_at:ago(1),expires_at:ago(-48)});
 const db={rpc:async(name,args)=>{calls.push([name,args]);
  if(name==='list_abandoned_checkouts')return {data:[row]};
  if(name==='read_abandoned_checkout_evidence')return {data:{...evidence(),stages}};
  if(name==='release_departure_capacity_if_safe')return {data:false};
  if(name==='claim_abandoned_checkout')return {data:claim?{should_send:true,email_event_id:'e',claim_token:'t',payload:payload(claimStage)}:{should_send:false}};
  if(name==='authorize_abandoned_checkout_v3')return {data:authorize};
  if(name==='finalize_abandoned_checkout_stage')return {};
  throw Error('unexpected rpc '+name);}};
 return {sent,calls,run:(over={})=>runAbandonedCheckoutRecovery({db,
  retrieveSession:async()=>({id:'cs',status:'expired',payment_status:'unpaid',client_reference_id:row.public_reference,metadata:{booking_id:'b',customer_id:'c',guest_count:'1'},amount_total:99900,currency:'usd'}),
  allowedDates:['Scheduled'],recoveryUrl:()=>'https://example.invalid/pay?token=private',
  sendEmail:async p=>{sent.push(p);if(error)throw Error('provider timeout');return sendResult??{sent:true,id:'local-fixture'};},
  now:()=>new Date('2026-09-18T12:00:00Z'),...over})};
}
test('stage 1 claims under the original template key ~1h after submission',async()=>{
 const h=harness({claimStage:'abandoned_checkout_1'});
 const r=await h.run();
 assert.equal(r.sent,1);
 const claim=h.calls.find(([n])=>n==='claim_abandoned_checkout');
 assert.equal(claim[1].p_payload.stage,'abandoned_checkout_1');
 assert.equal(claim[1].p_payload.subject,'A quick note about your 8 Lakes booking');
 const send=h.sent[0];
 assert.equal(send.idempotencyKey,'public-booking-b-abandoned_checkout_1');
 const fin=h.calls.find(([n])=>n==='finalize_abandoned_checkout_stage');
 assert.equal(fin[1].p_stage,'abandoned_checkout_1');
 assert.equal(fin[1].p_sent,true);
});
test('stage 2 fires only after a durable stage-1 completion at least 48h old',async()=>{
 const h=harness({claimStage:'abandoned_checkout_2',stages:{abandoned_checkout_1:{completed_at:ago(49)}}});
 const r=await h.run();
 assert.equal(r.sent,1);
 assert.equal(h.calls.find(([n])=>n==='claim_abandoned_checkout')[1].p_payload.stage,'abandoned_checkout_2');
 assert.equal(h.sent[0].idempotencyKey,'public-booking-b-abandoned_checkout_2');
});
test('no immediate catch-up: stage-1 completed 2h ago is excluded from the queue',async()=>{
 const h=harness({claimStage:null,stages:{abandoned_checkout_1:{completed_at:ago(2)}}});
 const r=await h.run();
 assert.equal(r.sent,0);
 assert.equal(r.suppressed_reasons.no_due_stage,1);
 assert.equal(h.calls.find(([n])=>n==='claim_abandoned_checkout'),undefined);
});
test('stage-1 completed under 48h never lets stage 2 run early even if stage-2 due marker exists',async()=>{
 const h=harness({claimStage:null,stages:{abandoned_checkout_1:{completed_at:ago(47)}}});
 const r=await h.run();
 assert.equal(r.sent,0);
 assert.equal(r.suppressed_reasons.no_due_stage,1);
});
test('max two total: both stages completed suppresses with no claim',async()=>{
 const h=harness({claimStage:null,stages:{abandoned_checkout_1:{completed_at:ago(30)},abandoned_checkout_2:{completed_at:ago(5)}}});
 const r=await h.run();
 assert.equal(r.sent,0);
 assert.equal(r.suppressed_reasons.no_due_stage,1);
});
const expiredSession=()=>({id:'cs',status:'expired',payment_status:'unpaid',client_reference_id:row.public_reference,metadata:{booking_id:'b',customer_id:'c',guest_count:'1'},amount_total:99900,currency:'usd'});

test('verified OPEN+UNPAID exact-binding session is eligible ~1h after checkout',async()=>{
 const h=harness({claimStage:'abandoned_checkout_1'});
 const r=await h.run({retrieveSession:async()=>({...expiredSession(),status:'open',created:secsAgo(1.5)})});
 assert.equal(r.sent,1);
 assert.equal(h.sent[0].idempotencyKey,'public-booking-b-abandoned_checkout_1');
 assert.equal(r.suppressed_reasons.session_not_expired,undefined);
});

test('complete unpaid session still suppresses (payment submitted on the page)',async()=>{
 const h=harness({claimStage:'abandoned_checkout_1'});
 const r=await h.run({retrieveSession:async()=>({...expiredSession(),status:'complete'})});
 assert.equal(r.sent,0);
 assert.equal(r.suppressed_reasons.payment_submitted,1);
 assert.equal(h.calls.find(([n])=>n==='claim_abandoned_checkout'),undefined);
});

test('session with payment pending suppresses as payment_submitted',async()=>{
 const h=harness({claimStage:'abandoned_checkout_1'});
 const r=await h.run({retrieveSession:async()=>({...expiredSession(),payment_status:'processing'})});
 assert.equal(r.sent,0);
 assert.equal(r.suppressed_reasons.payment_submitted,1);
});

test('session paid (any status) suppresses as payment_submitted',async()=>{
 const h=harness({claimStage:'abandoned_checkout_1'});
 const r=await h.run({retrieveSession:async()=>({...expiredSession(),status:'complete',payment_status:'paid'})});
 assert.equal(r.sent,0);
 assert.equal(r.suppressed_reasons.payment_submitted,1);
});

test('unknown status suppresses as provider_error, never messages',async()=>{
 const h=harness({claimStage:'abandoned_checkout_1'});
 const r=await h.run({retrieveSession:async()=>({...expiredSession(),status:undefined})});
 assert.equal(r.sent,0);
 assert.equal(r.suppressed_reasons.provider_error,1);
});

test('fresh open session is conservatively suppressed as session_not_expired, never messaged',async()=>{
 const h=harness({claimStage:'abandoned_checkout_1'});
 const r=await h.run({retrieveSession:async()=>({...expiredSession(),status:'open',created:secsAgo(2/60)})});
 assert.equal(r.sent,0);
 assert.equal(r.suppressed_reasons.session_not_expired,1);
 assert.equal(h.calls.find(([n])=>n==='claim_abandoned_checkout'),undefined);
});

test('open session younger than the 1h eligibility anchor is suppressed as session_not_expired',async()=>{
 const h=harness({claimStage:'abandoned_checkout_1'});
 const r=await h.run({retrieveSession:async()=>({...expiredSession(),status:'open',created:secsAgo(1/3)})});
 assert.equal(r.sent,0);
 assert.equal(r.suppressed_reasons.session_not_expired,1);
});

test('open session older than 1h is eligible even before the first payment row exists',async()=>{
 const h=harness({claimStage:'abandoned_checkout_1'});
 const r=await h.run({retrieveSession:async()=>({...expiredSession(),status:'open',created:secsAgo(1.5)})});
 assert.equal(r.sent,1);
});

test('blocked stage retries bounded after the provider is fixed; never batch catch-up; stage 2 still reachable beyond the legacy 48h window',()=>{
 // Blocked stage-1 attempts do not create a due stage while the block is fresh.
 assert.equal(dueStage({abandoned_checkout_1:{blocked_at:ago(1),failed_at:ago(1)}},NOW,{expiresAt:ago(-72)}),null);
 // Bounded retry: the block mutes for one day, then stage 1 is due again
 // (extends to expires_at + 7 days, so a DNS fix recovers the reminder);
 // the retry window closes once expires_at + 7 days has passed.
 assert.equal(dueStage({abandoned_checkout_1:{blocked_at:ago(25),failed_at:ago(25)}},NOW,{expiresAt:ago(-24)}),'abandoned_checkout_1');
 assert.equal(dueStage({abandoned_checkout_1:{blocked_at:ago(24*8)}},NOW,{expiresAt:ago(24*8)}),null);
 // Stage-1 completion during a delayed (domain-fix) window still admits stage 2
 // at stage1+48h, staying open until stage1+96h: beyond the legacy 48h intake.
 assert.equal(dueStage({abandoned_checkout_1:{completed_at:ago(49)}},NOW,{expiresAt:ago(4)}),'abandoned_checkout_2');
 assert.equal(dueStage({abandoned_checkout_1:{completed_at:ago(47.5)}},NOW,{expiresAt:ago(4)}),null);
 assert.equal(dueStage({abandoned_checkout_1:{completed_at:ago(100)}},NOW,{expiresAt:ago(4)}),null);
 // No batch catch-up: a completed stage 2 keeps the booking permanently done.
 assert.equal(dueStage({abandoned_checkout_1:{completed_at:ago(49)},abandoned_checkout_2:{completed_at:ago(2)}},NOW,{expiresAt:ago(4)}),null);
 // Untouched rows with no attempt never catch up after the intake window.
 assert.equal(dueStage({},NOW,{expiresAt:ago(1)}),null);
 assert.equal(dueStage({},NOW,{expiresAt:ago(-1)}),'abandoned_checkout_1');
});

test('uncertain provider evidence (retrieval error) suppresses as provider_error',async()=>{
 const h=harness({claimStage:'abandoned_checkout_1'});
 const r=await h.run({retrieveSession:async()=>{throw Error('stripe timeout');}});
 assert.equal(r.sent,0);
 assert.equal(r.suppressed_reasons.provider_error,1);
});
test('evidence mismatch suppresses as evidence_mismatch',async()=>{
 const h=harness({claimStage:'abandoned_checkout_1'});
 const r=await h.run({retrieveSession:async()=>({id:'cs',status:'expired',payment_status:'unpaid',client_reference_id:'8L-OTHER',metadata:{booking_id:'b'},amount_total:99900,currency:'usd'})});
 assert.equal(r.sent,0);
 assert.equal(r.suppressed_reasons.evidence_mismatch,1);
});
test('provider-blocked acceptance (unverified domain) records durable failure and stops retries for the stage',async()=>{
 const h=harness({claimStage:'abandoned_checkout_1',sendResult:{sent:false,error:'The 8lakestours.com domain is not verified. Please, add and verify your domain on https://resend.com/domains'}});
 const r=await h.run();
 assert.equal(r.sent,0);
 assert.equal(r.suppressed_reasons.provider_block,1);
 const fin=h.calls.find(([n])=>n==='finalize_abandoned_checkout_stage');
 assert.equal(fin[1].p_sent,false);
 assert.equal(fin[1].p_provider_blocked,true);
 assert.equal(fin[1].p_stage,'abandoned_checkout_1');
});
test('plain transport failure records durable failure without block marker for same-claim/stage retry',async()=>{
 const h=harness({claimStage:'abandoned_checkout_1',error:true});
 const r=await h.run();
 assert.equal(r.failed,1);
 const fin=h.calls.find(([n])=>n==='finalize_abandoned_checkout_stage');
 assert.equal(fin[1].p_sent,false);
 assert.equal(fin[1].p_provider_blocked,false);
});
test('paid or cancelled after claim suppresses via authorization refusal',async()=>{
 const h=harness({claimStage:'abandoned_checkout_1',authorize:false});
 const r=await h.run();
 assert.equal(r.sent,0);
 assert.equal(r.suppressed_reasons.authorization_refused,1);
});
test('stage advanced between evidence read and claim suppresses without sending',async()=>{
 const h=harness({claim:false,claimStage:'abandoned_checkout_2',stages:{abandoned_checkout_1:{completed_at:ago(25)}}});
 const r=await h.run();
 assert.equal(r.sent,0);
 assert.ok(r.suppressed>=1);
});
test('dry run evaluates stages without claiming or sending',async()=>{
 const h=harness({claimStage:'abandoned_checkout_1'});
 const r=await h.run({dryRun:true});
 assert.equal(r.eligible,1);
 assert.equal(r.sent,0);
 assert.equal(h.sent.length,0);
 assert.equal(h.calls.find(([n])=>n==='claim_abandoned_checkout'),undefined);
});
test('stage reminders have distinct plain personal copy and the same private resume link',()=>{
 const url='https://example.invalid/pay?token=private';
 const first=recoveryEmail(row,url,'abandoned_checkout_1');
 const second=recoveryEmail(row,url,'abandoned_checkout_2');
 assert.notEqual(first.subject,second.subject);
 assert.match(first.text,/details you already entered/i);
 assert.match(second.text,/final reminder/i);
 assert.ok(first.text.includes(url));
 assert.ok(second.text.includes(url));
 for (const email of [first,second]) {
  assert.match(email.text,/Your place is not confirmed\. Places remain subject to availability\./);
  assert.match(email.html,/Your place is not confirmed\. Places remain subject to availability\./);
 }
 assert.equal((first.text.match(/Rob Zaher/g)||[]).length,1);
 assert.equal((second.text.match(/Rob Zaher/g)||[]).length,1);
 assert.doesNotMatch(`${first.text}\n${second.text}`,/seat reservation|seat reserved|place reserved/i);
});
test('dry_run observations document per-stage eligibility and suppression reasons',async()=>{
 const h=harness({claimStage:'abandoned_checkout_2',stages:{abandoned_checkout_1:{completed_at:ago(49)}}});
 const r=await h.run({dryRun:true});
 assert.equal(r.eligible,1);
 assert.equal(r.stages.abandoned_checkout_2,1);
 assert.equal(r.sent,0);
});
