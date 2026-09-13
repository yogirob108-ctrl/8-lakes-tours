import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as payload from '../lib/public-checkout.mjs';
import {runBookingCheckout} from '../lib/shared-booking-checkout.mjs';

// Execute the actual TS orchestration; only network boundaries are replaced.
function harness(options = {}) {
  const booking = { id:'b', customer_id:'c', public_reference:'8L-ABCDEFG', submission_key:'key', tour_date:'scheduled', guest_count:2, online_due_usd:1998, total_trip_value_usd:3998, family_cash_due_usd:2000, online_paid_usd:0, status:'awaiting_payment' };
  const state = { booking, payments: options.payments ?? [], sessions: new Map(), creates:0, expires:[], loads:0, failInsert:options.failInsert };
  const session = { id:'cs_one', url:'https://checkout.stripe.com/test', status:'open', payment_status:'unpaid', currency:'usd', amount_total:199800, client_reference_id:booking.public_reference, metadata:{booking_id:'b',customer_id:'c',guest_count:'2',source:'public_exact_checkout'} };
  state.sessions.set('cs_one',session);
  const db = { rpc: async (name,args) => {
    if (name==='prepare_booking_checkout') {
      if(options.claimError)return {error:{message:'claim unavailable'}};
      state.attempt ??= {key:'durable-test-key',spec:args.p_spec,expected:args.p_expected,session_id:args.p_reuse_session};
      return {data:state.attempt};
    }
    if (name==='finalize_booking_checkout') {
      options.onReload?.(state);
      if(state.failInsert){state.failInsert=false;return {error:{message:'fault'}};}
      if(JSON.stringify(state.booking)!==JSON.stringify(state.attempt.expected)
        ||state.payments.some(p=>p.status!=='pending'||p.stripe_checkout_session_id!==args.p_session_id))return {data:false};
      if(!state.payments.length)state.payments.push({...pending});
      state.attempt.session_id=args.p_session_id;
      return {data:true};
    }
    throw Error(name);
  }, from(table) {
    let insert, filter;
    const q = { select(){return q;}, eq(k,v){if(k==='stripe_checkout_session_id')filter=v;return q;}, order(){return q;}, insert(v){insert=v;return q;}, single(){return q;}, then(resolve,reject){return Promise.resolve().then(async()=>{
      if(table==='tour_projects')return {data:{id:'p'}};
      if(table==='bookings') {state.loads++; if(state.loads>1)options.onReload?.(state); return {data:{...state.booking}};}
      if(table==='booking_travellers')return {data:{email:'test@example.invalid'}};
      if(insert){if(state.failInsert){state.failInsert=false;return {error:{code:'fault'}};} if(!state.payments.some(p=>p.stripe_checkout_session_id===insert.stripe_checkout_session_id))state.payments.push({...insert,id:'payment'});else return {error:{code:'23505'}};return {error:null};}
      if(filter)return {data:state.payments.find(p=>p.stripe_checkout_session_id===filter)};
      return {data:state.payments.map(p=>({...p}))};
    }).then(resolve,reject);}};
    return q;
  }};
  class Stripe { checkout={sessions:{
    retrieve:async id=>{options.onRetrieve?.(state);return state.sessions.get(id);},
    create:async()=>{state.creates++;await options.onCreate?.(state);return session;},
    expire:async id=>{state.expires.push(id);return {...session,status:'expired'};},
  }}; }
  const code=ts.transpileModule(readFileSync(new URL('../lib/booking-checkout.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
  const exports={};
  vm.runInNewContext(code,{exports,process:{env:{SUPABASE_SERVICE_ROLE_KEY:'test-only-secret',STRIPE_SECRET_KEY:'test-only'}},require(name){
    if(name==='stripe')return Stripe;
    if(name==='./shared-booking-checkout.mjs')return {runBookingCheckout};
    if(name==='./supabase-admin')return {createSupabaseAdminClient:()=>db};
    if(name==='./public-checkout.mjs')return payload;
    if(name==='./tour-booking.mjs')return {canAutomaticallyConfirmBooking:date=>date==='scheduled'};
    throw Error(name);
  }});
  return {state, run:()=>exports.createBookingCheckout(booking.public_reference,payload.paymentToken(booking.public_reference,'test-only-secret'))};
}
const pending={id:'p',booking_id:'b',stripe_checkout_session_id:'cs_one',status:'pending',amount_usd:1998};
test('reused session does not hide older paid history',async()=>{
 const h=harness({payments:[pending,{...pending,id:'paid',status:'paid'}]});
 await assert.rejects(h.run(),/payment activity/);
});
test('reused session revalidates cancellation while Stripe runs',async()=>{
 const h=harness({payments:[pending],onRetrieve:s=>{s.booking.status='cancelled';}});
 await assert.rejects(h.run(),/changed|not payable/);assert.deepEqual(h.state.expires,['cs_one']);
});
test('new session rejected when group and all tier amounts change together',async()=>{
 const h=harness({onReload:s=>{Object.assign(s.booking,{guest_count:1,online_due_usd:999,total_trip_value_usd:1999,family_cash_due_usd:1000});}});
 await assert.rejects(h.run(),/changed/);assert.deepEqual(h.state.expires,['cs_one']);
});
test('new session rejected when date becomes confirmation-required',async()=>{
 const h=harness({onReload:s=>{s.booking.tour_date='private';}});
 await assert.rejects(h.run());assert.deepEqual(h.state.expires,['cs_one']);
});
test('DB failure after provider acceptance can resume same session',async()=>{
 const h=harness({failInsert:true});await assert.rejects(h.run(),/retry/);
 assert.equal(await h.run(),'https://checkout.stripe.com/test');assert.equal(h.state.payments.length,1);
});
test('simultaneous create requests verify the same unique payment row',async()=>{
 const h=harness();const urls=await Promise.all([h.run(),h.run()]);assert.equal(new Set(urls).size,1);assert.equal(h.state.payments.length,1);
});
test('concurrent paid transition during creation never returns a payable URL',async()=>{
 const h=harness({onReload:s=>{s.booking.online_paid_usd=1998;s.booking.status='confirmed';}});
 await assert.rejects(h.run(),/changed|not payable/);assert.deepEqual(h.state.expires,['cs_one']);
});
test('retrieved session is expired when the durable prepare rejects it',async()=>{
 const h=harness({payments:[pending],claimError:true});
 await assert.rejects(h.run(),/review|retry/);assert.deepEqual(h.state.expires,['cs_one']);
});
test('durable attempt failure prevents any provider call',async()=>{
 const h=harness({claimError:true});await assert.rejects(h.run(),/review|retry/);assert.equal(h.state.creates,0);
});
test('completed provider session never creates another payment',async()=>{
 const h=harness({payments:[pending]});h.state.sessions.get('cs_one').status='complete';
 await assert.rejects(h.run(),/submitted/);assert.equal(h.state.creates,0);
});
test('provider retrieval fault never creates a replacement',async()=>{
 const h=harness({payments:[pending],onRetrieve:()=>{throw Error('provider unavailable');}});
 await assert.rejects(h.run(),/provider unavailable/);assert.equal(h.state.creates,0);
});
test('provider creation fault remains retryable without a payment row',async()=>{
 let fail=true;const h=harness({onCreate:()=>{if(fail){fail=false;throw Error('provider timeout');}}});
 await assert.rejects(h.run(),/provider timeout/);assert.equal(h.state.payments.length,0);
 assert.equal(await h.run(),'https://checkout.stripe.com/test');assert.equal(h.state.payments.length,1);
});
test('another Ops pending session arriving during Stripe creation is expired, not returned',async()=>{
 const h=harness({onCreate:s=>s.payments.push({...pending,id:'ops',stripe_checkout_session_id:'cs_ops'})});
 await assert.rejects(h.run(),/review|activity|changed/);assert.deepEqual(h.state.expires,['cs_one']);
});
test('paid ledger activity before booking reconciliation expires checkout',async()=>{
 const h=harness({onCreate:s=>s.payments.push({...pending,id:'paid',stripe_checkout_session_id:'cs_paid',status:'paid'})});
 await assert.rejects(h.run(),/review|activity|changed/);assert.deepEqual(h.state.expires,['cs_one']);
});
test('provider session for another booking fails closed',async()=>{
 const h=harness({payments:[pending]});h.state.sessions.get('cs_one').metadata.booking_id='other';
 await assert.rejects(h.run(),/review/);
});
