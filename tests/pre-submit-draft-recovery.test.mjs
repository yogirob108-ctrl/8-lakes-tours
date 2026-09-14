import test from 'node:test';
import assert from 'node:assert/strict';

// A draft abandoned before Book & pay has no booking/session, yet must enter a
// separate delayed queue and receive one opaque, draft-bound recovery link.
test('pre-submit draft recovery queues only inactive eligible drafts and dry-run never sends', async () => {
 const { runPreSubmitDraftRecovery } = await import('../lib/pre-submit-draft-recovery.mjs');
 const calls=[];
 const db={rpc:async(name,args)=>{
   calls.push([name,args]);
   if(name==='list_abandoned_public_checkout_drafts') return {data:[
     {draft_id:'11111111-1111-4111-8111-111111111111',email:'guest@example.invalid',first_name:'Guest'},
   ],error:null};
   throw Error(`unexpected ${name}`);
 }};
 const result=await runPreSubmitDraftRecovery({db,recoveryUrl:token=>`https://www.8lakestours.com/resume-draft?token=${token}`,sendEmail:async()=>{throw Error('must not send');},dryRun:true});
 assert.deepEqual(result,{eligible:1,sent:0,failed:0,suppressed:0});
 assert.deepEqual(calls,[['list_abandoned_public_checkout_drafts',undefined]]);
});

test('pre-submit recovery email is draft-bound and never places intake data in its URL', async () => {
 const { draftRecoveryEmail } = await import('../lib/pre-submit-draft-recovery.mjs');
 const email=draftRecoveryEmail({email:'guest@example.invalid',first_name:'Guest'},'https://www.8lakestours.com/resume-draft?token=opaque-token');
 assert.equal(email.to,'guest@example.invalid');
 assert.equal(email.subject,'Continue your 8 Lakes booking');
 assert.match(email.text,/opaque-token/);
 assert.doesNotMatch(email.text,/guest@example\.invalid.*resume-draft/);
});

test('recovery route and client exchange the opaque token without retaining it in a URL', async () => {
 const source=await import('node:fs/promises').then(fs=>fs.readFile(new URL('../app/HomePageClient.tsx',import.meta.url),'utf8'));
 const route=await import('node:fs/promises').then(fs=>fs.readFile(new URL('../app/resume-draft/route.ts',import.meta.url),'utf8'));
 assert.match(route,/Cache-Control.*no-store/);
 assert.match(route,/destination\.hash.*resume=/);
 assert.match(source,/hashParams\.get\('resume'\)/);
 assert.match(source,/history\.replaceState/);
 assert.match(source,/action:\s*'recover'/);
});
