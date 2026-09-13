import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as matching from '../lib/stripe-payment-match.mjs';
const code=ts.transpileModule(readFileSync(new URL('../app/api/stripe/webhook/route.ts',import.meta.url),'utf8')+'\nexport {handleCheckoutSessionPaid};',{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
async function probe(mode){
 const booking={id:'b',customer_id:'c',public_reference:'REF',status:'awaiting_payment',tour_date:'Scheduled',guest_count:mode==='guest-edit'?4:3,online_due_usd:2922,online_paid_usd:0,customer:{email:'fixture@example.invalid'}};
 const payment={id:'p',booking_id:'b',amount_usd:2922,status:'pending',stripe_checkout_session_id:'cs_old',stripe_payment_intent_id:null,raw_event:{}};
 const rows={bookings:[booking],payments:[payment],booking_events:[],email_events:[]};
 let sends=0,writes=0;
 const db={rpc:async(n)=>{
  if(n==='reconcile_paid_booking_v2'){booking.online_paid_usd=payment.status==='refunded'?0:2922;return {data:booking.online_paid_usd};}
  if(n==='confirm_paid_booking_v2'){
   booking.status='confirmed';booking.payment_confirmation_token='token';
   // Competing refund commits AFTER confirmation RPC but BEFORE first send.
   payment.status='refunded';payment.refunded_at=new Date().toISOString();payment.raw_event.cumulative_refunded_usd=2922;booking.online_paid_usd=0;
   return {data:{allowed:true,status:'confirmed',online_paid_usd:2922}};
  }
  throw Error(n);
 },from(table){let filters=[],mutation=null,single=false;const q={select(){return q;},eq(k,v){filters.push(r=>k.startsWith('raw_event->>')?r.raw_event[k.slice(12)]===v:r[k]===v);return q;},is(k,v){filters.push(r=>k.startsWith('raw_event->>')?(r.raw_event[k.slice(12)]??null)===v:(r[k]??null)===v);return q;},in(k,vs){filters.push(r=>vs.includes(r[k]));return q;},contains(k,v){filters.push(r=>Object.entries(v).every(([a,b])=>r[k]?.[a]===b));return q;},limit(){return q;},single(){single=true;return q;},maybeSingle(){single=true;return q;},update(v){mutation=['update',v];return q;},insert(v){mutation=['insert',v];return q;},then(resolve){let found=rows[table].filter(r=>filters.every(f=>f(r)));if(mutation){writes++;if(mutation[0]==='insert'){const row={id:'event-'+writes,...mutation[1]};rows[table].push(row);found=[row];}else for(const r of found)Object.assign(r,mutation[1]);}resolve({data:single?(found[0]??null):found,error:null});}};return q;}};
 const exports={};vm.runInNewContext(code,{exports,process:{env:{}},crypto:{randomUUID:()=> 'token'},console:{info(){},warn(){}},require(n){if(n==='stripe')return {default:class{}};if(n==='@/lib/supabase-admin')return {createSupabaseAdminClient:()=>db};if(n==='@/lib/ops-config')return {isSupabaseAdminConfigured:true};if(n==='@/lib/stripe-payment-match.mjs')return matching;if(n==='@/lib/tour-booking.mjs')return {canAutomaticallyConfirmBooking:()=>true};if(n==='@/lib/email')return {getInternalEmailRecipients:()=>[],paymentConfirmedCustomerEmail:()=>({subject:'confirmed',text:'confirmed'}),sendEmail:async()=>{sends++;return {sent:true};}};return {};}});
 await exports.handleCheckoutSessionPaid({id:'cs_old',payment_status:'paid',amount_total:292200,currency:'usd',payment_intent:'pi_old',client_reference_id:'REF',metadata:{booking_id:'b',customer_id:'c',guest_count:'3'}});
 assert.equal(sends,0,'refund committed before provider call must suppress ordinary confirmation'); assert.equal(booking.online_paid_usd,0); assert.equal(payment.status,'refunded'); assert.ok(rows.booking_events.some(e=>e.title.includes('manual confirmation')));
}
await probe('confirmation-then-refund');
