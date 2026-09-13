import test from 'node:test';
import assert from 'node:assert/strict';
import {runAbandonedCheckoutRecovery} from '../lib/abandoned-checkout.mjs';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import vm from 'node:vm';
const row={booking_id:'b',public_reference:'REF',email:'nobody@example.invalid'};
const evidence={generation:'g',session_ids:['cs_owned'],session_id:'cs_owned',customer_id:'c',guest_count:3,amount_cents:292200};
const expired={id:'cs_owned',status:'expired',payment_status:'unpaid',client_reference_id:'REF',metadata:{booking_id:'b',customer_id:'c',guest_count:'3'},amount_total:292200,currency:'usd'};
for(const [name,session] of [['open',{...expired,status:'open'}],['complete unpaid',{...expired,status:'complete'}],['complete paid',{...expired,status:'complete',payment_status:'paid'}],['unknown',{...expired,status:null}],['unavailable',null],['foreign reference',{...expired,client_reference_id:'OTHER'}],['conflicting metadata',{...expired,metadata:{...expired.metadata,booking_reference:'OTHER'}}],['expired unpaid',expired]]) {
 test(`recovery provider evidence: ${name}`,async()=>{
  let sends=0,reads=0;
  const calls=[];
  const db={rpc:async(name,args)=>{calls.push([name,args]); if(name==='list_abandoned_checkouts')return {data:[row]};if(name==='read_abandoned_checkout_evidence')return {data:evidence};if(name==='claim_abandoned_checkout')return {data:{should_send:true,claim_token:'t',payload:{}}};if(name==='authorize_abandoned_checkout_v2')return {data:true};if(name==='authorize_abandoned_checkout')return {data:true};return {};}};
  await runAbandonedCheckoutRecovery({db,allowedDates:['Scheduled'],recoveryUrl:()=> 'https://example.invalid/pay',retrieveSession:async()=>{reads++;if(!session)throw Error('offline');return session;},sendEmail:async()=>{sends++;return {sent:true};}});
  assert.equal(sends,name==='expired unpaid'?1:0);
  assert.equal(reads,1);
  if(sends) assert.ok(calls.some(([n,a])=>n==='authorize_abandoned_checkout_v2'&&a.p_generation==='g'&&a.p_expired_sessions[0]==='cs_owned'));
 });
}
test('actual confirmation transition refuses old 2922 payment against edited 4000 terms',async()=>{
 let updates=0;
 const db={rpc:async(name,args)=>{assert.equal(name,'confirm_paid_booking_v2');assert.equal(args.p_session_id,'cs_old');return {data:{allowed:false,status:'awaiting_payment'}};},from(){return {select(){return this;},eq(){return this;},single:async()=>({data:{status:'awaiting_payment',online_due_usd:4000,online_paid_usd:2922}}),update(){updates++;return this;},maybeSingle:async()=>({data:{status:'confirmed'}})};}};
 const exports={};
 const source=readFileSync(new URL('../app/api/stripe/webhook/route.ts',import.meta.url),'utf8')+'\nexport { transitionBookingAfterPaymentClaim };';
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{exports,process:{env:{}},require(n){if(n==='stripe')return {default:class{}};if(n==='@/lib/supabase-admin')return {createSupabaseAdminClient:()=>db};return {};}});
 const result=await exports.transitionBookingAfterPaymentClaim('b','now','cs_old',{online_due_usd:4000},'lease');
 assert.equal(result.allowed,false);assert.equal(updates,0);
});
