import test from 'node:test';
import assert from 'node:assert/strict';
import {runAbandonedCheckoutRecovery,recoveryEmail,dueStage} from '../lib/abandoned-checkout.mjs';
const NOW=new Date('2026-09-18T12:00:00Z');
const HOUR=3600*1000;
const row={booking_id:'b',public_reference:'8L-5PEAKQY',email:'henry@example.invalid'};
const payload=stage=>({...recoveryEmail(row,'https://example.invalid/pay?token=private'),stage});
// B1 unit contract: while the durable rollout gate reads OFF, the runner sends
// NOTHING even when env-style post-submit approval is on and the SQL queue
// returns live due rows; the only path through is a durable exact-cohort
// activation created by the explicit operator action.
function harness({gateMode='off',allow=[],sendResult={sent:true,id:'local-fixture'}}={}) {
 const sent=[],calls=[];
 const evidence=()=>({generation:'g',session_id:'cs',session_ids:['cs'],customer_id:'c',guest_count:1,amount_cents:99900,stage:'abandoned_checkout_1',stages:{},eligible_at:new Date(NOW.getTime()-HOUR).toISOString(),expires_at:new Date(NOW.getTime()+48*HOUR).toISOString()});
 const db={rpc:async(name,args)=>{calls.push([name,args]);
  if(name==='list_abandoned_checkouts')return {data:[row]};
  if(name==='read_abandoned_checkout_evidence')return {data:{...evidence(),stages:{}}};
  if(name==='claim_abandoned_checkout')return gateMode==='off'
   ?{data:{should_send:false,gate:'off',gate_mode:gateMode}}
   :(allow.includes(args.p_booking_id)
     ?{data:{should_send:true,email_event_id:'e',claim_token:'t',payload:payload('abandoned_checkout_1')}}
     :{data:{should_send:false,gate:'allowlist',gate_mode:gateMode}});
  if(name==='authorize_abandoned_checkout_v3')return {data:true};
  if(name==='finalize_abandoned_checkout_stage')return {};
  throw Error('unexpected rpc '+name);}};
 return {sent,calls,run:(over={})=>runAbandonedCheckoutRecovery({db,
  retrieveSession:async()=>({id:'cs',status:'expired',payment_status:'unpaid',client_reference_id:row.public_reference,metadata:{booking_id:'b',customer_id:'c',guest_count:'1'},amount_total:99900,currency:'usd'}),
  allowedDates:['Scheduled'],recoveryUrl:()=>'https://example.invalid/pay?token=private',
  sendEmail:async p=>{sent.push(p);return sendResult;},
  now:()=>new Date(NOW),...over})};
}
test('B1: gate OFF sends zero even with env-style enablement and live due queue',async()=>{
 const h=harness({gateMode:'off'});
 const r=await h.run();
 assert.equal(r.sent,0);
 assert.equal(r.suppressed_reasons.gate_refused,1);
 assert.equal(h.sent.length,0);
});
test('B1: explicit allowlist activation admits exactly the activated cohort booking',async()=>{
 const h=harness({gateMode:'test_allowlist',allow:['b']});
 const r=await h.run();
 assert.equal(r.sent,1);
 assert.equal(h.sent[0].idempotencyKey,'public-booking-b-abandoned_checkout_1');
});
test('B1: allowlist mode still refuses a booking outside the activated cohort',async()=>{
 const h=harness({gateMode:'test_allowlist',allow:[]});
 const r=await h.run();
 assert.equal(r.sent,0);
 assert.equal(r.suppressed_reasons.gate_refused,1);
});
test('B2: legacy dedupe max2 — journal carries legacy stage-1 completion, runner can only claim stage 2',async()=>{
 // The state abandoned_cadence_seed_legacy_stage1 leaves behind: stage-1
 // completion derived from the legacy sent ledger 49h ago (verified timestamp,
 // not fabricated). Stage 1 must never be claimed again; the booking can reach
 // at most stage 2 (legacy send + stage 2 = max two total), only inside the
 // stage-2 window.
 const seededStages={abandoned_checkout_1:{completed_at:new Date(NOW.getTime()-49*HOUR).toISOString()}};
 assert.equal(dueStage(seededStages,NOW,{}),'abandoned_checkout_2');
 assert.equal(dueStage(seededStages,new Date(NOW.getTime()-47*HOUR),{}),null);
 // Outside the stage-2 window (legacy send older than 96h): permanently done.
 assert.equal(dueStage({abandoned_checkout_1:{completed_at:new Date(NOW.getTime()-100*HOUR).toISOString()}},NOW,{}),null);
 const sent=[],calls=[];
 const evidence=()=>({generation:'g',session_id:'cs',session_ids:['cs'],customer_id:'c',guest_count:1,amount_cents:99900,stage:'abandoned_checkout_2',stages:seededStages,eligible_at:new Date(NOW.getTime()-HOUR).toISOString(),expires_at:new Date(NOW.getTime()+48*HOUR).toISOString()});
 const db={rpc:async(name,args)=>{calls.push([name,args]);
  if(name==='list_abandoned_checkouts')return {data:[row]};
  if(name==='read_abandoned_checkout_evidence')return {data:evidence()};
  if(name==='claim_abandoned_checkout')return {data:{should_send:true,email_event_id:'e',claim_token:'t',payload:payload('abandoned_checkout_2')}};
  if(name==='authorize_abandoned_checkout_v3')return {data:true};
  if(name==='finalize_abandoned_checkout_stage')return {};
  throw Error('unexpected rpc '+name);}};
 const r=await runAbandonedCheckoutRecovery({db,
  retrieveSession:async()=>({id:'cs',status:'expired',payment_status:'unpaid',client_reference_id:row.public_reference,metadata:{booking_id:'b',customer_id:'c',guest_count:'1'},amount_total:99900,currency:'usd'}),
  allowedDates:['Scheduled'],recoveryUrl:()=>'https://example.invalid/pay?token=private',
  sendEmail:async p=>{sent.push(p);return {sent:true,id:'local-fixture'};},
  now:()=>new Date(NOW)});
 assert.equal(r.sent,1);
 assert.equal(sent[0].idempotencyKey,'public-booking-b-abandoned_checkout_2');
 assert.equal(calls.find(([n])=>n==='claim_abandoned_checkout')[1].p_payload.stage,'abandoned_checkout_2');
});
