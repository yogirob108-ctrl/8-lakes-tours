import test from 'node:test';
import assert from 'node:assert/strict';
import { runCapacityReconciliation } from '../lib/capacity-reconciliation.mjs';

const payment = { booking_id:'booking-payment', public_reference:'8L-PAYMENT', customer_id:'customer-1', state:'payment', checkout_session_id:'cs-expired', payment_session_ids:['cs-expired'], allocated_at:'2026-09-26T10:00:00.000Z' };
const cancelled = { booking_id:'booking-cancelled', public_reference:'8L-CANCELLED', customer_id:'customer-2', state:'confirmed', booking_status:'cancelled', checkout_session_id:'cs-paid', payment_session_ids:['cs-paid'], allocated_at:'2026-09-26T10:01:00.000Z' };
function session(row, id=row.checkout_session_id, over={}) {
 return {id,client_reference_id:row.public_reference,metadata:{booking_id:row.booking_id,customer_id:row.customer_id},currency:'usd',payment_status:'unpaid',status:'expired',...over};
}
function harness(pages, sessions, releases={}) {
 const calls=[];
 const db={rpc:async(name,args)=>{
  calls.push([name,args]);
  if(name==='list_departure_capacity_reconciliation_candidates') return {data:pages.shift() || []};
  if(name.startsWith('release_')) return releases[name] ?? {data:true};
  throw Error(`unexpected RPC ${name}`);
 }};
 return {calls,run:(over={})=>runCapacityReconciliation({db,retrieveSession:async id=>sessions[id],now:()=>new Date('2026-09-26T12:00:00.000Z'),...over})};
}

test('reconciliation releases an exact expired payment allocation with bounded stable pagination',async()=>{
 const h=harness([[payment],[]],{'cs-expired':session(payment)});
 const result=await h.run();
 assert.deepEqual(result,{scanned:1,would_release_expired:1,would_release_cancelled_refunded:0,released_expired:1,released_cancelled_refunded:0,retained:0,provider_errors:0});
 assert.deepEqual(h.calls.map(([name])=>name),['list_departure_capacity_reconciliation_candidates','release_departure_capacity_if_all_expired_safe','list_departure_capacity_reconciliation_candidates']);
 assert.deepEqual(h.calls[1][1],{p_booking_id:'booking-payment',p_expired_session_ids:['cs-expired'],p_provider_terminal:'expired'});
 assert.equal(h.calls[0][1].p_limit,50);
 assert.equal(h.calls[0][1].p_before_allocated_at,h.calls[2][1].p_before_allocated_at);
 assert.deepEqual(h.calls[2][1].p_after_booking_id,'booking-payment');
});

test('payment allocation releases only when every related exact session is expired unpaid and includes allocated session',async()=>{
 const renewed={...payment,payment_session_ids:['cs-old','cs-expired']};
 const h=harness([[renewed],[]],{'cs-old':session(renewed,'cs-old'),'cs-expired':session(renewed)});
 const result=await h.run();
 assert.equal(result.released_expired,1);
 assert.deepEqual(h.calls.find(([name])=>name.startsWith('release_'))[1].p_expired_session_ids,['cs-expired','cs-old']);
 for(const bad of [
  {...renewed,payment_session_ids:['cs-old']},
  {...renewed,payment_session_ids:['cs-old','cs-expired'],checkout_session_id:'cs-missing'},
 ]) {
  const r=await harness([[bad],[]],{'cs-old':session(bad,'cs-old'),'cs-expired':session(bad)}).run();
  assert.equal(r.released_expired,0);
  assert.equal(r.retained,1);
 }
 for(const badSession of [session(renewed,'cs-old',{status:'open'}),session(renewed,'cs-old',{payment_status:'paid',status:'complete'}),undefined]) {
  const r=await harness([[renewed],[]],{'cs-old':badSession,'cs-expired':session(renewed)}).run();
  assert.equal(r.released_expired,0);
  assert.equal(r.retained,1);
 }
});

test('dry-run reports would-release separately without mutating',async()=>{
 const h=harness([[payment,cancelled],[]],{'cs-expired':session(payment),'cs-paid':session(cancelled,'cs-paid',{payment_status:'paid',status:'complete',payment_intent:{latest_charge:{amount:99900,amount_refunded:99900}}})});
 const result=await h.run({dryRun:true});
 assert.equal(result.would_release_expired,1);
 assert.equal(result.would_release_cancelled_refunded,1);
 assert.equal(result.released_expired,0);
 assert.equal(result.released_cancelled_refunded,0);
 assert.ok(!h.calls.some(([name])=>name.startsWith('release_')));
});

test('cancelled confirmed allocation permits old expired unpaid plus latest fully refunded exact payment',async()=>{
 const mixed={...cancelled,payment_session_ids:['cs-old','cs-paid']};
 const h=harness([[mixed],[]],{
  'cs-old':session(mixed,'cs-old'),
  'cs-paid':session(mixed,'cs-paid',{payment_status:'paid',status:'complete',payment_intent:{latest_charge:{amount:99900,amount_refunded:99900}}}),
 });
 const result=await h.run();
 assert.equal(result.released_cancelled_refunded,1);
 assert.deepEqual(h.calls.find(([name])=>name==='release_confirmed_departure_capacity_on_cancel_if_safe')[1],{p_booking_id:'booking-cancelled',p_expired_session_ids:['cs-old'],p_refunded_session_ids:['cs-paid'],p_provider_terminal:'cancelled_refunded'});
});

test('release false or error remains retained and never reports success',async()=>{
 for(const outcome of [{data:false},{error:{message:'locked'}}]) {
  const h=harness([[payment],[]],{'cs-expired':session(payment)},{release_departure_capacity_if_all_expired_safe:outcome});
  const result=await h.run();
  assert.equal(result.would_release_expired,1);
  assert.equal(result.released_expired,0);
  assert.equal(result.retained,1);
  assert.equal(result.provider_errors, outcome.error ? 1 : 0);
 }
});

test('unknown, paid, and processing evidence is retained',async()=>{
 for(const candidate of [undefined,session(payment,'cs-expired',{payment_status:'paid',status:'complete'}),session(payment,'cs-expired',{payment_status:'unpaid',status:'open'})]) {
  const h=harness([[payment],[]],candidate?{'cs-expired':candidate}:{});
  const result=await h.run();
  assert.equal(result.released_expired,0);
  assert.equal(result.retained,1);
  assert.ok(!h.calls.some(([name])=>name.startsWith('release_')));
 }
});
