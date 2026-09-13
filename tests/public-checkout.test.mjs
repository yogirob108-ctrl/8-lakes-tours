import test from 'node:test';
import assert from 'node:assert/strict';
import { checkoutSpec, paymentToken, validPaymentToken } from '../lib/public-checkout.mjs';
import { getGroupPricing } from '../lib/group-pricing.mjs';
import { canAutomaticallyConfirmBooking } from '../lib/tour-booking.mjs';
const dates = [{date:'Scheduled', startDate:'2099-01-01', endDate:'2099-01-09'}, {date:'Private',requiresConfirmation:true}];
test('all scheduled group sizes qualify, private and unknown fail closed',()=>{
 for(let n=1;n<=8;n++) assert.equal(canAutomaticallyConfirmBooking('Scheduled',n,new Date('2026-09-10'),dates),true);
 assert.equal(canAutomaticallyConfirmBooking('Private',3,new Date(),dates),false);
 assert.equal(canAutomaticallyConfirmBooking('Unknown',2,new Date(),dates),false);
});
test('Stripe exact trusted group totals and metadata for every size',()=>{
 const expected=[999,1998,2922,3896,4745,5694,6293,7192];
 for(let n=1;n<=8;n++) {
  const p=getGroupPricing(n); const b={id:'booking',customer_id:'customer',public_reference:'8L-TEST',guest_count:n,online_due_usd:p.onlinePaymentUsd,online_paid_usd:0,total_trip_value_usd:p.totalTripValueUsd,family_cash_due_usd:p.localFamilyPaymentUsd,status:'awaiting_payment'};
  const spec=checkoutSpec(b,'smoke@example.invalid','https://www.8lakestours.com/pay');
  assert.equal(spec.line_items[0].price_data.unit_amount,expected[n-1]*100);
  assert.equal(spec.line_items[0].quantity,1); assert.equal(spec.client_reference_id,b.public_reference);
  assert.equal(spec.metadata.guest_count,String(n)); assert.equal(spec.allow_promotion_codes,false);
  assert.throws(()=>checkoutSpec({...b,online_due_usd:1},'', ''),/pricing/);
  assert.throws(()=>checkoutSpec({...b,status:'cancelled'},'', ''),/payable/);
  assert.throws(()=>checkoutSpec({...b,online_paid_usd:1},'', ''),/payable/);
 }
});
test('recovery token is reference bound and constant-time validated',()=>{
 const token=paymentToken('8L-ONE','secret'); assert.equal(validPaymentToken('8L-ONE',token,'secret'),true);
 assert.equal(validPaymentToken('8L-TWO',token,'secret'),false); assert.equal(validPaymentToken('8L-ONE','bad','secret'),false);
});
