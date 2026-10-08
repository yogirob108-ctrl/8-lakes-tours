// Syntax validation only: this confirms a complete address shape, never DNS,
// mailbox ownership, or deliverability. Outer whitespace is harmless; any
// whitespace inside the address is invalid.
export function normalizeBookingEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function isValidBookingEmail(value) {
  const email = normalizeBookingEmail(value);
  if (!email || email.length > 254 || /\s/.test(email)) return false;

  const at = email.indexOf('@');
  if (at <= 0 || at !== email.lastIndexOf('@')) return false;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > 64 || !domain || domain.startsWith('.') || domain.endsWith('.')) return false;

  if (!/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/i.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  const labels = domain.split('.');
  if (labels.length < 2 || labels.some(label => !label || label.length > 63 || !/^[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?$/u.test(label))) return false;
  return labels.at(-1).length >= 2 && /\p{L}/u.test(labels.at(-1));
}
