import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getInternalEmailRecipients, riderWaiverCustomerEmail, riderWaiverInternalEmail, sendEmail, type RiderWaiverRecord } from '@/lib/email';
import { validateRiderWaiver, waiverPlainText } from '@/lib/waiver.mjs';

function jsonError(message: string, status = 400) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

// Records one rider's waiver signature. The team inbox copy is the durable
// record (version, time, IP and the exact text agreed); the rider gets a copy.
export async function POST(request: Request) {
  let payload: Record<string, unknown>;
  try {
    payload = await request.json();
  } catch {
    return jsonError('Invalid waiver submission.');
  }
  // Honeypot: real people never see or fill this field.
  if (typeof payload.website === 'string' && payload.website.trim()) return NextResponse.json({ ok: true });

  const result = validateRiderWaiver(payload);
  if (!result.ok || !result.value) return jsonError(result.error || 'Invalid waiver submission.');
  // The birth date stays out of every email; the record carries the age instead.
  const { dateOfBirth, ...value } = result.value as Omit<RiderWaiverRecord, 'signedAt' | 'ipAddress' | 'userAgent'> & { dateOfBirth: string };

  const signedAt = new Date().toISOString();
  const record: RiderWaiverRecord = {
    ...value,
    signedAt,
    ipAddress: (request.headers.get('x-forwarded-for') || '').split(',')[0].trim(),
    userAgent: (request.headers.get('user-agent') || '').slice(0, 300),
  };
  const waiverText = waiverPlainText();
  const key = createHash('sha256')
    .update([record.reference, record.riderName.toLowerCase(), dateOfBirth, record.waiverVersion, signedAt.slice(0, 10)].join('|'))
    .digest('hex')
    .slice(0, 32);

  const internal = riderWaiverInternalEmail(record, waiverText);
  const internalResult = await sendEmail({
    to: getInternalEmailRecipients(),
    replyTo: record.riderEmail,
    idempotencyKey: `waiver-internal-${key}`,
    ...internal,
  });
  if (!internalResult.sent) {
    return jsonError('We could not record your signature just now. Please try again, or email info@8lakestours.com.', 502);
  }

  const customer = riderWaiverCustomerEmail(record, waiverText);
  await sendEmail({
    to: record.riderEmail,
    replyTo: getInternalEmailRecipients()[0],
    idempotencyKey: `waiver-copy-${key}`,
    ...customer,
  });

  return NextResponse.json({ ok: true, isMinor: record.isMinor });
}
