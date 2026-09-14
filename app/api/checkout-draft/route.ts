import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { createSupabaseAdminClient } from '@/lib/supabase-admin';
import { createDraftCredential, draftCredentialHash, sanitizeDraftPayload, verifyDraftCredential } from '@/lib/checkout-draft.mjs';

export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
const error = (message: string, status = 400) => NextResponse.json({ ok: false, error: message }, { status, headers });

export async function POST(request: Request) {
  if (Number(request.headers.get('content-length') || 0) > 16 * 1024) return error('Draft is too large.', 413);
  let input: Record<string, unknown>;
  try { input = await request.json(); } catch { return error('Invalid draft.'); }
  const payload = sanitizeDraftPayload(input);
  // Do not begin collecting server-side until there is enough contact data to make recovery useful.
  if (!payload.email || !payload.first_name) return NextResponse.json({ ok: true, skipped: true }, { headers });
  const draftId = typeof input.draft_id === 'string' && /^[0-9a-f-]{36}$/i.test(input.draft_id) ? input.draft_id : randomUUID();
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) return error('Draft saving is temporarily unavailable.', 503);
  const credential = typeof input.credential === 'string' ? input.credential : createDraftCredential(draftId, secret);
  if (!verifyDraftCredential(draftId, credential, secret)) return error('Draft ownership could not be verified.', 403);
  const db = createSupabaseAdminClient();
  const { error: dbError } = await db.rpc('save_public_checkout_draft', {
    p_draft_id: draftId, p_credential_hash: draftCredentialHash(credential), p_payload: payload,
  });
  if (dbError) return error('Draft could not be saved. Please keep this page open and try again.', 503);
  return NextResponse.json({ ok: true, draft_id: draftId, credential, expires_in_days: 30 }, { headers });
}
