export const ATTRIBUTION_VERSION = 1;
export const FIRST_TOUCH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const UTM_KEYS = ['source', 'medium', 'campaign', 'term', 'content'];
const CLICK_ID_KEYS = ['gclid', 'fbclid', 'ttclid', 'msclkid'];
const MAX_VALUE_LENGTH = 120;
const MAX_PATH_LENGTH = 160;
const SAFE_VALUE = /^[\p{L}\p{N} ._:/|+@-]+$/u;
const SAFE_EVENT_TYPE = new Set(['direct', 'tagged_campaign', 'external_referral']);

function text(value, max = MAX_VALUE_LENGTH) {
  if (typeof value !== 'string') return '';
  const raw = value.trim();
  if (/[\u0000-\u001f<>]/.test(raw)) return '';
  return raw.length <= max && SAFE_VALUE.test(raw) ? raw : '';
}

function timestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return '';
  return new Date(value).toISOString();
}

function page(value, { external = false } = {}) {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) return null;
    const host = url.hostname.toLowerCase();
    if (!host || host.length > 120) return null;
    const path = url.pathname || '/';
    if (path.length > MAX_PATH_LENGTH || !/^[\p{L}\p{N}/._~-]*$/u.test(path)) return null;
    return { host, path };
  } catch { return null; }
}

function sameSite(url, origin) {
  try { return new URL(url).origin === new URL(origin).origin; } catch { return false; }
}

function taggedLink(locationHref) {
  const url = new URL(locationHref);
  const tagged = Object.fromEntries(UTM_KEYS.map(key => [key, text(url.searchParams.get(`utm_${key}`))]).filter(([, value]) => value));
  if (!Object.keys(tagged).length) return null;
  return { ...tagged, landing: page(locationHref) };
}

function clickIds(locationHref) {
  const url = new URL(locationHref);
  return Object.fromEntries(CLICK_ID_KEYS.map(key => [key, text(url.searchParams.get(key))]).filter(([, value]) => value));
}

function observedReferrer(referrer, locationHref) {
  if (!referrer || sameSite(referrer, locationHref)) return null;
  return page(referrer, { external: true });
}

function eligibleVisit(current) {
  return current.type === 'tagged_campaign' || current.type === 'external_referral';
}

function validTouch(value) {
  if (!value || typeof value !== 'object') return null;
  const captured_at = timestamp(value.captured_at);
  if (!captured_at) return null;
  const tagged_link = sanitizeTagged(value.tagged_link);
  const observed_referrer = sanitizePage(value.observed_referrer);
  if (!tagged_link && !observed_referrer) return null;
  return { captured_at, ...(tagged_link ? { tagged_link } : {}), ...(observed_referrer ? { observed_referrer } : {}) };
}

function parseStorage(stored, now) {
  if (!stored) return null;
  try {
    const parsed = typeof stored === 'string' ? JSON.parse(stored) : stored;
    if (!parsed || parsed.version !== ATTRIBUTION_VERSION) return null;
    const first = validTouch(parsed.first_touch);
    const recent = validTouch(parsed.most_recent_eligible);
    if (first && Date.parse(now) - Date.parse(first.captured_at) > FIRST_TOUCH_TTL_MS) return null;
    return { first_touch: first, most_recent_eligible: recent };
  } catch { return null; }
}

/**
 * @param {{ locationHref: string; referrer?: string; now?: string; stored?: string | null; measurementConsent?: boolean; gaClientId?: string; gaSessionId?: string }} input
 */
