import { Resend } from 'resend';
import { GROUP_INVOICE } from './tour-booking.mjs';

const DEFAULT_FROM = '8 Lakes Tours <info@8lakestours.com>';
const DEFAULT_INTERNAL_RECIPIENTS = ['8lakestours@gmail.com'];
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.8lakestours.com';
const OPS_URL = process.env.OPS_BASE_URL || 'https://adventure-therapy-ops.vercel.app';
const TOTAL_PRICE_USD = '$1,999';
const ONLINE_PAYMENT_USD = '$999';
const FAMILY_CASH_USD = '$1,000';

// Email visual direction: minimal, plain, like a real person writing from Gmail.
// White background, system font, left aligned short paragraphs, restrained width.
// No hero banner, no cards, no shadows, no badges, no promotional footer.
function usd(amount: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(amount);
}

type SendEmailInput = {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  idempotencyKey?: string;
};

type EmailResult = {
  sent: boolean;
  id?: string;
  error?: string;
};

type LifecycleEmailInput = {
  reference: string;
  firstName: string;
  tourDate: string;
  // Use the booking's agreed local-cash amount when known. Keep the legacy
  // default only for older callers that do not yet carry this field.
  familyCashDueUsd?: number | null;
};

function lifecycleFamilyCash(input: LifecycleEmailInput) {
  return input.familyCashDueUsd == null ? FAMILY_CASH_USD : usd(input.familyCashDueUsd);
}

function getResendClient() {
  const apiKey = process.env.RESEND_API_KEY;
  return apiKey ? new Resend(apiKey) : null;
}

