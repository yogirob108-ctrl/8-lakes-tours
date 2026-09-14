const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export function splitDateOfBirth(value) {
  if (!ISO_DATE_PATTERN.test(value || '')) return { day: '', month: '', year: '' };
  const [year, month, day] = value.split('-');
  return { day, month, year };
}

export function composeDateOfBirth(dayValue, monthValue, yearValue, options = {}) {
  const day = String(dayValue || '').trim();
  const month = String(monthValue || '').trim();
  const year = String(yearValue || '').trim();
  if (!day && !month && !year) return { value: '', error: '' };
  if (!day || !month || !year) return { value: '', error: '' };
  if (!/^\d{1,2}$/.test(day) || !/^\d{1,2}$/.test(month) || !/^\d{4}$/.test(year)) {
    return { value: '', error: 'Enter a day, month and four-digit year.' };
  }
  const dayNumber = Number(day);
  const monthNumber = Number(month);
  const yearNumber = Number(year);
  const date = new Date(Date.UTC(yearNumber, monthNumber - 1, dayNumber));
  if (date.getUTCFullYear() !== yearNumber || date.getUTCMonth() !== monthNumber - 1 || date.getUTCDate() !== dayNumber) {
    return { value: '', error: 'Enter a real calendar date.' };
  }
  const value = `${year.padStart(4, '0')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  if (value > (options.today || todayIso())) return { value: '', error: 'Date of birth cannot be in the future.' };
  return { value, error: '' };
}
