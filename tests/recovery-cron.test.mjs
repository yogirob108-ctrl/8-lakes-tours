import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import ts from 'typescript';
import * as crypto from 'node:crypto';
import {readFileSync} from 'node:fs';
import * as dates from '../lib/tour-dates.mjs';
import * as booking from '../lib/tour-booking.mjs';
function harness(postSubmitEnabled='true',preSubmitEnabled='false') {
 const exports={},calls=[];
 const code=ts.transpileModule(readFileSync(new URL('../app/api/cron/abandoned-checkouts/route.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
 vm.runInNewContext(code,{exports,Buffer,Response,process:{env:{CRON_SECRET:'local-only',STRIPE_SECRET_KEY:'local-fixture',ABANDONED_CHECKOUT_RECOVERY_ENABLED:postSubmitEnabled,PRE_SUBMIT_DRAFT_RECOVERY_ENABLED:preSubmitEnabled}},require(name){
 if(name==='stripe')return {default:class{}};
 if(name==='node:crypto')return crypto;
 if(name==='@/lib/tour-dates.mjs')return dates;
 if(name==='@/lib/tour-booking.mjs')return booking;
 if(name==='@/lib/supabase-admin')return {createSupabaseAdminClient:()=>({})};
 if(name==='@/lib/booking-checkout')return {recoveryUrl:()=>''};
 if(name==='@/lib/email')return {sendEmail:()=>{throw Error('must not send');}};
 if(name==='@/lib/abandoned-checkout.mjs')return {runAbandonedCheckoutRecovery:async({allowedDates})=>{calls.push(['booking',allowedDates]);return {sent:0};}};
 if(name==='@/lib/pre-submit-draft-recovery.mjs')return {runPreSubmitDraftRecovery:async({dryRun})=>{calls.push(['draft',dryRun]);return {eligible:0,sent:0,failed:0,suppressed:0};}};
 throw Error(name);
 }});
 return {calls,run:(auth='Bearer local-only',url='https://example.invalid')=>exports.GET(new Request(url,{headers:{authorization:auth}}))};
}
test('cron rejects missing credentials',async()=>{const h=harness();assert.equal((await h.run('')).status,401);assert.equal(h.calls.length,0);});
test('post-submit cron requires explicit rollout enablement',async()=>{const h=harness('false','false');assert.equal((await h.run()).status,200);assert.equal(h.calls.length,0);});
test('enabled post-submit cron never calls pre-submit draft recovery unless its separate flag is enabled',async()=>{const h=harness('true','false');assert.equal((await h.run()).status,200);assert.deepEqual(h.calls.map(([kind])=>kind),['booking']);});
test('enabled cron uses only current approved scheduled inventory',async()=>{const h=harness();assert.equal((await h.run()).status,200);const bookingCall=h.calls.find(([kind])=>kind==='booking');assert.ok(bookingCall[1].length);for(const date of bookingCall[1])assert.equal(booking.canAutomaticallyConfirmBooking(date,1),true);});
test('authenticated dry run evaluates post-submit and pre-submit queues without sending regardless of rollout flags',async()=>{const h=harness('false','false');assert.equal((await h.run('Bearer local-only','https://example.invalid?dry_run=1')).status,200);assert.deepEqual(h.calls.map(([kind])=>kind),['draft','booking']);});
