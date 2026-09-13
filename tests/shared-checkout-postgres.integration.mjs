// Real local PostgreSQL + BOTH actual application entry points. Only provider,
// Supabase transport, authentication and Next redirect/cache boundaries replaced.
// Run explicitly: node --test tests/shared-checkout-postgres.integration.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as payload from '../lib/public-checkout.mjs';

const exec=promisify(execFile);
const DSN=process.env.OPS_TEST_DATABASE_URL??'postgresql://localhost:55432/8l_test';
assert.match(DSN,/^postgresql:\/\/(localhost|127\.0\.0\.1):\d+\/8l_test$/);
const lit=v=>v===null?'null':"'"+String(v).replaceAll("'","''")+"'";
const json=v=>lit(JSON.stringify(v))+'::jsonb';
async function sql(query){const {stdout}=await exec('psql',[DSN,'-XqAt','-v','ON_ERROR_STOP=1','-c',"set request.jwt.claim.role='service_role'; "+query]);return stdout.trim().split('\n').at(-1);}
const rpcArgs={prepare_booking_checkout:a=>[lit(a.p_booking_id),json(a.p_expected),json(a.p_spec),`array[${a.p_expired_sessions.map(lit).join(',')}]::text[]`,lit(a.p_reuse_session)],finalize_booking_checkout:a=>[lit(a.p_booking_id),lit(a.p_key),lit(a.p_session_id),lit(a.p_url),a.p_expires_at??'null'],prepare_public_checkout:a=>[lit(a.p_booking_id),lit(a.p_predecessor),json(a.p_expected),json(a.p_spec)]};
function dbAdapter(){return {async rpc(name,args){try{const result=await sql(`select to_jsonb(${name}(${rpcArgs[name](args).join(',')}))`);return {data:JSON.parse(result)};}catch(e){return {error:{message:e.message}};}},from(table){
 const filters=[];let cols='*',one=false,insert;
 const q={select(c){cols=c;return q;},eq(k,v){filters.push(`${k}=${lit(v)}`);return q;},order(){return q;},single(){one=true;return q;},insert(v){insert=v;return q;},async then(resolve){try{
  if(insert){const keys=Object.keys(insert);await sql(`insert into ${table}(${keys.join(',')}) values(${keys.map(k=>typeof insert[k]==='object'?json(insert[k]):lit(insert[k])).join(',')})`);return resolve({error:null});}
  let selection=cols;
  if(cols.includes('customers('))selection=cols.slice(0,cols.indexOf(',customers('))+",(select jsonb_build_object('first_name',c.first_name,'last_name',c.last_name,'email',c.email) from customers c where c.id=bookings.customer_id) customers";
  const result=JSON.parse(await sql(`select coalesce(jsonb_agg(row_to_json(t)),'[]') from (select ${selection} from ${table}${filters.length?' where '+filters.join(' and '):''}) t`));
  resolve({data:one?result[0]:result});
 }catch(e){resolve({error:{message:e.message,code:'fault'}});}}};return q;
 }};}
