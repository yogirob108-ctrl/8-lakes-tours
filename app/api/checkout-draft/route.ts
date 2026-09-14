import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { createSupabaseAdminClient } from '@/lib/supabase-admin';
import { createDraftCredential, draftCredentialHash, sanitizeDraftPayload, verifyDraftCredential } from '@/lib/checkout-draft.mjs';
import { draftRecoveryTokenHash } from '@/lib/pre-submit-draft-recovery.mjs';

export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
const error = (message: string, status = 400) => NextResponse.json({ ok: false, error: message }, { status, headers });
const validId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value);

export async function POST(request: Request) {
  if (Number(request.headers.get('content-length') || 0) > 16 * 1024) return error('Draft is too large.', 413);
  let input: Record<string, unknown>;
  try { input = await request.json(); } catch { return error('Invalid draft.'); }
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) return error('Draft saving is temporarily unavailable.', 503);

  if (input.action === 'recover') {
    const token = input.token;
    if (typeof token !== 'string' || token.length < 40 || token.length > 100) return error('Draft recovery link is invalid.', 403);
    const db = createSupabaseAdminClient();
    const { data, error: dbError } = await db.rpc('read_public_checkout_draft_by_recovery_token', { p_recovery_token_hash: draftRecoveryTokenHash(token) }).maybeSingle();
    if (dbError) return error('Draft could not be recovered. Please use the private link again.', 503);
    const recovered = data as { draft_id?: string; payload?: unknown } | null;
    if (!recovered?.draft_id || !recovered?.payload) return error('This private recovery link is no longer available.', 404);
    const credential = createDraftCredential(recovered.draft_id, secret);
    return NextResponse.json({ ok: true, draft_id: recovered.draft_id, credential, draft: sanitizeDraftPayload(recovered.payload) }, { headers });
  }

  if (input.action === 'load') {
    const draftId = input.draft_id;
    const credential = input.credential;
    if (!validId(draftId) || typeof credential !== 'string' || !verifyDraftCredential(draftId, credential, secret)) return error('Draft ownership could not be verified.', 403);
    const db = createSupabaseAdminClient();
    const { data, error: dbError } = await db.from('public_checkout_drafts').select('payload').eq('id', draftId).eq('credential_hash', draftCredentialHash(credential)).gt('expires_at', new Date().toISOString()).maybeSingle();
    if (dbError) return error('Draft could not be recovered. Please keep this page open and try again.', 503);
    if (!data) return error('This saved draft is no longer available.', 404);
    return NextResponse.json({ ok: true, draft: sanitizeDraftPayload(data.payload) }, { headers });
  }

  const payload = sanitizeDraftPayload(input);
  // Do not begin collecting server-side until there is enough contact data to make recovery useful.
  if (!payload.email || !payload.first_name) return NextResponse.json({ ok: true, skipped: true }, { headers });
  const draftId = validId(input.draft_id) ? input.draft_id : randomUUID();
  const credential = typeof input.credential === 'string' ? input.credential : createDraftCredential(draftId, secret);
  if (!verifyDraftCredential(draftId, credential, secret)) return error('Draft ownership could not be verified.', 403);
  const db = createSupabaseAdminClient();
  const { error: dbError } = await db.rpc('save_public_checkout_draft', {
    p_draft_id: draftId, p_credential_hash: draftCredentialHash(credential), p_payload: payload,
  });
  if (dbError) return error('Draft could not be saved. Please keep this page open and try again.', 503);
  return NextResponse.json({ ok: true, draft_id: draftId, credential, expires_in_days: 30 }, { headers });
}
