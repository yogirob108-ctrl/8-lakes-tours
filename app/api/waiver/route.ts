import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getInternalEmailRecipients, riderWaiverCustomerEmail, riderWaiverInternalEmail, sendEmail, type RiderWaiverRecord } from '@/lib/email';
import { isSupabaseAdminConfigured } from '@/lib/ops-config';
import { createSupabaseAdminClient } from '@/lib/supabase-admin';
import { validateRiderWaiver, waiverPlainText } from '@/lib/waiver.mjs';

function jsonError(message: string, status = 400) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

function trustedIp(request: Request) {
  // Only Vercel's platform header is treated as network provenance. Client-supplied
  // Client-provided forwarding headers are intentionally ignored. The database stores no IP when absent.
  const candidate = (request.headers.get('x-vercel-forwarded-for') || '').split(',')[0].trim();
  return candidate.length <= 64 ? candidate : '';
}

// Records one rider's waiver signature before any email side effect. A matched
// rider/version is idempotent: retries return success but do not send duplicate mail.
export async function POST(request: Request) {
  let payload: Record<string, unknown>;
  try {
    payload = await request.json();
  } catch {
    return jsonError('Invalid waiver submission.');
  }
  if (typeof payload.website === 'string' && payload.website.trim()) return NextResponse.json({ ok: true });

  const result = validateRiderWaiver(payload);
  if (!result.ok || !result.value) return jsonError(result.error || 'Invalid waiver submission.');
  if (!isSupabaseAdminConfigured) return jsonError('Waiver signing is temporarily unavailable. Please try again shortly.', 503);

  const { dateOfBirth, ...value } = result.value as Omit<RiderWaiverRecord, 'signedAt' | 'ipAddress' | 'userAgent'> & { dateOfBirth: string };
  const signedAt = new Date().toISOString();
  const record: RiderWaiverRecord = {
    ...value,
    signedAt,
    ipAddress: trustedIp(request),
    userAgent: (request.headers.get('user-agent') || '').slice(0, 300),
  };
  const waiverText = waiverPlainText();
  const submissionKey = createHash('sha256')
    .update([record.reference, record.riderName.toLocaleLowerCase(), dateOfBirth, record.waiverVersion, record.signature.toLocaleLowerCase()].join('|'))
    .digest('hex');
  const { data, error } = await createSupabaseAdminClient().rpc('record_rider_waiver', {
    p_reference: record.reference,
    p_project_slug: '8-lakes-tours',
    p_rider_name: record.riderName,
    p_rider_email: record.riderEmail,
    p_date_of_birth: dateOfBirth,
    p_guardian_name: record.guardianName,
    p_guardian_relationship: record.guardianRelationship,
    p_signature: record.signature,
    p_waiver_version: record.waiverVersion,
    p_signed_waiver_text: waiverText,
    p_submission_key: submissionKey,
    p_trusted_ip: record.ipAddress || null,
    p_ip_provenance: record.ipAddress ? 'vercel_forwarded' : 'unavailable',
    p_user_agent: record.userAgent || null,
  });
  const stored = Array.isArray(data) ? data[0] : data;
  if (error || !stored?.waiver_id) return jsonError('We could not record your signature just now. Please try again, or email info@8lakestours.com.', 502);

  // An unmatched or ambiguous submission remains private pending review and can
  // never inflate the matched waiver count. Avoid an email that claims completion.
  if (stored.should_email) {
    if (stored.match_status === 'matched') {
    const key = String(stored.waiver_id);
    const internal = riderWaiverInternalEmail(record, waiverText);
    await sendEmail({ to: getInternalEmailRecipients(), replyTo: record.riderEmail, idempotencyKey: `waiver-internal-${key}`, ...internal });
    const customer = riderWaiverCustomerEmail(record, waiverText);
    await sendEmail({ to: record.riderEmail, replyTo: getInternalEmailRecipients()[0], idempotencyKey: `waiver-copy-${key}`, ...customer });
    }
  }

  return NextResponse.json({ ok: true, isMinor: Boolean(stored.is_minor), pendingReview: stored.match_status !== 'matched' });
}
