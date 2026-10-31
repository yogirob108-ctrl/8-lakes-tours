import test from 'node:test';
import assert from 'node:assert/strict';
import {runBookingCheckout} from '../lib/shared-booking-checkout.mjs';
import {runAbandonedCheckoutRecovery} from '../lib/abandoned-checkout.mjs';

const booking={id:'booking-1',customer_id:'customer-1',public_reference:'8L-CAPACITY',guest_count:1};
const spec={line_items:[{quantity:1,price_data:{unit_amount:99900,currency:'usd'}}],client_reference_id:booking.public_reference,metadata:{booking_id:booking.id,customer_id:booking.customer_id,guest_count:'1'}};
const expired={id:'cs_old',status:'expired',payment_status:'unpaid',currency:'usd',amount_total:99900,client_reference_id:booking.public_reference,metadata:spec.metadata};
const replacement={...expired,id:'cs_new',status:'open',url:'https://checkout.stripe.test/new'};

function checkoutHarness({releaseError=false}={}) {
 const calls=[]; let creates=0;
 const db={
  from(){return {select(){return this},eq(){return this},order(){return Promise.resolve({data:[{id:'payment-old',stripe_checkout_session_id:'cs_old',status:'pending'}]})}}},
  rpc:async(name,args)=>{
   calls.push([name,args]);
   if(name==='release_departure_capacity_if_safe') return releaseError?{error:{message:'RPC missing'}}:{data:false};
   if(name==='prepare_booking_checkout') return {data:{key:'generation',spec:args.p_spec}};
   if(name==='finalize_booking_checkout') return {data:true};
   throw Error(`unexpected RPC ${name}`);
  },
 };
 const stripe={checkout:{sessions:{
  retrieve:async id=>id==='cs_old'?expired:replacement,
  create:async()=>{creates++;return replacement},
  expire:async()=>{},
 }}};
 return {calls,get creates(){return creates},run:()=>runBookingCheckout({db,stripe,booking,spec})};
}

test('exact expired unpaid Stripe evidence releases only its old allocation before renewal',async()=>{
 const h=checkoutHarness();
 const session=await h.run();
 assert.equal(session.id,'cs_new');
 assert.equal(h.creates,1);
 assert.deepEqual(h.calls.map(([name])=>name),['release_departure_capacity_if_safe','prepare_booking_checkout','finalize_booking_checkout']);
 assert.deepEqual(h.calls[0][1],{p_booking_id:'booking-1',p_session_id:'cs_old',p_provider_terminal:'expired'});
 assert.deepEqual(h.calls[1][1].p_expired_sessions,['cs_old']);
});

test('missing capacity release RPC fails closed before a replacement provider session is created',async()=>{
 const h=checkoutHarness({releaseError:true});
 await assert.rejects(h.run(),/provider evidence unavailable|operator review/i);
 assert.equal(h.creates,0);
 assert.deepEqual(h.calls.map(([name])=>name),['release_departure_capacity_if_safe']);
});

const recoveryRow={booking_id:'booking-1',public_reference:'8L-CAPACITY',email:'guest@example.invalid'};
function recoveryHarness(session,{releaseError=false}={}) {
 const calls=[]; let sends=0;
 const evidence={generation:'generation',session_id:'cs_old',session_ids:['cs_old'],customer_id:'customer-1',guest_count:1,amount_cents:99900,stage:'abandoned_checkout_1',stages:{}};
 const db={rpc:async(name,args)=>{
  calls.push([name,args]);
  if(name==='list_abandoned_checkouts')return {data:[recoveryRow]};
  if(name==='read_abandoned_checkout_evidence')return {data:evidence};
  if(name==='release_departure_capacity_if_safe'){
   if(releaseError)return {error:{message:'RPC missing'}};
   return {data:args.p_session_id==='cs_new'}; // old evidence must not release a renewed allocation
  }
  if(name==='claim_abandoned_checkout')return {data:{should_send:true,email_event_id:'event',claim_token:'claim',payload:{stage:'abandoned_checkout_1'}}};
  if(name==='authorize_abandoned_checkout_v3')return {data:true};
  if(name==='finalize_abandoned_checkout_stage')return {};
  throw Error(`unexpected RPC ${name}`);
 }};
 return {calls,get sends(){return sends},run:()=>runAbandonedCheckoutRecovery({db,allowedDates:['Scheduled'],recoveryUrl:()=> 'https://example.invalid/pay',retrieveSession:async()=>session,sendEmail:async()=>{sends++;return {sent:true}}})};
}

test('recovery releases only provider-proven exact expired session before it claims a reminder',async()=>{
 const h=recoveryHarness(expired);
 const result=await h.run();
 assert.equal(result.sent,1);
 assert.equal(h.sends,1);
 assert.deepEqual(h.calls.map(([name])=>name),['list_abandoned_checkouts','read_abandoned_checkout_evidence','release_departure_capacity_if_safe','claim_abandoned_checkout','authorize_abandoned_checkout_v3','finalize_abandoned_checkout_stage']);
 assert.deepEqual(h.calls[2][1],{p_booking_id:'booking-1',p_session_id:'cs_old',p_provider_terminal:'expired'});
 assert.ok(!h.calls.some(([name,args])=>name==='release_departure_capacity_if_safe'&&args.p_session_id==='cs_new'));
});

test('recovery release RPC failure is unknown evidence and never claims or sends',async()=>{
 const h=recoveryHarness(expired,{releaseError:true});
 const result=await h.run();
 assert.equal(result.sent,0);
 assert.equal(h.sends,0);
 assert.equal(result.suppressed_reasons.evidence_unavailable,1);
 assert.ok(!h.calls.some(([name])=>name==='claim_abandoned_checkout'));
});

test('unknown provider evidence releases nothing and does not claim or retry-send',async()=>{
 const h=recoveryHarness({...expired,status:'open'});
 const result=await h.run();
 assert.equal(result.sent,0);
 assert.equal(h.sends,0);
 assert.equal(result.suppressed_reasons.session_not_expired,1);
 assert.ok(!h.calls.some(([name])=>name==='release_departure_capacity_if_safe'));
 assert.ok(!h.calls.some(([name])=>name==='claim_abandoned_checkout'));
});
