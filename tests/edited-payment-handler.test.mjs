// Actual webhook; only database transport/email/analytics boundaries replaced.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import vm from 'node:vm';
import ts from 'typescript';
import * as matching from '../lib/stripe-payment-match.mjs';
test('edited booking records actual old pending Session money, no confirmation; completed replay no-ops',async()=>{
 const booking={id:'b',customer_id:'c',public_reference:'REF',status:'awaiting_payment',tour_date:'Scheduled',guest_count:3,online_due_usd:4000,online_paid_usd:0,customer:{email:'fixture@example.invalid'}};
 const payment={id:'p',booking_id:'b',amount_usd:2922,status:'pending',stripe_checkout_session_id:'cs_old',stripe_payment_intent_id:null,raw_event:{}};
 const rows={bookings:[booking],payments:[payment],booking_events:[],email_events:[]};
 let sends=0,writes=0;
 const db={rpc:async(n)=>{
  if(n==='reconcile_paid_booking_v2'){booking.online_paid_usd=2922;return {data:2922};}
  if(n==='confirm_paid_booking_v2')return {data:{allowed:false,status:booking.status}};
  throw Error(n);
 },from(table){let filters=[],mutation=null,single=false;const q={
 select(){return q;},eq(k,v){filters.push(r=>k.startsWith('raw_event->>')?r.raw_event[k.slice(12)]===v:r[k]===v);return q;},is(k,v){filters.push(r=>k.startsWith('raw_event->>')?(r.raw_event[k.slice(12)]??null)===v:(r[k]??null)===v);return q;},neq(k,v){filters.push(r=>r[k]!==v);return q;},in(k,vs){filters.push(r=>vs.includes(r[k]));return q;},contains(k,v){filters.push(r=>Object.entries(v).every(([a,b])=>r[k]?.[a]===b));return q;},limit(){return q;},or(){return q;},single(){single=true;return q;},maybeSingle(){single=true;return q;},update(v){mutation=['update',v];return q;},insert(v){mutation=['insert',v];return q;},then(resolve){let found=rows[table].filter(r=>filters.every(f=>f(r)));if(mutation){writes++;if(mutation[0]==='insert'){const row={id:'event-'+writes,...mutation[1]};rows[table].push(row);found=[row];}else for(const r of found)Object.assign(r,mutation[1]);}resolve({data:single?(found[0]??null):found,error:null});}};return q;}};
 const file='app/api/stripe/webhook/route.ts';
 const source=(process.env.REVIEW_RED==='1'?execFileSync('git',['show','336fcddf85079b9f017169b8fc318cfa7c4710e6:'+file],{encoding:'utf8'}):readFileSync(new URL('../'+file,import.meta.url),'utf8'))+'\nexport {handleCheckoutSessionPaid};';
 const exports={};
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{exports,process:{env:{}},crypto:{randomUUID:()=> 'token'},console:{info(){},warn(){}},require(n){if(n==='stripe')return {default:class{}};if(n==='@/lib/supabase-admin')return {createSupabaseAdminClient:()=>db};if(n==='@/lib/ops-config')return {isSupabaseAdminConfigured:true};if(n==='@/lib/stripe-payment-match.mjs')return matching;if(n==='@/lib/tour-booking.mjs')return {canAutomaticallyConfirmBooking:()=>true};if(n==='@/lib/email')return {getInternalEmailRecipients:()=>[],paymentConfirmedCustomerEmail:()=>({}),sendEmail:async()=>{sends++;return {sent:true};}};return {};}});
 const session={id:'cs_old',payment_status:'paid',amount_total:292200,currency:'usd',payment_intent:'pi_old',client_reference_id:'REF',metadata:{booking_id:'b',customer_id:'c',guest_count:'3'}};
 await exports.handleCheckoutSessionPaid(session);
 assert.equal(payment.status,'paid');assert.equal(payment.amount_usd,2922);assert.equal(booking.online_paid_usd,2922);
 assert.equal(booking.status,'awaiting_payment');assert.equal(sends,0);
 assert.ok(rows.booking_events.some(e=>e.title==='Stripe payment received — manual confirmation required'));
 assert.equal(payment.raw_event.processing_complete,true);
 const before=writes;booking.online_due_usd=5000;
 await exports.handleCheckoutSessionPaid(session);assert.equal(writes,before);assert.equal(sends,0);
});
