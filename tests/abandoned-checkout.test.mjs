import test from 'node:test';
import assert from 'node:assert/strict';
import {runAbandonedCheckoutRecovery,recoveryEmail} from '../lib/abandoned-checkout.mjs';
const row={booking_id:'b',public_reference:'8L-TEST234',email:'test@example.invalid'};
function harness({authorize=true,claim=true,error=false}={}) {
 const sent=[],calls=[];
 const payload={...recoveryEmail(row,'https://example.invalid/pay?token=private'),stage:'abandoned_checkout_1'};
 const db={rpc:async(name,args)=>{calls.push([name,args]);if(name==='list_abandoned_checkouts')return {data:[row]};if(name==='claim_abandoned_checkout')return {data:{should_send:claim,email_event_id:'e',claim_token:'t',payload}};if(name==='read_abandoned_checkout_evidence')return {data:{generation:'g',session_id:'cs',session_ids:['cs'],customer_id:'c',guest_count:1,amount_cents:99900,stage:'abandoned_checkout_1',stages:{}}};if(name==='authorize_abandoned_checkout_v3')return {data:authorize};if(name==='finalize_abandoned_checkout_stage')return {};throw Error(name);}};
 return {sent,calls,run:()=>runAbandonedCheckoutRecovery({db,retrieveSession:async()=>({id:'cs',status:'expired',payment_status:'unpaid',client_reference_id:row.public_reference,metadata:{booking_id:'b',customer_id:'c',guest_count:'1'},amount_total:99900,currency:'usd'}),allowedDates:['Scheduled'],recoveryUrl:()=> 'https://example.invalid/pay?token=private',sendEmail:async p=>{sent.push(p);if(error)throw Error('provider timeout');return {sent:true,id:'local-fixture'};}})};
}
test('recovery sends private transaction only after claim and fresh authorization',async()=>{const h=harness();assert.deepEqual(await h.run(),{sent:1,failed:0,suppressed:0,suppressed_reasons:{},stages:{}});assert.equal(h.sent[0].idempotencyKey,'public-booking-b-abandoned_checkout_1');assert.match(h.sent[0].text,/not confirmed/);assert.doesNotMatch(h.sent[0].text,/newsletter|passport|date of birth/i);});
test('paid or cancelled after claim suppresses send',async()=>{const h=harness({authorize:false});await h.run();assert.equal(h.sent.length,0);});
test('duplicate claim suppresses send',async()=>{const h=harness({claim:false});await h.run();assert.equal(h.sent.length,0);});
test('provider exception finalizes failed for bounded retry',async()=>{const h=harness({error:true});assert.equal((await h.run()).failed,1);assert.equal(h.calls.at(-1)[1].p_sent,false);});
test('email escapes private URL and contains no marketing or traveller data',()=>{const e=recoveryEmail(row,'https://example.invalid/pay?a=1&token=<secret>');assert.match(e.html,/&amp;token=&lt;secret&gt;/);assert.match(e.text,/Robert Zaher/);});
