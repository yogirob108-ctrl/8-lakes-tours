import { NextResponse } from 'next/server';
import { createSupabaseAdminClient } from '@/lib/supabase-admin';
import { draftRecoveryTokenHash } from '@/lib/pre-submit-draft-recovery.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
 const url=new URL(request.url);
 const token=url.searchParams.get('token') || '';
 const headers={'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex, nofollow'};
 if(token.length<40 || token.length>100) return new Response('This private recovery link is invalid.',{status:404,headers});
 const {data,error}=await createSupabaseAdminClient().rpc('read_public_checkout_draft_by_recovery_token',{p_recovery_token_hash:draftRecoveryTokenHash(token)}).maybeSingle();
 const recovered=data as {draft_id?:string}|null;
 if(error || !recovered?.draft_id) return new Response('This private recovery link is no longer available.',{status:404,headers});
 const destination=new URL('/',url.origin);
 destination.hash=`resume=${encodeURIComponent(token)}`;
 return NextResponse.redirect(destination,{status:303,headers});
}
