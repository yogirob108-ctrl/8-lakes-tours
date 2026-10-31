// This email starts either a question or a call conversation. Keep every CTA
// pointed here until a dedicated scheduling flow replaces the call option.
const subject = 'Question or call about the 2027 horse trek';
const body = [
  'Hi Robert,',
  '',
  "I'd like to ask a question or book a call about the horse trek.",
  '',
  'My question (if any):',
  '',
  'My time zone (if I would like a call):',
  'A few times that suit me:',
  'Phone, WhatsApp or Zoom:',
  '',
  'Thanks,',
].join('\n');

export const CALL_OFFER_HREF = `mailto:info@8lakestours.com?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
