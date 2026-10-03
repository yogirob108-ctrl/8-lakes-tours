// The free 15-minute call is arranged by email for now: the prefilled message
// asks for the details Robert needs to propose a time. Swap this for a
// scheduling link (Calendly, cal.com) and every call button follows.
const subject = 'Free 15-minute call about the 2027 horse trek';
const body = [
  'Hi Robert,',
  '',
  "I'd like a free 15-minute call about the horse trek.",
  '',
  'My time zone:',
  'A few times that suit me:',
  'Phone, WhatsApp or Zoom:',
  '',
  'Thanks,',
].join('\n');

export const CALL_OFFER_HREF = `mailto:info@8lakestours.com?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
