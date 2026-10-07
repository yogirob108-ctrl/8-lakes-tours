// The liability waiver, shared by the booking form and the per-rider /waiver page
// so both always show the same words. Bump WAIVER_VERSION whenever the text
// changes: every signature record names the version the rider agreed to.
export const WAIVER_VERSION = '2026-10-06';
// SHA-256 of waiverPlainText(). This freezes the exact legal words represented
// by this version without duplicating or altering the legal copy below.
export const WAIVER_TEXT_SHA256 = 'a79e70ddd57e65302cf5291fedc2d622e6d41392afc3fc4a50484647425f8678';
export const ADULT_AGE = 18;
export const MINIMUM_RIDER_AGE = 16;

export const WAIVER_SECTIONS = Object.freeze([
  {
    title: '1. Nature of Activity',
    body: '8 Lakes Tours operates multi-day horseback trekking expeditions in remote wilderness areas of Mongolia. These activities take place in the Orkhon Valley and surrounding steppe, far from medical facilities, emergency services, and modern infrastructure. Participants acknowledge that this is an inherently adventurous and physically demanding experience.',
  },
  {
    title: '2. Horseback Riding Risks',
    body: 'Horseback riding carries inherent risks including, but not limited to: falling from or being thrown by a horse, being kicked or bitten, collision with obstacles, and unpredictable animal behaviour. Horses are living animals and may react in unexpected ways regardless of rider experience. Participants ride at their own risk and must follow all instructions from their guide at all times.',
  },
  {
    title: '3. Remote Wilderness Travel',
    body: 'Travel takes place in remote, off-grid terrain with no road access, no mobile phone coverage, and no nearby emergency services. In the event of injury or illness, evacuation may take many hours or longer. Participants must be in adequate physical health to undertake the journey and must disclose any pre-existing medical conditions to their guide prior to departure.',
  },
  {
    title: '4. Medical Emergencies',
    body: '8 Lakes Tours and its guides carry basic first aid supplies but are not medical professionals. In the event of a serious medical emergency, all costs associated with evacuation, treatment, and repatriation are the sole responsibility of the participant. 8 Lakes Tours accepts no liability for injury, illness, or death arising from participation in this tour.',
  },
  {
    title: '5. Travel Insurance Requirement',
    body: 'Comprehensive travel insurance is mandatory for all participants. Your policy must include coverage for: emergency medical treatment, emergency evacuation and repatriation, horseback riding and adventure activities, and trip cancellation or interruption. Proof of insurance may be requested before your departure. 8 Lakes Tours reserves the right to deny participation to anyone without adequate coverage.',
  },
  {
    title: '6. Release of Liability',
    body: 'In consideration of being permitted to participate in this tour, I hereby release, waive, discharge, and covenant not to sue 8 Lakes Tours, its guides, the host family, their agents, employees, and representatives from any and all liability, claims, demands, or causes of action arising out of or related to any loss, damage, injury, or death, whether caused by negligence or otherwise, that may be sustained by me while participating in this tour or while on the premises of any location associated with the tour.',
  },
  {
    title: '7. Assumption of Risk',
    body: 'I expressly acknowledge and assume all risks associated with this tour, including those resulting from the actions, inactions, or negligence of 8 Lakes Tours or any other party. I confirm that I am physically and mentally capable of participating in this activity, that I have not been advised otherwise by a medical professional, and that I undertake this activity entirely at my own risk.',
  },
  {
    title: '8. Consent to Emergency Medical Treatment',
    body: 'If I am injured or ill and unable to make decisions for myself, I authorise 8 Lakes Tours, its guides and the host family to arrange first aid, transport, evacuation and medical treatment on my behalf as they reasonably judge necessary. I understand that care in remote Mongolia may differ from the standard in my home country, and that the costs of any treatment or evacuation are my responsibility.',
  },
  {
    title: '9. Safety Instructions and Conduct',
    body: 'I will follow the safety instructions of my guide and the host family at all times. 8 Lakes Tours or my guide may stop me from riding, change my horse or route, or remove me from the tour without refund if I ignore safety instructions, ride under the influence of alcohol or drugs, put myself, other riders or the horses at risk, or behave in a way that is unsafe or disrespectful to the host family. Any extra costs that result are my responsibility.',
  },
  {
    title: '10. Helmets and Safety Equipment',
    body: 'A riding helmet is strongly recommended on every ride. If I choose to ride without a helmet or other recommended safety equipment, I do so by my own decision and accept the added risk of serious head injury.',
  },
  {
    title: '11. Participants Under 18',
    body: 'Riders aged 16 or 17 may join the trek only with a parent or legal guardian. A parent or legal guardian must sign this waiver on their behalf. By signing for a minor, the parent or guardian agrees to every term of this waiver for the minor and for themselves, confirms they have authority to do so, and accepts responsibility for the minor throughout the tour.',
  },
]);

