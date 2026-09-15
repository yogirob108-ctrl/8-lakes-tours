import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as crypto from 'node:crypto';

// Harness for the narrow operator-approved bind action. Stripe is a fixture:
// no network, no live keys in tests. The route must verify the EXACT invoice
// (paid, usd, expected amount, expected customer email, zero refunds, one
// succeeded canonical PaymentIntent) before any write.
function harness({invoice, intents, db, env={}}={}) {
  const stripeCalls=[];
  const code=ts.transpileModule(readFileSync(new URL('../app/api/ops/bind-approved-payment/route.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
  const exports={};
  vm.runInNewContext(code,{exports,Buffer,Response,Request,process:{env:{CRON_SECRET:'local-only',STRIPE_SECRET_KEY:'local-fixture',...env}},require(name){
    // Mirror the real CommonJS stripe package: module itself is the constructor,
    // so __importDefault returns it unchanged and `.default` resolves to it.
    const StripeModule=class{constructor(_k,_o){this.invoices={retrieve:async()=>{stripeCalls.push('invoice');return invoice;}};this.paymentIntents={list:async q=>{stripeCalls.push('intent');return {data:intents,has_more:false};}};}};
    StripeModule.default=StripeModule;
    if(name==='stripe')return StripeModule;
    if(name==='node:crypto')return crypto;
    if(name==='next/server')return {NextResponse:{json:(body,init)=>({status:init?.status??200,body})}};
    if(name==='@/lib/supabase-admin')return {createSupabaseAdminClient:()=>db};
    throw Error(name);
  }});
  // Mirror a real HTTP client: the route returns the platform Response
  // (global Response.json), so the JSON body must be read off the stream.
  const run=async(body,auth='Bearer local-only')=>{
    const response=await exports.POST(new Request('https://example.invalid',{method:'POST',headers:{authorization:auth,'content-type':'application/json'},body:JSON.stringify(body)}));
    return {status:response.status,body:await response.json()};
  };
  return {run,stripeCalls};
}

const verifiedIntent={id:'pi_canonical',status:'succeeded',amount:99900,currency:'usd',amount_received:99900};
// Provider-faithful paid invoice: the route derives the canonical PaymentIntent
// from the expanded payments collection, exactly as stripe.invoices.retrieve
// with expand=['payments.data.payment.payment_intent'] returns it.
const okInvoice={id:'in_1UF8Z03OYuYvjeqEXk3sNFbD',status:'paid',amount_paid:99900,currency:'usd',customer_email:'davide@example.test',amount_remaining:0,status_transitions:{paid_at:1758000000},payments:{data:[{payment:{type:'payment_intent',payment_intent:{id:'pi_canonical',object:'payment_intent'}}}]}};

function dbHarness(){ 
  const calls=[];
  return {calls,rpc:async(name,args)=>{calls.push({name,args});return {data:{bound:true,binding_id:'bdg',payment_id:'pay',event_id:'evt'},error:null};}};
}

test('bind action rejects unauthorized callers',async()=>{
  const h=harness({invoice:okInvoice,intents:[verifiedIntent],db:dbHarness()});
  const r=await h.run({},'Bearer wrong');
  assert.equal(r.status,401);
  assert.deepEqual(h.stripeCalls,[]);
});

test('bind action verifies the exact paid invoice and canonical intent before writing',async()=>{
  const db=dbHarness();
  const h=harness({invoice:okInvoice,intents:[verifiedIntent],db});
  const r=await h.run({bookingId:'b1',provider_object_id:'in_1UF8Z03OYuYvjeqEXk3sNFbD',approvedBy:'operator',expected:{amountCents:99900,customerEmail:'davide@example.test'}});
  assert.equal(r.status,200);
  assert.equal(r.body.ok,true);
  const call=db.calls.find(c=>c.name==='bind_approved_payment');
  assert.ok(call,'bind rpc must run');
  assert.equal(call.args.p_payment_intent_id,'pi_canonical');
  assert.equal(call.args.p_amount_usd,999);
});

test('bind action refuses an unpaid, refunded, mismatched or absent invoice without any write',async()=>{
  const cases=[
    [{...okInvoice,status:'open'},[verifiedIntent]],
    [{...okInvoice,amount_paid:99899},[verifiedIntent]],
    [{...okInvoice,currency:'eur'},[verifiedIntent]],
    [{...okInvoice,amount_due:99900},[verifiedIntent]], // amount_paid missing
  ];
  for(const [invoice,intents] of cases){
    const db=dbHarness();
    const h=harness({invoice,intents,db});
    const r=await h.run({bookingId:'b1',provider_object_id:'in_x',approvedBy:'operator',expected:{amountCents:99900,customerEmail:'davide@example.test'}});
    assert.equal(r.status,422,JSON.stringify(r.body));
    assert.deepEqual(db.calls,[],'no DB write for unverified invoice');
  }
});

test('bind action refuses invoice whose canonical intent is not a single succeeded match',async()=>{
  for(const intents of [[], [verifiedIntent,{...verifiedIntent,id:'pi_two'}], [{...verifiedIntent,id:'pi_canceled',status:'canceled'}]]){
    const db=dbHarness();
    const h=harness({invoice:{...okInvoice,payments:{data:[{payment:{type:'payment_intent',payment_intent:{id:'pi_missing',object:'payment_intent'}}}]}},intents,db});
    const r=await h.run({bookingId:'b1',provider_object_id:'in_x',approvedBy:'operator',expected:{amountCents:99900,customerEmail:'davide@example.test'}});
    assert.equal(r.status,422);
    assert.deepEqual(db.calls,[]);
  }
});

test('bind action refuses customer-email mismatch and refund evidence without any write',async()=>{
  const db=dbHarness();
  const h=harness({
    invoice:{...okInvoice,customer_email:'other@example.test',payment_intent:{id:'pi_canonical',object:'payment_intent'}},
    intents:[{...verifiedIntent,receipt_email:'other@example.test'}],db});
  const r=await h.run({bookingId:'b1',provider_object_id:'in_x',approvedBy:'operator',expected:{amountCents:99900,customerEmail:'davide@example.test'}});
  assert.equal(r.status,422);
  assert.deepEqual(db.calls,[]);
});
