import {createHash,timingSafeEqual} from 'node:crypto';
import Stripe from 'stripe';
import {probe} from '@/lib/stripe-runtime-probe.mjs';
export const runtime='nodejs';
export const maxDuration=60;
export async function POST(request:Request){
 const expected=Buffer.from('e28580ba523f2c047b598f50a279e3e6e05abecab71ec8b94c706e4604976014','hex');
 const given=createHash('sha256').update(request.headers.get('authorization')||'').digest();
 if(Date.now()>1789410917548||!timingSafeEqual(expected,given))return Response.json({ok:false},{status:401});
 const r=await probe({authorized:true,stripe:new Stripe(process.env.STRIPE_SECRET_KEY||'',{maxNetworkRetries:0,timeout:10000})});
 return Response.json(r.body,{status:r.status,headers:{'Cache-Control':'no-store'}});
}
