import { normalizeBookingTravellers } from './booking-travellers.mjs';

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const PUBLIC_BOOKING_FIELD_LIMITS = Object.freeze({
  tour_date: 160,
  emergency_contact: 200,
  how_heard: 200,
  notes: 2000,
  signature: 150,
  attribution: 200,
});

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizePublicBookingPayload(payload, options = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, error: 'Invalid booking submission.' };
  const submissionKey = clean(payload.submission_key);
  if (!UUID_V4_PATTERN.test(submissionKey)) return { ok: false, error: 'A valid submission key is required.' };

  const manifest = normalizeBookingTravellers(payload.guest_count, payload.travellers, options);
  if (!manifest.ok) return manifest;

  const values = {
    submission_key: submissionKey.toLowerCase(),
    tour_date: clean(payload.tour_date),
    emergency_contact: clean(payload.emergency_contact),
    how_heard: clean(payload.how_heard),
    notes: clean(payload.notes),
    signature: clean(payload.signature),
    travellers: manifest.travellers,
  };
  for (const field of ['tour_date', 'emergency_contact', 'how_heard', 'notes', 'signature']) {
    if (values[field].length > PUBLIC_BOOKING_FIELD_LIMITS[field]) return { ok: false, error: `${field.replaceAll('_', ' ')} is too long.` };
  }
  if (!values.signature) return { ok: false, error: 'The lead traveller waiver signature is required.' };
  // A signature is a name, not a couple of keystrokes. The form enforces this
  // too, but the form is not what the booking arrives through.
  const signatureParts = values.signature.split(/\s+/).filter(Boolean);
  if (signatureParts.length < 2 || !signatureParts.every(part => part.replace(/[^\p{L}]/gu, '').length >= 2)) {
    return { ok: false, error: 'Please sign with your full legal name.' };
  }
  if (clean(payload.waiver_agreed) !== 'on') {
    return { ok: false, error: 'Please confirm you have read and agree to the liability waiver.' };
  }

  const attribution = {};
  if (payload.attribution !== undefined && (!payload.attribution || typeof payload.attribution !== 'object' || Array.isArray(payload.attribution))) {
    return { ok: false, error: 'Attribution details are invalid.' };
  }
  for (const key of ['landing_url', 'current_url', 'referrer', 'source', 'medium', 'campaign', 'term', 'content', 'gclid', 'fbclid', 'ttclid', 'msclkid', 'ga_client_id', 'ga_session_id']) {
    const value = clean(payload.attribution?.[key]);
    if (value.length > PUBLIC_BOOKING_FIELD_LIMITS.attribution) return { ok: false, error: 'Attribution value is too long.' };
    if (value) attribution[key] = value;
  }

  return { ok: true, value: { ...values, attribution } };
}