function splitEmails(value: string | undefined) {
  return value?.split(',').map((email) => email.trim()).filter(Boolean) ?? [];
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function firstName(value: string) {
  return value.trim().split(/\s+/)[0] || value;
}

function nl2br(value: string) {
  return escapeHtml(value || 'None').replaceAll('\n', '<br>');
}

// One consistent lightweight wrapper for every 8 Lakes email.
function wrap(preheader: string, body: string) {
  return `
<div style="display:none;max-height:0;overflow:hidden;color:transparent;opacity:0">${escapeHtml(preheader)}</div>
<div style="margin:0;padding:24px 16px;background:#ffffff">
  <div style="max-width:640px;margin:0 auto;text-align:left;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#222222;font-size:15px;line-height:1.6">
${body}
  </div>
</div>`;
}

function p(html: string) {
  return `    <p style="margin:0 0 16px">${html}</p>`;
}

// Quiet signature block appended to every customer-facing email: plain muted
// small text under the signoff, no logo, no wordmark banner, no footer strip.
function signatureBlockHtml() {
  return `    <p style="margin:12px 0 0;font-size:13px;line-height:1.6;color:#767676">Robert Zaher<br>8 Lakes Tours<br>www.8lakestours.com<br>info@8lakestours.com</p>`;
}

function signoffHtml(withSignature = true) {
  return `    <p style="margin:24px 0 0">Robert Zaher<br>8 Lakes Tours</p>` + (withSignature ? '\n' + signatureBlockHtml() : '');
}

// Subtle plain-text style section rules for longer customer emails: a thin
// light gray dashed line in HTML and a literal dash rule in text, separating
// natural sections (greeting, facts, payment, logistics, closing). No colors,
// no graphics, no heavy dividers; internal notifications stay clean.
const DASH_RULE_TEXT = '--------------------------------';
function sectionRuleHtml() {
  return `    <div style="border-top:1px dashed #cccccc;margin:0 0 16px"></div>`;
}

// Plain summary lines (reference, date, amounts) with real text, readable on mobile.
function detailsHtml(pairs: Array<[string, string]>) {
  const lines = pairs.map(([label, value]) => `${escapeHtml(label)}: <strong>${value}</strong>`).join('<br>');
  return `    <p style="margin:0 0 16px">${lines}</p>`;
}

function bulletHtml(items: string[]) {
  return `    <p style="margin:0 0 16px">${items.join('<br>')}</p>`;
}

export function getInternalEmailRecipients() {
  const configured = splitEmails(process.env.INTERNAL_NOTIFICATION_EMAILS);
  return configured.length > 0 ? configured : DEFAULT_INTERNAL_RECIPIENTS;
}

export async function sendEmail({ to, subject, html, text, replyTo, idempotencyKey }: SendEmailInput): Promise<EmailResult> {
  const resend = getResendClient();
  if (!resend) return { sent: false, error: 'RESEND_API_KEY is not configured' };

  const { data, error } = await resend.emails.send({
    from: process.env.EMAIL_FROM || DEFAULT_FROM,
    to,
    subject,
    html,
    text,
    replyTo,
  }, idempotencyKey ? { idempotencyKey } : undefined);

  if (error) return { sent: false, error: error.message };
  return { sent: true, id: data?.id };
}

export function bookingInternalEmail(input: {
  reference: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  tourDate: string;
  guestCount?: number;
  pricePerPersonUsd?: number;
  onlinePaymentUsd?: number;
  localFamilyPaymentUsd?: number;
  totalTripValueUsd?: number;
  requiresManualPaymentLink?: boolean;
  manualPaymentReason?: string | null;
  ridingExperience: string;
  travellerNames?: string;
  notes: string;
}) {
  const name = `${input.firstName} ${input.lastName}`.trim();
  const guestCount = input.guestCount ?? 1;
  const needsGroupInvoice = input.manualPaymentReason === GROUP_INVOICE;
  const subject = needsGroupInvoice
    ? `Action needed: group invoice for ${name}, ${guestCount} guests (${input.reference})`
    : input.requiresManualPaymentLink
      ? `Action needed: availability request from ${name} (${input.reference})`
      : `Action needed: ${name} booked 8 Lakes (${input.reference})`;
  const pricePerPerson = input.pricePerPersonUsd ? usd(input.pricePerPersonUsd) : TOTAL_PRICE_USD;
  const onlinePayment = input.onlinePaymentUsd ? usd(input.onlinePaymentUsd) : ONLINE_PAYMENT_USD;
  const familyCash = input.localFamilyPaymentUsd ? usd(input.localFamilyPaymentUsd) : FAMILY_CASH_USD;
  const totalTripValue = input.totalTripValueUsd ? usd(input.totalTripValueUsd) : TOTAL_PRICE_USD;
  const operatorPaymentStep = needsGroupInvoice
    ? `Send one personal Stripe invoice for ${onlinePayment} covering all ${guestCount} guests, then confirm the booking once it is paid.`
    : input.requiresManualPaymentLink
      ? 'Confirm date/horse/guide/host-family capacity, then create or send the correct Stripe payment link/custom order for the online reservation amount.'
      : 'Stripe payment should auto-match via webhook and mark the booking confirmed/paid. Only check Stripe manually if the dashboard has not updated after a few minutes.';
  const kind = needsGroupInvoice ? 'group booking (invoice needed)' : input.requiresManualPaymentLink ? 'availability request' : 'booking';
  const text = `New 8 Lakes ${kind}\n\nReference: ${input.reference}\nGuest: ${name}\nEmail: ${input.email}\nPhone: ${input.phone || 'Not provided'}\nTour date: ${input.tourDate || 'TBC'}\nGuests: ${guestCount}\nTraveller names:\n${input.travellerNames || name}\nPrice: ${pricePerPerson} per person / ${totalTripValue} total\nOnline reservation due: ${onlinePayment}\nLocal family cash: ${familyCash}\nRiding experience: ${input.ridingExperience || 'Not provided'}\n\nOperator checklist:\n1. Open the 8 Lakes ops dashboard and confirm ${input.reference} is visible.\n2. ${operatorPaymentStep}\n3. Reply personally if anything looks odd or needs referral/review.\n4. Make sure the guest knows to bring ${familyCash} clean USD cash for the host family.\n\nNotes:\n${input.notes || 'None'}`;

  const body = [
    p(`<strong>${escapeHtml(name)}</strong> submitted the ${escapeHtml(kind)} form. Reference <strong>${escapeHtml(input.reference)}</strong>.`),
    detailsHtml([
      ['Reference', escapeHtml(input.reference)],
      ['Name', escapeHtml(name)],
      ['Email', `<a href="mailto:${escapeHtml(input.email)}" style="color:#1155cc">${escapeHtml(input.email)}</a>`],
      ['Phone', escapeHtml(input.phone || 'Not provided')],
      ['Tour date', escapeHtml(input.tourDate || 'TBC')],
      ['Guests', `${guestCount}`],
      ['Traveller names', nl2br(input.travellerNames || name)],
      ['Price', `${escapeHtml(pricePerPerson)} pp / ${escapeHtml(totalTripValue)} total`],
      ['Online reservation due', escapeHtml(onlinePayment)],
      ['Local family cash', escapeHtml(familyCash)],
      ['Riding experience', escapeHtml(input.ridingExperience || 'Not provided')],
    ]),
    p('<strong>Operator checklist</strong>'),
    `    <ol style="margin:0 0 16px;padding-left:20px">` +
      `<li>Open the <a href="${OPS_URL}/bookings" style="color:#1155cc">8 Lakes ops dashboard</a> and confirm <strong>${escapeHtml(input.reference)}</strong> is visible.</li>` +
      `<li>${escapeHtml(operatorPaymentStep)}</li>` +
      `<li>Reply personally if anything looks odd or needs referral/review.</li>` +
      `<li>Make sure the guest knows to bring <strong>${escapeHtml(familyCash)} clean USD cash</strong> for the host family.</li>` +
      `</ol>`,
    p('<strong>Guest notes</strong>'),
    p(nl2br(input.notes)),
    signoffHtml(false),
  ].join('\n');

  return {
    subject,
    text,
    html: wrap(
      needsGroupInvoice
        ? `${name} booked ${input.tourDate || 'a future 8 Lakes date'} for ${guestCount} guests. Send a ${onlinePayment} invoice.`
        : input.requiresManualPaymentLink
          ? `${name} requested availability for ${guestCount} guest${guestCount === 1 ? '' : 's'}. Confirm manually before payment.`
          : `${name} booked ${input.tourDate || 'a future 8 Lakes date'}. Check the 8 Lakes ops dashboard; Stripe should auto-match after payment.`,
      body,
    ),
  };
}

export function bookingCustomerEmail(input: { reference: string; firstName: string; tourDate: string; guestCount?: number; pricePerPersonUsd?: number; onlinePaymentUsd?: number; localFamilyPaymentUsd?: number; totalTripValueUsd?: number; requiresManualPaymentLink?: boolean; manualPaymentReason?: string | null; travellerNames?: string; paymentUrl?: string }) {
  const subject = `Your 8 Lakes Tours booking (${input.reference})`;
  const name = firstName(input.firstName);
  const guestCount = input.guestCount ?? 1;
  const needsGroupInvoice = input.manualPaymentReason === GROUP_INVOICE;
  const pricePerPerson = input.pricePerPersonUsd ? usd(input.pricePerPersonUsd) : TOTAL_PRICE_USD;
  const onlinePayment = input.onlinePaymentUsd ? usd(input.onlinePaymentUsd) : ONLINE_PAYMENT_USD;
  const familyCash = input.localFamilyPaymentUsd ? usd(input.localFamilyPaymentUsd) : FAMILY_CASH_USD;
  const totalTripValue = input.totalTripValueUsd ? usd(input.totalTripValueUsd) : TOTAL_PRICE_USD;
  const resumeLine = input.paymentUrl ? `Resume your secure payment (no new booking needed): ${input.paymentUrl}` : '';

  const paymentIntro = needsGroupInvoice
    ? `Since you are booking ${guestCount} guests together, Robert will email you one invoice for the ${onlinePayment} online amount so the whole group can pay in a single step. Your places are confirmed once that invoice is paid.`
    : input.requiresManualPaymentLink
      ? `Since this date or group needs an availability check, Robert will personally confirm the details before you pay. If the date, group size, horses, guide, and host-family capacity all work, Robert will send you the correct payment link.`
      : `Your place is not confirmed yet. That happens once the ${onlinePayment} online booking payment is completed. You will get an automatic payment confirmation email once Stripe checkout completes.`;

  const steps = needsGroupInvoice
    ? `1. Robert will email one invoice for ${onlinePayment}, covering all ${guestCount} guests.\n2. Pay that invoice to reserve the group's places.\n3. We send preparation notes before departure once the booking is confirmed.`
    : input.requiresManualPaymentLink
      ? `1. Robert will check the date, group size, horses, guide, and host-family capacity.\n2. If everything is available, Robert will send the correct Stripe payment link or custom order for the online reservation amount.\n3. We send preparation notes before departure once the booking is confirmed.`
      : `1. Complete the online booking payment on the website if you have not already done so.\n2. You will receive an automatic payment confirmation email once Stripe checkout completes.\n3. Before departure we send practical prep notes: packing guidance, insurance reminders, WhatsApp coordination, Bat-Ulzii pickup timing, and cash-payment instructions.`;

  const text = `Hi ${name},

Thanks for booking with 8 Lakes Tours. Your details are all in.

${DASH_RULE_TEXT}

Booking reference: ${input.reference}
Tour date: ${input.tourDate || 'TBC'}
Guests: ${guestCount}

Submitted traveller names:
${input.travellerNames || input.firstName}

${DASH_RULE_TEXT}

How the payment is split:
Total trip price: ${pricePerPerson} per person / ${totalTripValue} total
Online booking payment: ${onlinePayment}
Cash for the host family in Mongolia: ${familyCash}

The ${familyCash} family portion is not collected online. Please plan to bring clean USD notes to Mongolia and pay the family directly. Many host families cannot reliably receive cards or bank transfers, so cash is what works.

${paymentIntro}

${DASH_RULE_TEXT}

A few things worth knowing before you travel:

Food: traditional host-family food is meat- and dairy-heavy. Families make their own milk from yaks or cows and serve it fresh as milk tea, yoghurt, cheese, and other traditional foods.

Packing: Mongolia's steppe weather can change fast. Pack for all seasons, even in summer, and bring more warm layers than you think you need.

Facilities: once you leave the city, countryside toilets are simple outhouses with squat toilets rather than Western flush toilets, and there are no regular showers. Bring wet wipes for cleaning hands and body between river washes. Washing in the river can be part of the simple steppe rhythm when conditions allow.

Translation: English is not always strong in the host-family setting. ChatGPT voice mode has been the easiest way to communicate so far: say "Please translate the following sentence into Mongolian for me," then speak naturally and play or show the translation. Other translation apps help too.

What happens next:
${steps}
${resumeLine ? `\n${resumeLine}\n` : ''}
The preparation and arrival emails for this booking are separate from the general newsletter. Please plan to bring ${familyCash} in clean USD notes for the host family.

If anything comes up, just reply to this email.

Robert Zaher
8 Lakes Tours
www.8lakestours.com
info@8lakestours.com`;

  const resumeHtml = input.paymentUrl
    ? p(`Resume secure payment for this booking (no new booking needed, keep this link private): <a href="${escapeHtml(input.paymentUrl)}" style="color:#1155cc">${escapeHtml(input.paymentUrl)}</a>`)
    : '';
  const body = [
    p(`Hi ${escapeHtml(name)},`),
    p(`Thanks for booking with 8 Lakes Tours. Your details are all in.`),
    sectionRuleHtml(),
    detailsHtml([
      ['Booking reference', escapeHtml(input.reference)],
      ['Tour date', escapeHtml(input.tourDate || 'TBC')],
      ['Guests', `${guestCount}`],
    ]),
    p('<strong>Submitted traveller names</strong>'),
    p(nl2br(input.travellerNames || input.firstName)),
    sectionRuleHtml(),
    p('<strong>How the payment is split</strong>'),
    p(`Total trip price: ${escapeHtml(pricePerPerson)} per person / ${escapeHtml(totalTripValue)} total<br>Online booking payment: ${escapeHtml(onlinePayment)}<br>Cash for the host family in Mongolia: ${escapeHtml(familyCash)}`),
    p(`The ${escapeHtml(familyCash)} family portion is not collected online. Please plan to bring clean USD notes to Mongolia and pay the family directly. Many host families cannot reliably receive cards or bank transfers, so cash is what works.`),
    p(paymentIntro),
    sectionRuleHtml(),
    p('<strong>A few things worth knowing before you travel</strong>'),
    p(`<strong>Food:</strong> traditional host-family food is meat- and dairy-heavy. Families make their own milk from yaks or cows and serve it fresh as milk tea, yoghurt, cheese, and other traditional foods.`),
    p(`<strong>Packing:</strong> Mongolia&#39;s steppe weather can change fast. Pack for all seasons, even in summer, and bring more warm layers than you think you need.`),
    p(`<strong>Facilities:</strong> once you leave the city, countryside toilets are simple outhouses with squat toilets rather than Western flush toilets, and there are no regular showers. Bring wet wipes for cleaning hands and body between river washes. Washing in the river can be part of the simple steppe rhythm when conditions allow.`),
    p(`<strong>Translation:</strong> English is not always strong in the host-family setting. ChatGPT voice mode has been the easiest way to communicate so far: say &quot;Please translate the following sentence into Mongolian for me,&quot; then speak naturally and play or show the translation. Other translation apps help too.`),
    p('<strong>What happens next</strong>'),
    `    <p style="margin:0 0 16px;white-space:pre-line">${escapeHtml(steps)}</p>`,
    resumeHtml,
    p(`The preparation and arrival emails for this booking are separate from the general newsletter. Please plan to bring ${escapeHtml(familyCash)} in clean USD notes for the host family.`),
    p(`If anything comes up, just reply to this email.`),
    signoffHtml(),
  ].join('\n');

  return {
    subject,
    text,
    html: wrap(
      needsGroupInvoice
        ? `Reference ${input.reference}. Robert will email a ${onlinePayment} invoice for your group.`
        : input.requiresManualPaymentLink
          ? `Reference ${input.reference}. Robert will confirm availability before payment.`
          : `Reference ${input.reference}. Your place is confirmed once the ${onlinePayment} online booking payment is completed.`,
      body,
    ),
  };
}

export function paymentReceivedInternalEmail(input: LifecycleEmailInput & { amountUsd: number; customerName: string; customerEmail: string; stripeReference: string }) {
  const amount = `$${input.amountUsd.toLocaleString('en-US')}`;
  const subject = `Payment received: ${input.customerName} ${input.reference}`;
  const text = `8 Lakes payment received\n\nReference: ${input.reference}\nGuest: ${input.customerName}\nEmail: ${input.customerEmail}\nTour date: ${input.tourDate || 'TBC'}\nOnline payment received: ${amount}\nStripe reference: ${input.stripeReference}\n\nThe booking has been matched by the Stripe webhook and marked paid/confirmed in the ops dashboard.`;

  const body = [
    p(`<strong>${escapeHtml(input.customerName)}</strong> has paid the online reservation amount for booking <strong>${escapeHtml(input.reference)}</strong>.`),
    detailsHtml([
      ['Reference', escapeHtml(input.reference)],
      ['Guest', escapeHtml(input.customerName)],
      ['Email', `<a href="mailto:${escapeHtml(input.customerEmail)}" style="color:#1155cc">${escapeHtml(input.customerEmail)}</a>`],
      ['Tour date', escapeHtml(input.tourDate || 'TBC')],
      ['Online payment received', escapeHtml(amount)],
      ['Stripe reference', escapeHtml(input.stripeReference)],
    ]),
    p(`The Stripe webhook matched this payment to the booking and marked the online reservation amount as paid in the ops dashboard. Open the <a href="${OPS_URL}/ops/bookings/${escapeHtml(input.reference)}" style="color:#1155cc">booking record</a>.`),
    signoffHtml(false),
  ].join('\n');

  return {
    subject,
    text,
    html: wrap(`${amount} Stripe payment matched for ${input.reference}.`, body),
  };
}

export function paymentConfirmedCustomerEmail(input: LifecycleEmailInput & { amountUsd: number }) {
  const familyCash = lifecycleFamilyCash(input);
  const subject = `Payment received for your 8 Lakes booking (${input.reference})`;
  const name = firstName(input.firstName);
  const amount = `$${input.amountUsd.toLocaleString('en-US')}`;

  const text = `Hi ${name},

We have received your ${amount} online booking payment. Your place is confirmed.

Booking reference: ${input.reference}
Tour date: ${input.tourDate || 'TBC'}
Online payment received: ${amount}
Paid locally in Mongolia: ${familyCash}

${DASH_RULE_TEXT}

The remaining ${familyCash} goes directly to the host family in Mongolia, in clean USD cash.

Next we send preparation notes, packing guidance, insurance reminders, and arrival coordination before departure.

If anything comes up before then, just reply to this email.

Robert Zaher
8 Lakes Tours
www.8lakestours.com
info@8lakestours.com`;

  const body = [
    p(`Hi ${escapeHtml(name)},`),
    p(`We have received your <strong>${escapeHtml(amount)}</strong> online booking payment. Your place is confirmed.`),
    detailsHtml([
      ['Booking reference', escapeHtml(input.reference)],
      ['Tour date', escapeHtml(input.tourDate || 'TBC')],
      ['Online payment received', escapeHtml(amount)],
      ['Paid locally in Mongolia', escapeHtml(familyCash)],
    ]),
    sectionRuleHtml(),
    p(`The remaining ${escapeHtml(familyCash)} goes directly to the host family in Mongolia, in clean USD cash.`),
    p(`Next we send preparation notes, packing guidance, insurance reminders, and arrival coordination before departure.`),
    p(`If anything comes up before then, just reply to this email.`),
    signoffHtml(),
  ].join('\n');

  return {
    subject,
    text,
    html: wrap(`Payment received for booking ${input.reference}. Your 8 Lakes Tours place is confirmed.`, body),
  };
}

export function preparationCustomerEmail(input: LifecycleEmailInput) {
  const familyCash = lifecycleFamilyCash(input);
  const subject = `Getting ready for Mongolia (${input.reference})`;
  const name = firstName(input.firstName);
  const text = `Hi ${name},

Here is how to prepare for your 8 Lakes Tours trip.

Booking reference: ${input.reference}
Tour date: ${input.tourDate || 'TBC'}
Cash for the host family: ${familyCash} (clean USD notes, paid directly in Mongolia)

${DASH_RULE_TEXT}

Packing: pack for all seasons, even in summer. Steppe weather moves quickly between warm sun, cold wind, rain, and very cold nights. Bring warm layers, waterproof outerwear, comfortable riding clothes, warm socks, a hat, gloves, and basic toiletries.

Facilities: once outside the city, expect simple outhouse squat toilets rather than Western flush toilets, and no regular showers. Bring wet wipes for cleaning hands and body between river washes.

Food: meals are traditional host-family food, meat- and dairy-heavy, with fresh milk tea, yoghurt, cheese, and other local foods. Strict vegan or serious dairy-free needs are difficult in this remote setting.

Getting from Ulaanbaatar to Bat-Ulzii: this part needs a little planning. Arrive in Ulaanbaatar at least two days before your tour date so there is time to sort the countryside bus and any schedule changes. Book a hostel or hotel in Ulaanbaatar and ask them to help book your bus ticket to Bat-Ulzii. These buses do not run every day, so please do not leave it until the last minute. Once your bus is booked, send us the details and we will coordinate the host-family pickup on the Bat-Ulzii side.

Getting around Ulaanbaatar: the tapa. app works well for scooter and bicycle rental and accepts international cards: https://apps.apple.com/app/id1563199559

Insurance: please make sure you have travel insurance that covers horseback riding or adventure activity and emergency evacuation.

${DASH_RULE_TEXT}

Any last questions, just reply to this email.

Robert Zaher
8 Lakes Tours
www.8lakestours.com
info@8lakestours.com`;

  const body = [
    p(`Hi ${escapeHtml(name)},`),
    p(`Here is how to prepare for your 8 Lakes Tours trip.`),
    detailsHtml([
      ['Booking reference', escapeHtml(input.reference)],
      ['Tour date', escapeHtml(input.tourDate || 'TBC')],
      ['Cash for the host family', `${escapeHtml(familyCash)} (clean USD notes, paid directly in Mongolia)`],
    ]),
    sectionRuleHtml(),
    p(`<strong>Packing:</strong> pack for all seasons, even in summer. Steppe weather moves quickly between warm sun, cold wind, rain, and very cold nights. Bring warm layers, waterproof outerwear, comfortable riding clothes, warm socks, a hat, gloves, and basic toiletries.`),
    p(`<strong>Facilities:</strong> once outside the city, expect simple outhouse squat toilets rather than Western flush toilets, and no regular showers. Bring wet wipes for cleaning hands and body between river washes.`),
    p(`<strong>Food:</strong> meals are traditional host-family food, meat- and dairy-heavy, with fresh milk tea, yoghurt, cheese, and other local foods. Strict vegan or serious dairy-free needs are difficult in this remote setting.`),
    p(`<strong>Getting from Ulaanbaatar to Bat-Ulzii:</strong> this part needs a little planning. Arrive in Ulaanbaatar at least <strong>two days before your tour date</strong> so there is time to sort the countryside bus and any schedule changes. Book a hostel or hotel in Ulaanbaatar and ask them to help book your bus ticket to Bat-Ulzii. These buses do not run every day, so please do not leave it until the last minute. Once your bus is booked, send us the details and we will coordinate the host-family pickup on the Bat-Ulzii side.`),
    p(`<strong>Getting around Ulaanbaatar:</strong> the <a href="https://apps.apple.com/app/id1563199559" style="color:#1155cc">tapa. app</a> works well for scooter and bicycle rental and accepts international cards.`),
    p(`<strong>Insurance:</strong> please make sure you have travel insurance that covers horseback riding or adventure activity and emergency evacuation.`),
    sectionRuleHtml(),
    p(`Any last questions, just reply to this email.`),
    signoffHtml(),
  ].join('\n');

  return {
    subject,
    text,
    html: wrap(`Packing, food, facilities, insurance, and practical prep for booking ${input.reference}.`, body),
  };
}

export function insuranceReminderCustomerEmail(input: LifecycleEmailInput) {
  const familyCash = lifecycleFamilyCash(input);
  const subject = `Travel insurance check (${input.reference})`;
  const name = firstName(input.firstName);
  const text = `Hi ${name},

A quick check before your 8 Lakes Tours departure.

Booking reference: ${input.reference}
Tour date: ${input.tourDate || 'TBC'}

${DASH_RULE_TEXT}

Please make sure your travel insurance is active and covers horseback riding or adventure activity, medical treatment, emergency evacuation, and repatriation. Not every standard policy includes horseback riding, so it is worth double checking that part.

Also check that your passport, flights, warm layers, personal medication, first-aid basics, and ${familyCash} clean USD cash for the host family are sorted.

Any last questions, just reply to this email.

Robert Zaher
8 Lakes Tours
www.8lakestours.com
info@8lakestours.com`;

  const body = [
    p(`Hi ${escapeHtml(name)},`),
    p(`A quick check before your 8 Lakes Tours departure.`),
    detailsHtml([
      ['Booking reference', escapeHtml(input.reference)],
      ['Tour date', escapeHtml(input.tourDate || 'TBC')],
    ]),
    sectionRuleHtml(),
    p(`Please make sure your travel insurance is active and covers <strong>horseback riding or adventure activity, medical treatment, emergency evacuation, and repatriation</strong>. Not every standard policy includes horseback riding, so it is worth double checking that part.`),
    p(`Also check that your passport, flights, warm layers, personal medication, first-aid basics, and ${escapeHtml(familyCash)} clean USD cash for the host family are sorted.`),
    p(`Any last questions, just reply to this email.`),
    signoffHtml(),
  ].join('\n');

  return {
    subject,
    text,
    html: wrap(`Insurance, documents, cash, and final preparation check for booking ${input.reference}.`, body),
  };
}

export function arrivalCoordinationCustomerEmail(input: LifecycleEmailInput) {
  const name = firstName(input.firstName);
  const text = `Hi ${name},

Your 8 Lakes Tours departure is getting close.

Booking reference: ${input.reference}
Tour date: ${input.tourDate || 'TBC'}

${DASH_RULE_TEXT}

Please reply with your Ulaanbaatar arrival details and your Bat-Ulzii bus date and time once booked, so we can coordinate the host-family pickup.

The countryside bus does not run every day, so ask your Ulaanbaatar hostel or hotel to help book it. Once your bus timing is confirmed, Robert will coordinate the pickup from Bat-Ulzii. Please do not assume the pickup is final until it is confirmed in writing.

Keep your travel insurance, passport, warm layers, and clean USD cash for the host family ready.

Robert Zaher
8 Lakes Tours
www.8lakestours.com
info@8lakestours.com`;

  const body = [
    p(`Hi ${escapeHtml(name)},`),
    p(`Your 8 Lakes Tours departure is getting close.`),
    detailsHtml([
      ['Booking reference', escapeHtml(input.reference)],
      ['Tour date', escapeHtml(input.tourDate || 'TBC')],
    ]),
    sectionRuleHtml(),
    p(`Please reply with your Ulaanbaatar arrival details and your Bat-Ulzii bus date and time once booked, so we can coordinate the host-family pickup.`),
    p(`The countryside bus does not run every day, so ask your Ulaanbaatar hostel or hotel to help book it. Once your bus timing is confirmed, Robert will coordinate the pickup from Bat-Ulzii. Please do not assume the pickup is final until it is confirmed in writing.`),
    p(`Keep your travel insurance, passport, warm layers, and clean USD cash for the host family ready.`),
    signoffHtml(),
  ].join('\n');

  return {
    subject: `Arrival and Bat-Ulzii pickup (${input.reference})`,
    text,
    html: wrap(`Arrival coordination for booking ${input.reference}.`, body),
  };
}

export function finalChecklistCustomerEmail(input: LifecycleEmailInput) {
  const name = firstName(input.firstName);
  const text = `Hi ${name},

A final check before your 8 Lakes Tours departure.

Booking reference: ${input.reference}
Tour date: ${input.tourDate || 'TBC'}

${DASH_RULE_TEXT}

Passport, insurance covering riding and emergency evacuation, flights and bus, warm layers, medication, and clean USD cash for the host family.

If anything has changed, just reply.

Robert Zaher
8 Lakes Tours
www.8lakestours.com
info@8lakestours.com`;

  const body = [
    p(`Hi ${escapeHtml(name)},`),
    p(`A final check before your 8 Lakes Tours departure.`),
    detailsHtml([
      ['Booking reference', escapeHtml(input.reference)],
      ['Tour date', escapeHtml(input.tourDate || 'TBC')],
    ]),
    sectionRuleHtml(),
    p(`Passport, insurance covering riding and emergency evacuation, flights and bus, warm layers, medication, and clean USD cash for the host family.`),
    p(`If anything has changed, just reply.`),
    signoffHtml(),
  ].join('\n');

  return {
    subject: `Final check before Mongolia (${input.reference})`,
    text,
    html: wrap(`Final departure check for booking ${input.reference}.`, body),
  };
}

export function leadInternalEmail(input: { name: string; email: string; source: string; interest: string }) {
  const name = input.name || 'Subscriber';
  const text = `New newsletter subscriber\n\nName: ${name}\nEmail: ${input.email}\nInterest: ${input.interest}\nSource: ${input.source}`;
  const body = [
    p(`<strong>${escapeHtml(input.email)}</strong> joined the 8 Lakes newsletter list.`),
    detailsHtml([
      ['Name', escapeHtml(name)],
      ['Email', `<a href="mailto:${escapeHtml(input.email)}" style="color:#1155cc">${escapeHtml(input.email)}</a>`],
      ['Interest', escapeHtml(input.interest || 'Not provided')],
      ['Source', escapeHtml(input.source || 'website')],
    ]),
    signoffHtml(false),
  ].join('\n');
  return {
    subject: `New 8 Lakes newsletter subscriber: ${input.email}`,
    text,
    html: wrap(`${input.email} joined the 8 Lakes newsletter list.`, body),
  };
}

export function leadCustomerEmail(input: { name: string }) {
  const greetingName = input.name ? firstName(input.name) : '';
  const greeting = greetingName ? `Hi ${escapeHtml(greetingName)},` : 'Hi,';
  const subject = 'Welcome to the 8 Lakes Tours newsletter';
  const text = `${greetingName ? `Hi ${greetingName},` : 'Hi,'}\n\nThanks for joining the 8 Lakes Tours newsletter. We send occasional updates about Mongolia horse trekking, new departure dates, offers, deals, blog posts, field notes, and news from the business.\n\nNo booking has been made from this signup. If you ever want to reserve a place, you can do that on the website: ${SITE_URL}/#application\n\nYou can opt out any time by replying to this email.\n\nRob Zaher\n8 Lakes Tours\nwww.8lakestours.com\ninfo@8lakestours.com`;
  const body = [
    p(greeting),
    p(`Thanks for joining the 8 Lakes Tours newsletter. We send occasional updates about Mongolia horse trekking, new departure dates, offers, deals, blog posts, field notes, and news from the business.`),
    p(`No booking has been made from this signup. If you ever want to reserve a place, you can do that on the website: <a href="${SITE_URL}/#application" style="color:#1155cc">${SITE_URL}/#application</a>`),
    p(`You can opt out any time by replying to this email.`),
    signoffHtml(),
  ].join('\n');
  return {
    subject,
    text,
    html: wrap('Occasional 8 Lakes Tours news, offers, dates, blog posts, and field notes.', body),
  };
}
