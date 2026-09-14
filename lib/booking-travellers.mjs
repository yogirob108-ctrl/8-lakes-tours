export const RIDING_LEVELS = Object.freeze([
  'Beginner — little to none',
  'Intermediate — comfortable riding',
  'Advanced — experienced rider',
]);

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const EARLIEST_DOB = '1900-01-01';

export const TRAVELLER_FIELD_LIMITS = Object.freeze({
  first_name: 100,
  last_name: 100,
  email: 254,
  phone: 40,
  nationality: 80,
  gender_pronouns: 60,
  dietary_notes: 1000,
});

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function validIsoDate(value) {
  if (!ISO_DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function tooLong(field, value) {
  return value.length > TRAVELLER_FIELD_LIMITS[field];
}

export function normalizeBookingTravellers(guestCountValue, travellerValues, options = {}) {
  const guestCount = typeof guestCountValue === 'number' ? guestCountValue : Number(guestCountValue);
  const today = options.today || todayIso();

  if (!Number.isInteger(guestCount) || guestCount < 1 || guestCount > 8) {
    return { ok: false, error: 'Guest count must be a whole number from 1 to 8.' };
  }
  if (!Array.isArray(travellerValues) || travellerValues.length !== guestCount) {
    return { ok: false, error: `Please provide exactly ${guestCount} travellers.` };
  }

  const travellers = [];
  for (let index = 0; index < travellerValues.length; index += 1) {
    const raw = travellerValues[index];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: `Traveller ${index + 1} details are invalid.` };
    }

    const firstName = clean(raw.first_name);
    const lastName = clean(raw.last_name);
    const email = clean(raw.email).toLowerCase();
    const phone = clean(raw.phone);
    const nationality = clean(raw.nationality);
    const genderPronouns = clean(raw.gender_pronouns);
    const dateOfBirth = clean(raw.date_of_birth);
    const ridingExperience = clean(raw.riding_experience);
    const dietaryNotes = clean(raw.dietary_notes);

    if (!firstName || !lastName || !nationality || !dateOfBirth || !ridingExperience) {
      return { ok: false, error: `Traveller ${index + 1} requires passport/legal first and last names, date of birth, nationality, and riding level.` };
    }
    for (const [field, value] of Object.entries({ first_name: firstName, last_name: lastName, email, phone, nationality, gender_pronouns: genderPronouns, dietary_notes: dietaryNotes })) {
      if (tooLong(field, value)) return { ok: false, error: `Traveller ${index + 1} ${field.replaceAll('_', ' ')} is too long.` };
    }
    if (!validIsoDate(dateOfBirth) || dateOfBirth < EARLIEST_DOB || dateOfBirth > today) {
      return { ok: false, error: `Traveller ${index + 1} date of birth must be a real, non-future date from 1900 onward.` };
    }
    if (!RIDING_LEVELS.includes(ridingExperience)) {
      return { ok: false, error: `Traveller ${index + 1} riding level is invalid.` };
    }
    if (email && !EMAIL_PATTERN.test(email)) {
      return { ok: false, error: `Traveller ${index + 1} email address is invalid.` };
    }

    travellers.push({
      position: index + 1,
      is_lead: index === 0,
      first_name: firstName,
      last_name: lastName,
      email: email || null,
      phone: phone || null,
      nationality,
      gender_pronouns: genderPronouns || null,
      date_of_birth: dateOfBirth,
      riding_experience: ridingExperience,
      dietary_notes: dietaryNotes || null,
    });
  }

  if (!travellers[0].email) return { ok: false, error: 'Lead traveller email is required.' };
  return { ok: true, travellers };
}
