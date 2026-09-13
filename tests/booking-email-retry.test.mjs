import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as crypto from 'node:crypto';
import * as normalizer from '../lib/public-booking.mjs';
import * as pricing from '../lib/group-pricing.mjs';

function harness({created=false, fail=false, conflict=false, manual=true}={}) {
 const calls=[], sent=[], events=new Map();
 const db={rpc:async(name,args)=>{
  calls.push(name);
  if(name==='consume_public_booking_rate_limits')return {data:{allowed:true}};
  if(name==='create_public_booking'){if(conflict)return {error:{message:'submission key already belongs to a different booking payload'}};const first=created;created=false;return {data:{booking_id:'b',customer_id:'c',public_reference:'8L-ABCDEFG',created:first}};}
  if(name.startsWith('claim_public_booking_email')) {
   const key=args.p_template_key;
   const previous=events.get(key);
   if(previous?.status==='sent'||previous?.status==='queued')return {data:{should_send:false}};
   const row={email_event_id:key,should_send:true,claim_token:'claim',payload:previous?.payload??args.p_payload,status:'queued'};
   events.set(key,row);return {data:row};
  }
  if(name.startsWith('finalize_public_booking_email')) {events.get(args.p_email_event_id).status=args.p_sent?'sent':'failed';return {data:null};}
  throw Error(name);
 }};
 const content={subject:'Booking received',text:'Saved',html:'Saved'};
 const code=ts.transpileModule(readFileSync(new URL('../app/api/bookings/route.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
 const exports={};
 vm.runInNewContext(code,{exports,TextEncoder,process:{env:{SUPABASE_SERVICE_ROLE_KEY:'test-only'}},require(name){
  if(name==='node:crypto')return crypto;
  if(name==='next/server')return {NextResponse:{json:(body,init)=>({body,...init})}};
  if(name==='@/lib/ops-config')return {isSupabaseAdminConfigured:true};
  if(name==='@/lib/supabase-admin')return {createSupabaseAdminClient:()=>db};
  if(name==='@/lib/public-booking.mjs')return normalizer;
  if(name==='@/lib/group-pricing.mjs')return pricing;
  if(name==='@/lib/booking-checkout')return {recoveryUrl:()=>'/pay/private'};
  if(name==='@/lib/newsletter')return {};
  if(name==='@/lib/newsletter-consent.mjs')return {hasExplicitNewsletterOptIn:()=>false};
  if(name==='@/lib/tour-booking.mjs')return {isBookableTourDate:()=>true,requiresManualPaymentLink:()=>manual,manualPaymentReason:()=>null};
  if(name==='@/lib/email')return {bookingCustomerEmail:()=>content,bookingInternalEmail:()=>content,getInternalEmailRecipients:()=>['ops@example.invalid'],sendEmail:async input=>{sent.push(input);return fail?{sent:false,error:'fault'}:{sent:true,id:'provider'};}};
  throw Error(name);
 }});
 const body={submission_key:'123e4567-e89b-42d3-a456-426614174111',tour_date:'scheduled',guest_count:1,signature:'Test Guest',travellers:[{first_name:'Test',last_name:'Guest',email:'test@example.invalid',nationality:'Testland',date_of_birth:'1990-01-01',riding_experience:'Beginner — little to none'}]};
 return {calls,sent,events,recover(){fail=false;},run:()=>exports.POST(new Request('https://example.invalid',{method:'POST',body:JSON.stringify(body)}))};
}
test('changed retry returns a conflict instead of a saved tick',async()=>{
 const h=harness({conflict:true});const response=await h.run();assert.equal(response.status,409);assert.equal(response.body.ok,false);assert.equal(h.sent.length,0);
});
test('retry after booking commit resumes both initial notifications once',async()=>{
 const h=harness();assert.equal((await h.run()).body.ok,true);assert.equal(h.sent.length,2);
 await h.run();assert.equal(h.sent.length,2);
});
test('failed initial notifications are recoverable on an identical retry',async()=>{
 const h=harness({created:true,fail:true});await h.run();assert.equal(h.sent.length,2);
 h.recover();await h.run();assert.equal(h.sent.length,4);await h.run();assert.equal(h.sent.length,4);
});

test('scheduled intake is silent to customer until delayed recovery or verified payment',async()=>{const h=harness({created:true,manual:false});await h.run();assert.equal(h.sent.length,1);assert.equal(h.sent[0].to[0],'ops@example.invalid');});
