import {checkoutSpec} from './public-checkout.mjs';
export async function probe({authorized,stripe}) {
 if(!authorized)return {status:401,body:{ok:false}};
 let id,stage='create',observed;
 try {
  const spec=checkoutSpec({guest_count:1,online_due_usd:999,total_trip_value_usd:1999,family_cash_due_usd:1000,status:'awaiting_payment',online_paid_usd:0,public_reference:'8L-PROBE',id:'00000000-0000-4000-8000-000000000001',customer_id:'00000000-0000-4000-8000-000000000002'},'release-probe@example.com','https://www.8lakestours.com/');
  spec.metadata.source='release_verification_no_booking';spec.payment_intent_data.metadata.source='release_verification_no_booking';
  const session=await stripe.checkout.sessions.create(spec,{idempotencyKey:'8l-release-provider-probe-20260914-v1'});id=session.id;
  stage='retrieve';observed=await stripe.checkout.sessions.retrieve(id);
  if(observed.amount_total!==99900||observed.currency!=='usd'||observed.livemode!==true||observed.payment_status!=='unpaid')throw new Error('Unexpected session');
  stage='expire';if(observed.status!=='expired')await stripe.checkout.sessions.expire(id);
  stage='verify_expiry';const ended=await stripe.checkout.sessions.retrieve(id);if(ended.status!=='expired')throw new Error('Expiry unverified');
  return {status:200,body:{ok:true,live:true,amount_total:observed.amount_total,currency:observed.currency,payment_status:ended.payment_status,expired:true,session_id:id}};
 }catch(e){
  let cleanup='not_created';if(id){try{await stripe.checkout.sessions.expire(id);cleanup='expired';}catch{cleanup='unverified';}}
  return {status:502,body:{ok:false,stage,type:e.type||e.name,code:e.code||null,statusCode:e.statusCode||null,cleanup,session_id:id||null}};
 }
}