export const WAIVER_CLOSING = 'This waiver is binding upon myself, my heirs, executors, administrators, and assigns. I have read this document in full and understand its contents.';

export function waiverPlainText() {
  return [...WAIVER_SECTIONS.map(section => `${section.title}\n${section.body}`), WAIVER_CLOSING].join('\n\n');
}

function validIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

// Whole years between a date of birth and a reference date (both YYYY-MM-DD).
export function ageOn(dateOfBirth, onDate) {
  if (!validIsoDate(dateOfBirth) || !validIsoDate(onDate)) return null;
  const [by, bm, bd] = dateOfBirth.split('-').map(Number);
  const [ty, tm, td] = onDate.split('-').map(Number);
  let age = ty - by;
  if (tm < bm || (tm === bm && td < bd)) age -= 1;
  return age;
}

const REFERENCE_PATTERN = /^8L-[A-Z0-9-]{3,16}$/;
const LIMITS = { name: 150, email: 254, relationship: 60 };

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isFullName(value) {
  const parts = value.split(/\s+/).filter(Boolean);
  return parts.length >= 2 && parts.every(part => part.replace(/[^\p{L}]/gu, '').length >= 2);
}

// Validates one rider's waiver signature from the /waiver page. Riders under 18
// need a parent or guardian to sign; riders under 16 cannot join the trek.
export function validateRiderWaiver(payload, options = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, error: 'Invalid waiver submission.' };
  const today = options.today || new Date().toISOString().slice(0, 10);
  const reference = clean(payload.reference).toUpperCase();
  const riderName = clean(payload.rider_name);
  const riderEmail = clean(payload.rider_email).toLowerCase();
  const dateOfBirth = clean(payload.date_of_birth);
  const guardianName = clean(payload.guardian_name);
  const guardianRelationship = clean(payload.guardian_relationship);
  const signature = clean(payload.signature);

  if (!REFERENCE_PATTERN.test(reference)) return { ok: false, error: 'Please enter your booking reference, for example 8L-ABC123.' };
  if (!isFullName(riderName) || riderName.length > LIMITS.name) return { ok: false, error: 'Please enter the rider’s full legal name.' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(riderEmail) || riderEmail.length > LIMITS.email) return { ok: false, error: 'Please enter a valid email address.' };
  const age = ageOn(dateOfBirth, today);
  if (age === null || dateOfBirth < '1900-01-01' || dateOfBirth > today) return { ok: false, error: 'Please enter a valid date of birth.' };
  if (age < MINIMUM_RIDER_AGE) return { ok: false, error: 'The trek is for riders aged 16 and over. Please email info@8lakestours.com about a family stay instead.' };

  const isMinor = age < ADULT_AGE;
  if (isMinor) {
    if (!isFullName(guardianName) || guardianName.length > LIMITS.name) return { ok: false, error: 'A parent or legal guardian must sign for riders under 18. Please enter their full legal name.' };
    if (!guardianRelationship || guardianRelationship.length > LIMITS.relationship) return { ok: false, error: 'Please enter the guardian’s relationship to the rider.' };
  }
  const expectedSigner = isMinor ? guardianName : riderName;
  if (signature.toLowerCase().replace(/\s+/g, ' ') !== expectedSigner.toLowerCase().replace(/\s+/g, ' ')) {
    return { ok: false, error: isMinor ? 'The signature must match the parent or guardian’s full name.' : 'Please sign by typing your full legal name exactly as entered above.' };
  }
  if (clean(payload.agreed) !== 'on') return { ok: false, error: 'Please confirm you have read and agree to the waiver.' };

  return {
    ok: true,
    value: {
      reference,
      riderName,
      riderEmail,
      dateOfBirth,
      age,
      isMinor,
      guardianName: isMinor ? guardianName : null,
      guardianRelationship: isMinor ? guardianRelationship : null,
      signature,
      waiverVersion: WAIVER_VERSION,
    },
  };
}
