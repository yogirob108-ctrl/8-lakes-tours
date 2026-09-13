// Pair-bound integration: actual Site paid/refund handlers and actual Ops deletion.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {fixture,sql,lit,adapter} from './payment-dispatch-postgres.integration.mjs';
async function deletion(h){
 const project=await sql(`select project_id from bookings where id=${lit(h.b)}`),exports={};
 const path=(process.env.OPS_DELETE_ROOT||'/tmp/8l-checkout-audit-ops')+'/app/ops/actions.ts';
 const db=adapter({});
 vm.runInNewContext(ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{exports,process:{env:{}},console,require(n){
 if(n==='next/cache')return {revalidatePath(){}};
 if(n==='next/navigation')return {redirect:p=>{throw new Error('REDIRECT '+p);}};
 if(n==='@/lib/ops-pin')return {requireOpsPinSession:async()=>{}};
 if(n==='@/lib/ops-project-scope.mjs')return {resolveOpsProjectId:async()=>project};
 if(n==='@/lib/ops-config')return {isSupabaseAdminConfigured:true};
 if(n==='@/lib/supabase-admin')return {createSupabaseAdminClient:()=>db};
 return {};
 }});
 return exports.deleteBookingRecord(h.id);
}
test('actual confirmation-first holds deletion, then refund still commits',()=>fixture(async h=>{
 h.afterConfirm=async()=>{await assert.rejects(deletion(h),/confirmation_in_progress/);await h.refund();};
 await h.paid();const r=await h.read();assert.equal(h.sends,0);assert.equal(r.paid,0);assert.equal(r.payment.status,'refunded');
 await assert.rejects(deletion(h),/REDIRECT \/bookings\?saved=deleted$/);
 assert.equal(await sql(`select count(*) from bookings where id=${lit(h.b)}`),'0');
}));
test('actual dispatch-first and token revocation keep deletion blocked until outcome',()=>fixture(async h=>{
 h.onSend=async()=>{await h.refund();await assert.rejects(deletion(h),/confirmation_in_progress/);};
 await h.paid();const r=await h.read();assert.equal(h.sends,1);assert.equal(r.paid,0);assert.equal(r.dispatch[0].status,'accepted');
 await assert.rejects(deletion(h),/REDIRECT \/bookings\?saved=deleted$/);
}));
test('actual deletion-first prevents later webhook confirmation/dispatch',()=>fixture(async h=>{
 await assert.rejects(deletion(h),/REDIRECT \/bookings\?saved=deleted$/);
 // No extant booking can authorize a confirmation, even if Stripe replays.
 try{await h.paid();}catch(e){assert.match(e.message,/booking|Booking|payment|Payment/);}
 assert.equal(h.sends,0);assert.equal(await sql(`select count(*) from bookings where id=${lit(h.b)}`),'0');
 assert.equal(await sql(`select count(*) from payment_confirmation_dispatch where booking_id=${lit(h.b)}`),'0');
}));
