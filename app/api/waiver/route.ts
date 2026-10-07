import { createHash, randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getInternalEmailRecipients, riderWaiverCustomerEmail, riderWaiverInternalEmail, sendEmail, type RiderWaiverRecord } from '@/lib/email';
import { isSupabaseAdminConfigured } from '@/lib/ops-config';
import { createSupabaseAdminClient } from '@/lib/supabase-admin';
import { validateRiderWaiver, WAIVER_TEXT_SHA256, waiverPlainText } from '@/lib/waiver.mjs';

function isNonConfirmingWaiverResult(error: unknown) {
  // Keep unknown references and immutable-snapshot conflicts externally identical:
  // each is received but cannot be confirmed by this public endpoint.
  return typeof error === 'object' && error !== null && ['P0002', 'P0003'].includes(String((error as { code?: unknown }).code));
}

function waiverSubmissionKey(input: {
  reference: string; riderName: string; riderEmail: string; dateOfBirth: string;
  guardianName: string | null; guardianRelationship: string | null; signature: string;
  waiverVersion: string; signedWaiverText: string; signedWaiverTextSha256: string;
}) {
  // The validator already trims fields and canonicalizes email. JSON preserves
  // unambiguous field boundaries for this immutable legal snapshot.
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

function jsonError(message: string, status = 400) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

function trustedIp(request: Request) {
  // Only Vercel's platform header is treated as network provenance. Client-supplied
  // Client-provided forwarding headers are intentionally ignored. The database stores no IP when absent.
  const candidate = (request.headers.get('x-vercel-forwarded-for') || '').split(',')[0].trim();
  return candidate.length <= 64 ? candidate : '';
}

type WaiverSnapshot = {
  rider_name_snapshot: string;
  rider_email_snapshot: string;
  guardian_name_snapshot: string | null;
  guardian_relationship_snapshot: string | null;
  signature_snapshot: string;
  signed_waiver_text: string;
  server_signed_at: string;
  trusted_ip_address: string | null;
  user_agent: string | null;
  is_minor: boolean;
};

async function dispatchWaiverEmail(input: {
  waiverId: string;
  destination: 'internal' | 'rider';
  recipient: string;
  email: Parameters<typeof sendEmail>[0];
}) {
  const db = createSupabaseAdminClient();
  const claimToken = randomUUID();
  const { data: claim, error: claimError } = await db.rpc('claim_rider_waiver_email_dispatch', {
    p_waiver_id: input.waiverId,
    p_destination: input.destination,
    p_recipient_email: input.recipient,
    p_claim_token: claimToken,
  });
  const dispatch = Array.isArray(claim) ? claim[0] : claim;
  if (claimError || !dispatch?.should_send || !dispatch.dispatch_id || !dispatch.idempotency_key) return;

  // The claim freezes the recipient. Do not let a changed request/configuration
  // alter a retry's provider destination after the durable dispatch was created.
  const claimedRecipient = typeof dispatch.recipient_email === 'string' ? dispatch.recipient_email.trim() : '';
  const providerRecipients = input.destination === 'internal'
    ? claimedRecipient.split(',').map((recipient: string) => recipient.trim()).filter(Boolean)
    : claimedRecipient;
  if (!claimedRecipient || (Array.isArray(providerRecipients) && providerRecipients.length === 0)) return;

  const { data: attempted, error: attemptError } = await db.rpc('mark_rider_waiver_email_provider_attempted', {
    p_dispatch_id: dispatch.dispatch_id,
    p_claim_token: claimToken,
  });
  if (attemptError || !attempted) return;

  try {
    const sent = await sendEmail({ ...input.email, to: providerRecipients, idempotencyKey: dispatch.idempotency_key });
    await db.rpc('complete_rider_waiver_email_dispatch', {
      p_dispatch_id: dispatch.dispatch_id,
      p_claim_token: claimToken,
      p_sent: sent.sent,
      // Resend resolves many transport/server failures instead of throwing. Only
      // an explicitly classified definite rejection may enter the retryable state.
      p_definite_failure: sent.sent ? false : sent.definiteFailure === true,
      p_provider_message_id: sent.id ?? null,
    });
  } catch {
    await db.rpc('complete_rider_waiver_email_dispatch', {
      p_dispatch_id: dispatch.dispatch_id,
      p_claim_token: claimToken,
      p_sent: false,
      p_definite_failure: false,
      p_provider_message_id: null,
    });
  }
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
  const submissionKey = waiverSubmissionKey({
    reference: record.reference,
    riderName: record.riderName,
    riderEmail: record.riderEmail,
    dateOfBirth,
    guardianName: record.guardianName,
    guardianRelationship: record.guardianRelationship,
    signature: record.signature,
    waiverVersion: record.waiverVersion,
    signedWaiverText: waiverText,
    signedWaiverTextSha256: WAIVER_TEXT_SHA256,
  });
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
    p_signed_waiver_text_sha256: WAIVER_TEXT_SHA256,
    p_submission_key: submissionKey,
    p_trusted_ip: record.ipAddress || null,
    p_ip_provenance: record.ipAddress ? 'vercel_forwarded' : 'unavailable',
    p_user_agent: record.userAgent || null,
  });
  const stored = Array.isArray(data) ? data[0] : data;
  // Unknown references and immutable snapshot conflicts are deliberately
  // indistinguishable from a received-but-not-confirmed submission. Do not turn
  // genuine database/provider failures into 200.
  if (isNonConfirmingWaiverResult(error)) return NextResponse.json({ ok: true });
  if (error || !stored?.waiver_id) return jsonError('We could not record your signature just now. Please try again, or email info@8lakestours.com.', 502);

  // Dispatch can only use the signed snapshot, never this retry's request fields.
  // Durable claims record provider attempts before sending; a timeout becomes
  // reconciliation_required rather than a blind retry beyond Resend's window.
  if (stored.match_status === 'matched') {
    const { data: snapshot, error: snapshotError } = await createSupabaseAdminClient()
      .from('rider_waivers')
      .select('rider_name_snapshot,rider_email_snapshot,guardian_name_snapshot,guardian_relationship_snapshot,signature_snapshot,signed_waiver_text,server_signed_at,trusted_ip_address,user_agent,is_minor')
      .eq('id', stored.waiver_id)
      .single<WaiverSnapshot>();
    if (!snapshotError && snapshot) {
      const persistedRecord: RiderWaiverRecord = {
        ...record,
        riderName: snapshot.rider_name_snapshot,
        riderEmail: snapshot.rider_email_snapshot,
        guardianName: snapshot.guardian_name_snapshot ?? '',
        guardianRelationship: snapshot.guardian_relationship_snapshot ?? '',
        signature: snapshot.signature_snapshot,
        signedAt: snapshot.server_signed_at,
        ipAddress: snapshot.trusted_ip_address ?? '',
        userAgent: snapshot.user_agent ?? '',
        isMinor: snapshot.is_minor,
      };
      const internalRecipients = getInternalEmailRecipients();
      const internal = riderWaiverInternalEmail(persistedRecord, snapshot.signed_waiver_text);
      await dispatchWaiverEmail({
        waiverId: String(stored.waiver_id),
        destination: 'internal',
        recipient: internalRecipients.join(','),
        email: { to: internalRecipients, replyTo: persistedRecord.riderEmail, ...internal },
      });
      const customer = riderWaiverCustomerEmail(persistedRecord, snapshot.signed_waiver_text);
      await dispatchWaiverEmail({
        waiverId: String(stored.waiver_id),
        destination: 'rider',
        recipient: persistedRecord.riderEmail,
        email: { to: persistedRecord.riderEmail, replyTo: internalRecipients[0], ...customer },
      });
    }
  }

  // Do not disclose whether a booking/rider reference matched. The waiver page
  // already has enough local validation to give input feedback without turning
  // this endpoint into a booking-reference oracle.
  return NextResponse.json({ ok: true });
}
