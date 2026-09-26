import test from 'node:test';
import assert from 'node:assert/strict';
import { runCapacityReconciliation } from '../lib/capacity-reconciliation.mjs';

const payment = { booking_id:'booking-payment', public_reference:'8L-PAYMENT', customer_id:'customer-1', email:null, reminder_eligibility:'ineligible', reminder_stage:'abandoned_checkout_2_completed', state:'payment', checkout_session_id:'cs-expired', payment_session_ids:['cs-expired'], allocated_at:'2026-09-26T10:00:00.000Z' };
const cancelled = { booking_id:'booking-cancelled', public_reference:'8L-CANCELLED', customer_id:'customer-2', state:'confirmed', booking_status:'cancelled', checkout_session_id:'cs-paid', payment_session_ids:['cs-paid'], allocated_at:'2026-09-26T10:01:00.000Z' };
function session(row, over={}) {
 return {id:row.checkout_session_id,client_reference_id:row.public_reference,metadata:{booking_id:row.booking_id,customer_id:row.customer_id},currency:'usd',payment_status:'unpaid',status:'expired',...over};
}
function harness(pages, sessions) {
 const calls=[];
 const db={rpc:async(name,args)=>{
  calls.push([name,args]);
  if(name==='list_departure_capacity_reconciliation_candidates') return {data:pages.shift() || []};
  if(name==='release_departure_capacity_if_safe' || name==='release_confirmed_departure_capacity_on_cancel') return {data:true};
  throw Error(`unexpected RPC ${name}`);
 }};
 return {calls,run:(over={})=>runCapacityReconciliation({db,retrieveSession:async id=>sessions[id],now:()=>new Date('2026-09-26T12:00:00.000Z'),...over})};
}

test('reconciliation releases no-email, ineligible, and after-stage2 expired holds outside reminder eligibility with bounded stable pagination',async()=>{
 const h=harness([[payment],[]],{'cs-expired':session(payment)});
 const result=await h.run();
 assert.equal(result.scanned,1);
 assert.equal(result.released_expired,1);
 assert.equal(result.released_cancelled_refunded,0);
 assert.deepEqual(h.calls.map(([name])=>name),['list_departure_capacity_reconciliation_candidates','release_departure_capacity_if_safe','list_departure_capacity_reconciliation_candidates']);
 assert.deepEqual(h.calls[1][1],{p_booking_id:'booking-payment',p_session_id:'cs-expired',p_provider_terminal:'expired'});
 assert.equal(h.calls[0][1].p_limit,50);
 assert.equal(h.calls[0][1].p_before_allocated_at,h.calls[1+1][1].p_before_allocated_at);
 assert.deepEqual(h.calls[2][1].p_after_booking_id,'booking-payment');
});

test('dry-run validates capacity candidates and reports releases without mutating',async()=>{
 const h=harness([[payment,cancelled],[]],{'cs-expired':session(payment),'cs-paid':session(cancelled,{payment_status:'paid',status:'complete',payment_intent:{latest_charge:{amount:99900,amount_refunded:99900}}})});
 const result=await h.run({dryRun:true});
 assert.equal(result.scanned,2);
 assert.equal(result.released_expired,1);
 assert.equal(result.released_cancelled_refunded,1);
 assert.ok(!h.calls.some(([name])=>name.startsWith('release_')));
});

test('unknown, paid, and processing payment allocation evidence is retained',async()=>{
 for(const candidate of [undefined,session(payment,{payment_status:'paid',status:'complete'}),session(payment,{payment_status:'unpaid',status:'open'})]) {
  const h=harness([[payment],[]],candidate?{'cs-expired':candidate}:{});
  const result=await h.run();
  assert.equal(result.released_expired,0);
  assert.ok(!h.calls.some(([name])=>name==='release_departure_capacity_if_safe'));
 }
});

test('only cancelled bookings with every exact related payment fully provider-refunded release confirmed capacity',async()=>{
 const refunded=session(cancelled,{payment_status:'paid',status:'complete',payment_intent:{latest_charge:{amount:99900,amount_refunded:99900}}});
 const h=harness([[cancelled],[]],{'cs-paid':refunded});
 const result=await h.run();
 assert.equal(result.released_cancelled_refunded,1);
 assert.deepEqual(h.calls.find(([name])=>name==='release_confirmed_departure_capacity_on_cancel')[1],{p_booking_id:'booking-cancelled',p_provider_terminal:'cancelled_refunded'});
 const refundOnly={...cancelled,booking_id:'booking-refund-only',public_reference:'8L-REFUND-ONLY',booking_status:'confirmed'};
 const h2=harness([[refundOnly],[]],{'cs-paid':session(refundOnly,{payment_status:'paid',status:'complete',payment_intent:{latest_charge:{amount:99900,amount_refunded:99900}}})});
 const r2=await h2.run();
 assert.equal(r2.released_cancelled_refunded,0);
 assert.ok(!h2.calls.some(([name])=>name==='release_confirmed_departure_capacity_on_cancel'));
});
