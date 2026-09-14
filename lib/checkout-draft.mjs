import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const text = (value, max = 500) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const email = value => {
  const normalized = text(value, 254).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized : '';
};

export function createDraftCredential(draftId, secret) {
  return `v1.${createHmac('sha256', secret).update(`8l-draft:${draftId}`).digest('hex')}`;
}
export function verifyDraftCredential(draftId, credential, secret) {
  if (!secret || typeof credential !== 'string' || !/^v1\.[0-9a-f]{64}$/.test(credential)) return false;
  return timingSafeEqual(Buffer.from(credential.slice(3), 'hex'), Buffer.from(createDraftCredential(draftId, secret).slice(3), 'hex'));
}
export function draftCredentialHash(credential) { return createHash('sha256').update(credential).digest('hex'); }
export function sanitizeDraftPayload(input = {}) {
  const raw = input && typeof input === 'object' ? input : {};
  const guestCount = Number(raw.guest_count);
  const travellers = Array.isArray(raw.travellers) ? raw.travellers.slice(0, 8).map(item => ({
    first_name: text(item?.first_name, 100), last_name: text(item?.last_name, 100),
    date_of_birth: text(item?.date_of_birth, 10),
  })) : [];
  return {
    first_name: text(raw.first_name, 100), last_name: text(raw.last_name, 100), email: email(raw.email),
    phone: text(raw.phone, 40), tour_date: text(raw.tour_date, 160),
    guest_count: Number.isInteger(guestCount) && guestCount >= 1 && guestCount <= 8 ? guestCount : 1,
    notes: text(raw.notes, 1000), ...(travellers.length ? { travellers } : {}),
  };
}
export function draftFingerprint(draft) { return createHash('sha256').update(JSON.stringify(draft)).digest('hex'); }