async function loadEntrypoints(db,stripe,project){
 const exported=[];
 for(const kind of ['site','ops']){
  const file=kind==='site'?'lib/booking-checkout.ts':'app/ops/actions.ts';
  const root=kind==='site'?new URL('../',import.meta.url).pathname:'/tmp/8l-booking-travellers-ops/';
  const shared=await import(new URL('file://'+root+'lib/shared-booking-checkout.mjs'));
  const source=process.env.REVIEW_BASELINE==='1'?(await exec('git',['show',`${kind==='site'?'2c7410d9a2bbf1100b1f025ff34420dc788c7104':'5bd7aaacc655f1bec99e3506065b082e81e0df25'}:${file}`],{cwd:root})).stdout:readFileSync(root+file,'utf8');
  const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
  const exports={};vm.runInNewContext(code,{exports,URLSearchParams,process:{env:{STRIPE_SECRET_KEY:'test-only',SUPABASE_SERVICE_ROLE_KEY:'test-only-secret'}},require(name){
   if(name==='stripe')return class {constructor(){return stripe;}};
   if(name.includes('shared-booking-checkout'))return shared;
   if(name.includes('supabase-admin'))return {createSupabaseAdminClient:()=>db};
   if(name.includes('public-checkout.mjs'))return payload;
   if(name.includes('tour-booking.mjs'))return {canAutomaticallyConfirmBooking:d=>d==='scheduled'};
   if(name==='next/cache')return {revalidatePath:()=>{}};
   if(name==='next/navigation')return {redirect:url=>{throw Error('REDIRECT:'+url);}};
   if(name.includes('ops-config'))return {isSupabaseAdminConfigured:true};
   if(name.includes('ops-pin'))return {requireOpsPinSession:async()=>{}};
   if(name.includes('ops-project-scope'))return {resolveOpsProjectId:async()=>project};
   if(name.includes('ops-email-drafts'))return {getCustomerFromBookingEmailContext:b=>({fullName:'Test Guest',email:b.customers.email})};
   return {};
  }});exported.push(exports);
 }
 return exported;
}
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
async function fixture(run){
 const project=await sql("select id from tour_projects where slug='8-lakes-tours'");
 const customer=await sql("insert into customers(first_name,last_name,email) values('Shared','Test','shared-entrypoints@example.invalid') returning id");
 let booking;
 try{
  booking=await sql(`insert into bookings(customer_id,project_id,public_reference,tour_date,guest_count,status,online_due_usd,online_paid_usd,total_trip_value_usd,family_cash_due_usd,submission_key) values(${lit(customer)},${lit(project)},'8L-ABCDEFG','scheduled',1,'awaiting_payment',999,0,1999,1000,gen_random_uuid()) returning id`);
  await sql(`insert into booking_travellers(booking_id,position,is_lead,first_name,last_name,email) values(${lit(booking)},1,true,'Shared','Test','shared-entrypoints@example.invalid')`);
  const sessions=new Map(),keys=new Map(),arrived=deferred(),release=deferred();let calls=0;
  const stripe={checkout:{sessions:{async create(spec,{idempotencyKey}={}){
   calls++;const key=idempotencyKey??'unkeyed-'+calls;
   if(!keys.has(key)){
    const session={id:'cs_entry_'+keys.size,url:'https://checkout.stripe.com/test',status:'open',payment_status:'unpaid',amount_total:spec.line_items[0].price_data.unit_amount,currency:'usd',client_reference_id:spec.client_reference_id,metadata:spec.metadata,expires_at:1999999999};
    keys.set(key,{spec,session});sessions.set(session.id,session);
   }else assert.deepEqual(keys.get(key).spec,spec,'provider idempotency requires identical payload');
   arrived.resolve();await release.promise;return keys.get(key).session;
  },async retrieve(id){assert.ok(sessions.has(id),id);return sessions.get(id);},async expire(id){sessions.get(id).status='expired';return sessions.get(id);}}}};
  const [site,ops]=await loadEntrypoints(dbAdapter(),stripe,project);
  const publicRun=()=>site.createBookingCheckout('8L-ABCDEFG',payload.paymentToken('8L-ABCDEFG','test-only-secret'));
  const opsRun=()=>ops.createStripeCheckoutForBooking('8L-ABCDEFG').catch(e=>{if(!e.message.includes('saved=payment_link_created'))throw e;return 'ops-saved';});
  await run({publicRun,opsRun,arrived,release,sessions,booking,keys});
 }finally{
  if(booking)await sql(`delete from payments where booking_id=${lit(booking)};delete from booking_events where booking_id=${lit(booking)};delete from bookings where id=${lit(booking)}`);
  await sql(`delete from customers where id=${lit(customer)}`);
  assert.equal(await sql("select count(*) from customers where email='shared-entrypoints@example.invalid'"),'0');
 }
}
for (const firstCreator of ['public','ops']) test(`actual ${firstCreator}-first public + Ops interleaving shares one frozen Stripe generation`,async()=>fixture(async h=>{
 const first=firstCreator==='public'?h.publicRun():h.opsRun();first.catch(()=>{});await h.arrived.promise;
 const second=firstCreator==='public'?h.opsRun():h.publicRun();second.catch(()=>{});await new Promise(r=>setTimeout(r,200));h.release.resolve();
 await Promise.all([first,second]);assert.equal(h.sessions.size,1);
 assert.equal(await sql(`select count(*) from payments where booking_id=${lit(h.booking)}`),'1');
}));
for(const creator of ['public','ops']) for(const writer of ['cancel','paid','foreign-pending'])test(`actual ${creator} finalization fences ${writer} before booking reconciliation`,async()=>fixture(async h=>{
 const attempt=creator==='public'?h.publicRun():h.opsRun();attempt.catch(()=>{});await h.arrived.promise;
 if(writer==='cancel')await sql(`update bookings set status='cancelled' where id=${lit(h.booking)}`);
 else await sql(`insert into payments(booking_id,provider,stripe_checkout_session_id,amount_usd,status) values(${lit(h.booking)},'stripe','cs_foreign',999,${lit(writer==='paid'?'paid':'pending')})`);
 h.release.resolve();await assert.rejects(attempt,/changed|review|not payable/);
 assert.equal([...h.sessions.values()][0].status,'expired');
}));
