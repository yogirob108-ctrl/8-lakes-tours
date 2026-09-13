import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import vm from 'node:vm';
test('actual reconciliation uses booking-locked ledger aggregate, not last Session',async()=>{
 let balance=4000;
 const db={rpc:async(n)=>{assert.equal(n,'reconcile_paid_booking_v2');balance=4000;return {data:4000};},from(table){return {select(){return this;},eq(){return this;},is(){return this;},single:async()=>({data:{id:'p',amount_usd:2922,status:'paid',raw_event:{}}}),maybeSingle:async()=>({data:{id:'p'}}),update(payload){if(table==='bookings')balance=payload.online_paid_usd;return this;},then(resolve){resolve({error:null});}};}};
 const exports={};
 const source=readFileSync(new URL('../app/api/stripe/webhook/route.ts',import.meta.url),'utf8')+'\nexport { reconcileBookingPaymentBalance };';
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{exports,process:{env:{}},require(n){if(n==='stripe')return {default:class{}};if(n==='@/lib/supabase-admin')return {createSupabaseAdminClient:()=>db};return {};}});
 const r=await exports.reconcileBookingPaymentBalance({paymentId:'p',bookingId:'b'});
 assert.equal(balance,4000);assert.equal(r.onlinePaidUsd,4000);
});