export function buildAttributionCapture({ locationHref, referrer = '', now = new Date().toISOString(), stored = null, measurementConsent = false, gaClientId = '', gaSessionId = '' }) {
  const capturedAt = timestamp(now);
  if (!capturedAt) throw new Error('A valid capture timestamp is required.');
  const tagged_link = taggedLink(locationHref);
  const observed_referrer = observedReferrer(referrer, locationHref);
  const current_visit = /** @type {Record<string, unknown>} */ ({
    captured_at: capturedAt,
    type: tagged_link ? 'tagged_campaign' : observed_referrer ? 'external_referral' : 'direct',
    page: page(locationHref),
    ...(tagged_link ? { tagged_link } : {}),
    ...(observed_referrer ? { observed_referrer } : {}),
  });
  if (measurementConsent) {
    const client = text(gaClientId); const session = text(gaSessionId);
    const currentClickIds = clickIds(locationHref);
    if (/^\d{1,20}\.\d{1,20}$/.test(client)) current_visit.ga_client_id = client;
    if (/^\d{1,20}$/.test(session)) current_visit.ga_session_id = session;
    if (Object.keys(currentClickIds).length) current_visit.click_ids = currentClickIds;
  }
  const prior = parseStorage(stored, capturedAt);
  const touch = eligibleVisit(current_visit) ? {
    captured_at: capturedAt,
    ...(tagged_link ? { tagged_link } : {}),
    ...(observed_referrer ? { observed_referrer } : {}),
  } : null;
  const first_touch = prior?.first_touch || touch;
  const most_recent_eligible = touch || prior?.most_recent_eligible || null;
  const payload = { version: ATTRIBUTION_VERSION, ...(first_touch ? { first_touch } : {}), ...(most_recent_eligible ? { most_recent_eligible } : {}), current_visit };
  return { ...payload, storage: JSON.stringify({ version: ATTRIBUTION_VERSION, ...(first_touch ? { first_touch } : {}), ...(most_recent_eligible ? { most_recent_eligible } : {}) }) };
}

function sanitizePage(value) {
  if (typeof value === 'string') return page(value);
  if (!value || typeof value !== 'object') return null;
  const host = text(value.host, 120).toLowerCase();
  const rawPath = typeof value.path === 'string' ? value.path.split(/[?#]/, 1)[0] : '';
  const path = rawPath.length <= MAX_PATH_LENGTH && /^[\p{L}\p{N}/._~-]*$/u.test(rawPath) ? rawPath : '';
  return host && path ? { host, path } : null;
}
function sanitizeTagged(value) {
  if (!value || typeof value !== 'object') return null;
  const result = Object.fromEntries(UTM_KEYS.map(key => [key, text(value[key])]).filter(([, item]) => item));
  const click_ids = value.click_ids && typeof value.click_ids === 'object' ? Object.fromEntries(CLICK_ID_KEYS.map(key => [key, text(value.click_ids[key])]).filter(([, item]) => item)) : {};
  const landing = sanitizePage(value.landing);
  if (!Object.keys(result).length && !Object.keys(click_ids).length) return null;
  return { ...result, ...(Object.keys(click_ids).length ? { click_ids } : {}), ...(landing ? { landing } : {}) };
}
function sanitizeCurrent(value) {
  if (!value || typeof value !== 'object') return null;
  const captured_at = timestamp(value.captured_at); const type = text(value.type);
  const pageValue = sanitizePage(value.page);
  if (!captured_at || !SAFE_EVENT_TYPE.has(type) || !pageValue) return null;
  const tagged_link = sanitizeTagged(value.tagged_link); const observed_referrer = sanitizePage(value.observed_referrer);
  const out = { captured_at, type, page: pageValue, ...(tagged_link ? { tagged_link } : {}), ...(observed_referrer ? { observed_referrer } : {}) };
  const gaClient = text(value.ga_client_id); const gaSession = text(value.ga_session_id);
  if (/^\d{1,20}\.\d{1,20}$/.test(gaClient)) out.ga_client_id = gaClient;
  if (/^\d{1,20}$/.test(gaSession)) out.ga_session_id = gaSession;
  const clickIds = value.click_ids && typeof value.click_ids === 'object' ? Object.fromEntries(CLICK_ID_KEYS.map(key => [key, text(value.click_ids[key])]).filter(([, item]) => item)) : {};
  if (Object.keys(clickIds).length) out.click_ids = clickIds;
  return out;
}

export function normalizeAttributionPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== ATTRIBUTION_VERSION) return {};
  const first_touch = validTouch(value.first_touch);
  const most_recent_eligible = validTouch(value.most_recent_eligible);
  const current_visit = sanitizeCurrent(value.current_visit);
  if (!current_visit) return {};
  return { version: ATTRIBUTION_VERSION, ...(first_touch ? { first_touch } : {}), ...(most_recent_eligible ? { most_recent_eligible } : {}), current_visit };
}
