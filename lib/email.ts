import { Resend } from 'resend';
import { GROUP_INVOICE } from './tour-booking.mjs';

const DEFAULT_FROM = '8 Lakes Tours <info@8lakestours.com>';
const DEFAULT_INTERNAL_RECIPIENTS = ['8lakestours@gmail.com'];
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.8lakestours.com';
const OPS_URL = process.env.OPS_BASE_URL || 'https://adventure-therapy-ops.vercel.app';
const TOTAL_PRICE_USD = '$1,999';
const ONLINE_PAYMENT_USD = '$999';
const FAMILY_CASH_USD = '$1,000';

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
};

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

function emailShell({ preheader, title, intro, children, footer = true }: { preheader: string; title: string; intro?: string; children: string; footer?: boolean }) {
  return `
    <style>html,body{margin:0!important;padding:0!important;width:100%!important;} table{border-collapse:collapse;}</style>
    <div style="display:none;max-height:0;overflow:hidden;color:transparent;opacity:0">${escapeHtml(preheader)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fffaf1;margin:0;padding:0;font-family:Arial,Helvetica,sans-serif;color:#241d14">
      <tr>
        <td align="left" style="padding:0">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;max-width:none;background:#fffaf1;border:0;border-radius:0;overflow:hidden;box-shadow:none">
            <tr>
              <td style="background:#171209;padding:15px 12px 14px;color:#f8eedb;border-bottom:4px solid #c8a96e">
                <p style="margin:0 0 10px;text-transform:uppercase;letter-spacing:.22em;font-size:11px;color:#c8a96e;font-weight:700">8 Lakes Tours</p>
                <h1 style="margin:0;font-family:Georgia,'Times New Roman',serif;font-weight:400;font-size:34px;line-height:1.05;color:#fff8ea">${title}</h1>
                ${intro ? `<p style="margin:14px 0 0;color:#e9dcc6;font-size:16px;line-height:1.55">${intro}</p>` : ''}
              </td>
            </tr>
            <tr>
              <td style="padding:13px 12px 16px">
                ${children}
                ${footer ? `
                  <hr style="border:0;border-top:1px solid #eadcc6;margin:22px 0 14px">
                  <p style="margin:0 0 6px;color:#5f513f;font-size:14px;line-height:1.55">Questions? Reply to this email or write to <a href="mailto:info@8lakestours.com" style="color:#8a5a13">info@8lakestours.com</a>.</p>
                  <p style="margin:0;color:#8b7a63;font-size:13px">8 Lakes Tours · Mongolia horse trekking · Orkhon Valley & Eight Lakes region</p>
                ` : ''}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  `;
}

function pill(label: string, value: string, detail: string) {
  return `
    <td style="width:33.333%;padding:4px" valign="top">
      <div style="border-left:4px solid #c8a96e;background:#fff6e7;border-radius:0;padding:11px;min-height:82px">
        <p style="margin:0 0 6px;text-transform:uppercase;letter-spacing:.12em;color:#8a6a2c;font-size:11px;font-weight:700">${label}</p>
        <p style="margin:0;color:#241d14;font-size:24px;font-weight:700;line-height:1">${value}</p>
        <p style="margin:8px 0 0;color:#6c5c48;font-size:13px;line-height:1.35">${detail}</p>
      </div>
    </td>
  `;
}

function detailRow(label: string, value: string) {
  return `
    <tr>
      <td style="padding:10px 0;border-bottom:1px solid #efe2ce;color:#7b6a54;font-size:13px;text-transform:uppercase;letter-spacing:.08em;width:34%">${label}</td>
      <td style="padding:10px 0;border-bottom:1px solid #efe2ce;color:#241d14;font-size:15px;font-weight:700">${value}</td>
    </tr>
  `;
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
  const text = `New 8 Lakes ${needsGroupInvoice ? 'group booking (invoice needed)' : input.requiresManualPaymentLink ? 'availability request' : 'booking'}\n\nReference: ${input.reference}\nGuest: ${name}\nEmail: ${input.email}\nPhone: ${input.phone || 'Not provided'}\nTour date: ${input.tourDate || 'TBC'}\nGuests: ${guestCount}\nTraveller names:\n${input.travellerNames || name}\nPrice: ${pricePerPerson} per person / ${totalTripValue} total\nOnline reservation due: ${onlinePayment}\nLocal family cash: ${familyCash}\nRiding experience: ${input.ridingExperience || 'Not provided'}\n\nOperator checklist:\n1. Open the 8 Lakes ops dashboard and confirm ${input.reference} is visible.\n2. ${operatorPaymentStep}\n3. Reply personally if anything looks odd or needs referral/review.\n4. Make sure the guest knows to bring ${familyCash} clean USD cash for the host family.\n\nNotes:\n${input.notes || 'None'}`;

  return {
    subject,
    text,
    html: emailShell({
      preheader: needsGroupInvoice ? `${name} booked ${input.tourDate || 'a future 8 Lakes date'} for ${guestCount} guests. Send a ${onlinePayment} invoice.` : input.requiresManualPaymentLink ? `${name} requested availability for ${guestCount} guest${guestCount === 1 ? '' : 's'}. Confirm manually before payment.` : `${name} booked ${input.tourDate || 'a future 8 Lakes date'}. Check the 8 Lakes ops dashboard; Stripe should auto-match after payment.`,
      title: needsGroupInvoice ? 'New group booking — invoice needed' : input.requiresManualPaymentLink ? 'New availability request received' : 'New booking received',
      intro: needsGroupInvoice ? `<strong>${escapeHtml(name)}</strong> booked ${guestCount} guests together on a fixed date. Send one personal invoice for <strong>${onlinePayment}</strong>; the public Buy Button cannot collect a group amount.` : input.requiresManualPaymentLink ? `<strong>${escapeHtml(name)}</strong> submitted an availability request for ${guestCount} guest${guestCount === 1 ? '' : 's'}. Confirm availability and send the correct payment link/custom order before taking payment.` : `<strong>${escapeHtml(name)}</strong> submitted the booking form. Payment should automatically match and confirm the booking once Stripe checkout completes.`,
      footer: false,
      children: `
        <div style="border-left:4px solid #c8a96e;background:#fff3dd;padding:12px 14px;margin-bottom:16px">
          <p style="margin:0 0 8px;text-transform:uppercase;letter-spacing:.12em;font-size:12px;color:#8a6a2c;font-weight:700">Operator checklist</p>
          <ol style="margin:0;padding-left:20px;color:#3a3024;line-height:1.7;font-size:15px">
            <li>Open the 8 Lakes ops dashboard and confirm <strong>${escapeHtml(input.reference)}</strong> is visible.</li>
            <li>${escapeHtml(operatorPaymentStep)}</li>
            <li>Reply personally if the booking needs clarification, referral, or review.</li>
            <li>Make sure the guest knows to bring <strong>${familyCash} clean USD cash</strong> for the host family.</li>
          </ol>
          <p style="margin:14px 0 0"><a href="${OPS_URL}/bookings" style="display:inline-block;background:#241d14;color:#fff8ea;text-decoration:none;border-radius:0;padding:10px 14px;font-size:12px;text-transform:uppercase;letter-spacing:.12em;font-weight:700">Open 8 Lakes ops</a></p>
        </div>

        <h2 style="font-family:Georgia,'Times New Roman',serif;font-weight:400;font-size:24px;margin:0 0 10px;color:#241d14">Guest details</h2>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:20px">
          ${detailRow('Reference', escapeHtml(input.reference))}
          ${detailRow('Name', escapeHtml(name))}
          ${detailRow('Email', `<a href="mailto:${escapeHtml(input.email)}" style="color:#8a5a13">${escapeHtml(input.email)}</a>`)}
          ${detailRow('Phone', escapeHtml(input.phone || 'Not provided'))}
          ${detailRow('Tour date', escapeHtml(input.tourDate || 'TBC'))}
          ${detailRow('Guests', `${guestCount}`)}
          ${detailRow('Traveller names', nl2br(input.travellerNames || name))}
          ${detailRow('Price', `${pricePerPerson} pp / ${totalTripValue} total`)}
          ${detailRow('Riding level', escapeHtml(input.ridingExperience || 'Not provided'))}
        </table>

        <div style="border-left:4px solid #eadcc6;padding:12px 14px;background:#fffdf8">
          <p style="margin:0 0 8px;text-transform:uppercase;letter-spacing:.12em;font-size:12px;color:#8a6a2c;font-weight:700">Guest notes</p>
          <p style="margin:0;color:#3a3024;line-height:1.6">${nl2br(input.notes)}</p>
        </div>
      `,
    }),
  };
}

export function bookingCustomerEmail(input: { reference: string; firstName: string; tourDate: string; guestCount?: number; pricePerPersonUsd?: number; onlinePaymentUsd?: number; localFamilyPaymentUsd?: number; totalTripValueUsd?: number; requiresManualPaymentLink?: boolean; manualPaymentReason?: string | null; travellerNames?: string; paymentUrl?: string }) {
  const subject = `8 Lakes Tours booking received — ${input.reference}`;
  const paymentRecovery = input.paymentUrl ? `Resume your secure payment (no new booking needed): ${input.paymentUrl}` : '';
  const name = firstName(input.firstName);
  const guestCount = input.guestCount ?? 1;
  const needsGroupInvoice = input.manualPaymentReason === GROUP_INVOICE;
  const pricePerPerson = input.pricePerPersonUsd ? usd(input.pricePerPersonUsd) : TOTAL_PRICE_USD;
  const onlinePayment = input.onlinePaymentUsd ? usd(input.onlinePaymentUsd) : ONLINE_PAYMENT_USD;
  const familyCash = input.localFamilyPaymentUsd ? usd(input.localFamilyPaymentUsd) : FAMILY_CASH_USD;
  const totalTripValue = input.totalTripValueUsd ? usd(input.totalTripValueUsd) : TOTAL_PRICE_USD;
  const paymentIntro = needsGroupInvoice
    ? `Because you are booking ${guestCount} guests together, our team will email you one personal invoice for the ${onlinePayment} online amount so the whole group can pay in a single step.`
    : input.requiresManualPaymentLink
      ? `Because this date or group needs an availability check, our team will personally confirm the details and the correct payment link before you pay.`
      : `Your place is confirmed once the online booking payment has been completed.`;
  const nextSteps = needsGroupInvoice
    ? `1. Our team will email a personal invoice for ${onlinePayment}, covering all ${guestCount} guests.\n2. Pay that invoice to reserve the group's places.\n3. We send preparation notes before departure once the booking is confirmed.`
    : input.requiresManualPaymentLink
      ? `1. Our team will check the date, group size, horses, guide, and host-family capacity.\n2. If everything is available, we will send the correct Stripe payment link or custom order for the online reservation amount.\n3. We send preparation notes before departure once the booking is confirmed.`
      : `1. Complete the online booking payment on the website if you have not already done so.\n2. You will receive an automatic payment confirmation email once Stripe checkout completes.\n3. We send preparation notes before departure.`;
  const text = `Hi ${name},\n\nThanks — your 8 Lakes Tours ${needsGroupInvoice ? 'group booking' : input.requiresManualPaymentLink ? 'availability request' : 'booking'} has been received.\n\nBooking reference: ${input.reference}\nSelected tour date: ${input.tourDate || 'TBC'}\nGuests: ${guestCount}\n\nSubmitted traveller names:\n${input.travellerNames || input.firstName}\n\nPayment structure:\nTotal 2026 trip price: ${pricePerPerson} per person / ${totalTripValue} total\nOnline booking payment: ${onlinePayment}\nCash paid directly to the host family in Mongolia: ${familyCash}\n\n${paymentIntro} The ${familyCash} family portion is not collected online; please plan to bring clean USD notes to Mongolia for the host family.\n\nFood note:\nTraditional host-family food is meat- and dairy-heavy. For guests who can enjoy it, the dairy is one of the highest-quality parts of the trip: families always produce their own milk from yaks or cows and serve it fresh as milk tea, yoghurt, cheese, and other traditional foods.\n\nPacking note:\nMongolia's steppe weather can change fast. Pack for all seasons, even in summer, and bring more warm layers than you think you need.\n\nFacilities note:\nOnce you leave the city, countryside toilets are simple outhouses with squat toilets rather than Western flush toilets, and there are no regular showers. Bring wet wipes for cleaning hands and body between river washes; washing in the river can be part of the simple, therapeutic steppe rhythm when conditions allow.\n\nTranslation note:\nEnglish is not always strong in the host-family setting. So far we have found ChatGPT voice mode to be one of the easiest ways to communicate: say something like, “Please translate the following sentence into Mongolian for me,” then speak naturally and play/show the translation. Other translation apps can help too, but ChatGPT voice mode has worked especially well for simple back-and-forth conversation.\n\nNext steps:\n${nextSteps}\n\n${paymentRecovery}\n\nQuestions? Reply to this email and our team will pick it up.\n\nRob & the 8 Lakes Tours team`;

  return {
    subject,
    text,
    html: emailShell({
      preheader: needsGroupInvoice ? `Reference ${input.reference}. Our team will email a ${onlinePayment} invoice for your group.` : input.requiresManualPaymentLink ? `Reference ${input.reference}. Our team will confirm availability before payment.` : `Reference ${input.reference}. Complete the ${onlinePayment} online booking payment to confirm your place.`,
      title: needsGroupInvoice ? `Thanks ${escapeHtml(name)} — group booking received.` : input.requiresManualPaymentLink ? `Thanks ${escapeHtml(name)} — availability request received.` : `Thanks ${escapeHtml(name)} — booking received.`,
      intro: `Your booking has been saved. Your booking reference is <strong>${escapeHtml(input.reference)}</strong> for <strong>${escapeHtml(input.tourDate || 'TBC')}</strong>.`,
      children: `
        <div style="border-left:4px solid #c8a96e;background:#fff3dd;padding:12px 14px;margin-bottom:16px">
          <p style="margin:0 0 10px;text-transform:uppercase;letter-spacing:.12em;font-size:12px;color:#8a6a2c;font-weight:700">Important</p>
          <p style="margin:0;color:#3a3024;font-size:16px;line-height:1.55">${needsGroupInvoice ? `Our team will email one personal invoice for <strong>${onlinePayment}</strong> covering all ${guestCount} guests. Your places are confirmed once that invoice is paid.` : input.requiresManualPaymentLink ? `Our team will confirm availability for ${guestCount} guest${guestCount === 1 ? '' : 's'} before sending the correct payment link or custom order.` : `Your place is confirmed once your <strong>${onlinePayment} online booking payment</strong> has been completed.`}</p>
        </div>

        <div style="border-left:4px solid #eadcc6;padding:12px 14px;background:#fffdf8;margin-bottom:16px">
          ${input.paymentUrl ? `<p><a href="${escapeHtml(input.paymentUrl)}">Resume secure payment for this booking</a> — no new booking needed. Keep this link private.</p>` : ''}
          <p style="margin:0 0 6px;text-transform:uppercase;letter-spacing:.12em;font-size:12px;color:#8a6a2c;font-weight:700">Submitted traveller names</p>
          <p style="margin:0;color:#3a3024;line-height:1.6;font-size:15px">${nl2br(input.travellerNames || input.firstName)}</p>
        </div>

        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 -4px 16px">
          <tr>
            ${pill('Trip price', pricePerPerson, `${guestCount} guest${guestCount === 1 ? '' : 's'} · ${totalTripValue} total.`)}
            ${pill('Pay online', onlinePayment, 'Confirms your place with 8 Lakes Tours.')}
            ${pill('Bring in cash', familyCash, 'Paid directly to the nomadic host family in Mongolia.')}
          </tr>
        </table>

        <h2 style="font-family:Georgia,'Times New Roman',serif;font-weight:400;font-size:24px;margin:0 0 10px;color:#241d14">Why the payment is split</h2>
        <p style="margin:0 0 18px;color:#3a3024;line-height:1.65;font-size:15px">Many nomadic host families cannot reliably receive cards, online payments, or bank transfers. The local family portion is paid directly in cash so that money reaches the hosts cleanly and transparently.</p>

        <div style="border-left:4px solid #eadcc6;padding:12px 14px;background:#fffdf8;margin-bottom:16px">
          <p style="margin:0 0 6px;text-transform:uppercase;letter-spacing:.12em;font-size:12px;color:#8a6a2c;font-weight:700">Food note</p>
          <p style="margin:0;color:#3a3024;line-height:1.6;font-size:15px">Traditional host-family food is meat- and dairy-heavy. For guests who can enjoy it, the dairy is one of the highest-quality parts of the trip: families always produce their own milk from yaks or cows and serve it fresh as milk tea, yoghurt, cheese, and other traditional foods.</p>
        </div>

        <h2 style="font-family:Georgia,'Times New Roman',serif;font-weight:400;font-size:24px;margin:0 0 10px;color:#241d14">Next steps</h2>
        <ol style="margin:0 0 22px;padding-left:20px;color:#3a3024;line-height:1.75;font-size:15px">
          ${needsGroupInvoice ? `<li>Our team will email a personal invoice for <strong>${onlinePayment}</strong>, covering all ${guestCount} guests.</li><li>Pay that invoice to reserve the group&apos;s places — no one has to pay separately.</li>` : input.requiresManualPaymentLink ? '<li>Our team will check the date, horse, guide, host-family capacity, and group details.</li><li>If available, we will send the correct Stripe payment link or custom order for the online reservation amount.</li>' : '<li>Complete the online booking payment on the website if you have not already done so.</li><li>You will receive an automatic payment confirmation email once Stripe checkout completes.</li>'}
          <li>Before arrival, we send practical prep notes: packing guidance, insurance reminders, operator WhatsApp coordination, Bat-Ulzii pickup timing, and cash-payment instructions.</li>
          <li>Please plan to bring <strong>${familyCash} in clean USD notes</strong> for the host family.</li>
        </ol>

        <div style="border-left:4px solid #eadcc6;padding:12px 14px;background:#fffdf8;margin-bottom:16px">
          <p style="margin:0 0 6px;text-transform:uppercase;letter-spacing:.12em;font-size:12px;color:#8a6a2c;font-weight:700">Packing note</p>
          <p style="margin:0;color:#3a3024;line-height:1.6;font-size:15px">Mongolia&apos;s steppe weather can change quickly. Pack for all seasons, even in summer, and bring more warm layers than you think you need: base layers, fleece/down, warm socks, hat, gloves, and waterproof outerwear.</p>
        </div>

        <div style="border-left:4px solid #eadcc6;padding:12px 14px;background:#fffdf8;margin-bottom:16px">
          <p style="margin:0 0 6px;text-transform:uppercase;letter-spacing:.12em;font-size:12px;color:#8a6a2c;font-weight:700">Facilities note</p>
          <p style="margin:0;color:#3a3024;line-height:1.6;font-size:15px">Once you leave the city, countryside toilets are simple outhouses with squat toilets rather than Western flush toilets, and there are no regular showers. Bring wet wipes for cleaning hands and body between river washes; washing in the river can be part of the simple, therapeutic steppe rhythm when conditions allow.</p>
        </div>

        <div style="border-left:4px solid #eadcc6;padding:12px 14px;background:#fffdf8;margin-bottom:16px">
          <p style="margin:0 0 6px;text-transform:uppercase;letter-spacing:.12em;font-size:12px;color:#8a6a2c;font-weight:700">Translation note</p>
          <p style="margin:0;color:#3a3024;line-height:1.6;font-size:15px">English is not always strong in the host-family setting. So far, we&apos;ve found <strong>ChatGPT voice mode</strong> to be one of the easiest ways to communicate: say something like, “Please translate the following sentence into Mongolian for me,” then speak naturally and play or show the translation. Other translation apps can help too, but ChatGPT voice mode has worked especially well for simple back-and-forth conversation.</p>
        </div>

        <div style="border-left:4px solid #eadcc6;padding:12px 14px;background:#fffdf8;margin-bottom:16px">
          <p style="margin:0 0 6px;text-transform:uppercase;letter-spacing:.12em;font-size:12px;color:#8a6a2c;font-weight:700">Booking communication</p>
          <p style="margin:0;color:#3a3024;line-height:1.6;font-size:15px">We’ll send the practical preparation and arrival emails needed for this booking. Those are separate from the general newsletter.</p>
        </div>

        <div style="border-left:4px solid #eadcc6;padding:12px 14px;background:#fffdf8">
          <p style="margin:0 0 6px;text-transform:uppercase;letter-spacing:.12em;font-size:12px;color:#8a6a2c;font-weight:700">Keep this reference</p>
          <p style="margin:0;color:#241d14;font-size:18px;font-weight:700">${escapeHtml(input.reference)}</p>
        </div>
      `,
    }),
  };
}


export function paymentReceivedInternalEmail(input: LifecycleEmailInput & { amountUsd: number; customerName: string; customerEmail: string; stripeReference: string }) {
  const amount = `$${input.amountUsd.toLocaleString('en-US')}`;
  const subject = `Payment received: ${input.customerName} ${input.reference}`;
  const text = `8 Lakes payment received\n\nReference: ${input.reference}\nGuest: ${input.customerName}\nEmail: ${input.customerEmail}\nTour date: ${input.tourDate || 'TBC'}\nOnline payment received: ${amount}\nStripe reference: ${input.stripeReference}\n\nThe booking has been matched by the Stripe webhook and marked paid/confirmed in the ops dashboard.`;

  return {
    subject,
    text,
    html: emailShell({
      preheader: `${amount} Stripe payment matched for ${input.reference}.`,
      title: 'Payment received',
      intro: `<strong>${escapeHtml(input.customerName)}</strong> has paid the online reservation amount for booking <strong>${escapeHtml(input.reference)}</strong>.`,
      footer: false,
      children: `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:18px">
          ${detailRow('Reference', escapeHtml(input.reference))}
          ${detailRow('Guest', escapeHtml(input.customerName))}
          ${detailRow('Email', `<a href="mailto:${escapeHtml(input.customerEmail)}" style="color:#8a5a13">${escapeHtml(input.customerEmail)}</a>`)}
          ${detailRow('Tour date', escapeHtml(input.tourDate || 'TBC'))}
          ${detailRow('Online payment received', escapeHtml(amount))}
          ${detailRow('Stripe reference', escapeHtml(input.stripeReference))}
        </table>
        <p style="margin:0 0 14px;color:#3a3024;line-height:1.65;font-size:15px">The Stripe webhook matched this payment to the booking and marked the online reservation amount as paid in the ops dashboard.</p>
        <p style="margin:0"><a href="${OPS_URL}/ops/bookings/${escapeHtml(input.reference)}" style="display:inline-block;background:#241d14;color:#fff8ea;text-decoration:none;border-radius:0;padding:10px 14px;font-size:12px;text-transform:uppercase;letter-spacing:.12em;font-weight:700">Open booking record</a></p>
      `,
    }),
  };
}

export function paymentConfirmedCustomerEmail(input: LifecycleEmailInput & { amountUsd: number }) {
  const subject = `Payment received — 8 Lakes Tours ${input.reference}`;
  const name = firstName(input.firstName);
  const amount = `$${input.amountUsd.toLocaleString('en-US')}`;

  return {
    subject,
    text: `Hi ${name},\n\nGood news — we’ve received your ${amount} online booking payment for 8 Lakes Tours.\n\nBooking reference: ${input.reference}\nTour date: ${input.tourDate || 'TBC'}\n\nYour place is now confirmed.\n\nThe remaining ${FAMILY_CASH_USD} is paid directly to the host family in Mongolia in clean USD cash. We’ll send preparation notes, packing guidance, insurance reminders, and arrival coordination before departure.\n\nIf you have any questions before then, just reply to this email.\n\n8 Lakes Tours`,
    html: emailShell({
      preheader: `Payment received for booking ${input.reference}. Your 8 Lakes Tours place is confirmed.`,
      title: `Payment received — you’re confirmed.`,
      intro: `Hi ${escapeHtml(name)}, we’ve received your <strong>${escapeHtml(amount)} online booking payment</strong> for 8 Lakes Tours.`,
      children: `
        <div style="border-left:4px solid #c8a96e;background:#fff3dd;padding:12px 14px;margin-bottom:16px">
          <p style="margin:0 0 6px;text-transform:uppercase;letter-spacing:.12em;font-size:12px;color:#8a6a2c;font-weight:700">Booking confirmed</p>
          <p style="margin:0;color:#3a3024;font-size:16px;line-height:1.55">Your place is now confirmed for <strong>${escapeHtml(input.tourDate || 'TBC')}</strong>.</p>
        </div>

        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:18px">
          ${detailRow('Reference', escapeHtml(input.reference))}
          ${detailRow('Online payment received', escapeHtml(amount))}
          ${detailRow('Paid locally in Mongolia', FAMILY_CASH_USD)}
        </table>

        <p style="margin:0 0 18px;color:#3a3024;line-height:1.65;font-size:15px">The remaining <strong>${FAMILY_CASH_USD}</strong> is paid directly to the host family in Mongolia in clean USD cash. We’ll send preparation notes, packing guidance, insurance reminders, and arrival coordination before departure.</p>
        <p style="margin:0;color:#3a3024;line-height:1.65;font-size:15px">If you have any questions before then, just reply to this email.</p>
      `,
    }),
  };
}

export function preparationCustomerEmail(input: LifecycleEmailInput) {
  const subject = `Preparing for Mongolia — 8 Lakes Tours ${input.reference}`;
  const name = firstName(input.firstName);
  return {
    subject,
    text: `Hi ${name},\n\nHere are the main preparation notes for your 8 Lakes Tours booking.\n\nBooking reference: ${input.reference}\nTour date: ${input.tourDate || 'TBC'}\n\nPack for all seasons, even in summer. Mongolia’s steppe weather can shift quickly between warm sun, cold wind, rain, and very cold nights. Bring warm layers, waterproof outerwear, comfortable riding clothes, warm socks, hat, gloves, and basic toiletries.\n\nCountryside facilities are simple. Once outside the city, expect outhouse squat toilets rather than Western flush toilets, and no regular showers. Bring wet wipes for cleaning hands and body between river washes.\n\nFood is traditional host-family food: meat- and dairy-heavy, with fresh milk tea, yoghurt, cheese, and other local foods. Strict vegan or serious dairy-free needs are difficult in this remote setting.\n\nGetting from Ulaanbaatar to Bat-Ulzii needs a little planning. We recommend arriving in Ulaanbaatar at least two days before your tour date so there is enough time to sort the countryside bus and any schedule changes. Book a hostel or hotel in Ulaanbaatar and ask them to help book your bus ticket to Bat-Ulzii. These buses do not run every day, so please do not leave this until the last minute. Once your bus is booked, send us the details and we will help coordinate the host-family pickup on the Bat-Ulzii side.\n\nFor getting around Ulaanbaatar before or after the trip, the tapa. app works well for scooter and bicycle rental and accepts international cards: https://apps.apple.com/app/id1563199559\n\nPlease also make sure you have travel insurance that covers horseback riding/adventure activity and emergency evacuation.\n\nIf you have any last questions, just reply to this email.\n\n8 Lakes Tours`,
    html: emailShell({
      preheader: `Packing, food, facilities, insurance, and practical prep for booking ${input.reference}.`,
      title: `Preparing for Mongolia.`,
      intro: `Hi ${escapeHtml(name)}, here are the main preparation notes for your 8 Lakes Tours booking.`,
      children: `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:18px">
          ${detailRow('Reference', escapeHtml(input.reference))}
          ${detailRow('Tour date', escapeHtml(input.tourDate || 'TBC'))}
          ${detailRow('Local cash payment', FAMILY_CASH_USD)}
        </table>

        <div style="border-left:4px solid #eadcc6;padding:12px 14px;background:#fffdf8;margin-bottom:16px">
          <p style="margin:0 0 6px;text-transform:uppercase;letter-spacing:.12em;font-size:12px;color:#8a6a2c;font-weight:700">Packing</p>
          <p style="margin:0;color:#3a3024;line-height:1.6;font-size:15px">Pack for all seasons, even in summer. Mongolia’s steppe weather can shift quickly between warm sun, cold wind, rain, and very cold nights. Bring warm layers, waterproof outerwear, comfortable riding clothes, warm socks, hat, gloves, and basic toiletries.</p>
        </div>

        <div style="border-left:4px solid #eadcc6;padding:12px 14px;background:#fffdf8;margin-bottom:16px">
          <p style="margin:0 0 6px;text-transform:uppercase;letter-spacing:.12em;font-size:12px;color:#8a6a2c;font-weight:700">Facilities</p>
          <p style="margin:0;color:#3a3024;line-height:1.6;font-size:15px">Once outside the city, expect simple outhouse squat toilets rather than Western flush toilets, and no regular showers. Bring wet wipes for cleaning hands and body between river washes.</p>
        </div>

        <div style="border-left:4px solid #eadcc6;padding:12px 14px;background:#fffdf8;margin-bottom:16px">
          <p style="margin:0 0 6px;text-transform:uppercase;letter-spacing:.12em;font-size:12px;color:#8a6a2c;font-weight:700">Food</p>
          <p style="margin:0;color:#3a3024;line-height:1.6;font-size:15px">Food is traditional host-family food: meat- and dairy-heavy, with fresh milk tea, yoghurt, cheese, and other local foods. Strict vegan or serious dairy-free needs are difficult in this remote setting.</p>
        </div>

        <div style="border-left:4px solid #eadcc6;padding:12px 14px;background:#fffdf8;margin-bottom:16px">
          <p style="margin:0 0 6px;text-transform:uppercase;letter-spacing:.12em;font-size:12px;color:#8a6a2c;font-weight:700">Getting from Ulaanbaatar to Bat-Ulzii</p>
          <p style="margin:0 0 10px;color:#3a3024;line-height:1.6;font-size:15px">This part needs a little planning. We recommend arriving in Ulaanbaatar at least <strong>two days before your tour date</strong> so there is enough time to sort the countryside bus and any schedule changes.</p>
          <p style="margin:0;color:#3a3024;line-height:1.6;font-size:15px">Book a hostel or hotel in Ulaanbaatar and ask them to help book your bus ticket to <strong>Bat-Ulzii</strong>. These buses do not run every day, so please do not leave this until the last minute. Once your bus is booked, send us the details and we will help coordinate the host-family pickup on the Bat-Ulzii side.</p>
        </div>

        <div style="border-left:4px solid #eadcc6;padding:12px 14px;background:#fffdf8;margin-bottom:16px">
          <p style="margin:0 0 6px;text-transform:uppercase;letter-spacing:.12em;font-size:12px;color:#8a6a2c;font-weight:700">Ulaanbaatar transport tip</p>
          <p style="margin:0;color:#3a3024;line-height:1.6;font-size:15px">For getting around Ulaanbaatar before or after the trip, the <a href="https://apps.apple.com/app/id1563199559" style="color:#8a5a13">tapa. app</a> works well for scooter and bicycle rental and accepts international cards.</p>
        </div>

        <p style="margin:0;color:#3a3024;line-height:1.65;font-size:15px">Please also make sure you have travel insurance that covers horseback riding/adventure activity and emergency evacuation. If you have any last questions, just reply to this email.</p>
      `,
    }),
  };
}

export function insuranceReminderCustomerEmail(input: LifecycleEmailInput) {
  const subject = `Travel insurance check — 8 Lakes Tours ${input.reference}`;
  const name = firstName(input.firstName);
  return {
    subject,
    text: `Hi ${name},\n\nQuick check before your 8 Lakes Tours departure: please make sure your travel insurance is active and covers horseback riding or adventure activity, medical treatment, emergency evacuation, and repatriation.\n\nBooking reference: ${input.reference}\nTour date: ${input.tourDate || 'TBC'}\n\nAlso check that your passport, flights, warm layers, personal medication, first-aid basics, and ${FAMILY_CASH_USD} clean USD cash for the host family are sorted.\n\nIf you have any last questions, don’t hesitate to reply.\n\n8 Lakes Tours`,
    html: emailShell({
      preheader: `Insurance, documents, cash, and final preparation check for booking ${input.reference}.`,
      title: `Quick insurance check.`,
      intro: `Hi ${escapeHtml(name)}, a quick check before your 8 Lakes Tours departure.`,
      children: `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:18px">
          ${detailRow('Reference', escapeHtml(input.reference))}
          ${detailRow('Tour date', escapeHtml(input.tourDate || 'TBC'))}
        </table>

        <div style="border-left:4px solid #c8a96e;background:#fff3dd;padding:12px 14px;margin-bottom:16px">
          <p style="margin:0 0 6px;text-transform:uppercase;letter-spacing:.12em;font-size:12px;color:#8a6a2c;font-weight:700">Required insurance</p>
          <p style="margin:0;color:#3a3024;line-height:1.6;font-size:15px">Please make sure your travel insurance is active and covers horseback riding or adventure activity, medical treatment, emergency evacuation, and repatriation.</p>
        </div>

        <p style="margin:0 0 18px;color:#3a3024;line-height:1.65;font-size:15px">Also check that your passport, flights, warm layers, personal medication, first-aid basics, and <strong>${FAMILY_CASH_USD} clean USD cash</strong> for the host family are sorted.</p>
        <p style="margin:0;color:#3a3024;line-height:1.65;font-size:15px">If you have any last questions, don’t hesitate to reply.</p>
      `,
    }),
  };
}

export function arrivalCoordinationCustomerEmail(input: LifecycleEmailInput) {
  const name = firstName(input.firstName);
  return {
    subject: `Arrival coordination — 8 Lakes Tours ${input.reference}`,
    text: `Hi ${name},\n\nYour 8 Lakes Tours departure is getting close. Please reply with your Ulaanbaatar arrival and Bat-Ulzii bus details once booked, so we can coordinate the host-family pickup.\n\nBooking reference: ${input.reference}\nTour date: ${input.tourDate || 'TBC'}\n\nPlease keep your travel insurance, passport, warm layers, and clean USD cash for the host family ready.\n\nRob & the 8 Lakes Tours team`,
    html: emailShell({ preheader: `Arrival coordination for booking ${input.reference}.`, title: 'Arrival coordination.', intro: `Hi ${escapeHtml(name)}, your departure is getting close.`, children: `<p style="margin:0 0 18px;color:#3a3024;line-height:1.65;font-size:15px">Please reply with your Ulaanbaatar arrival and Bat-Ulzii bus details once booked, so we can coordinate the host-family pickup.</p><p style="margin:0;color:#3a3024;line-height:1.65;font-size:15px"><strong>Booking:</strong> ${escapeHtml(input.reference)}<br><strong>Tour date:</strong> ${escapeHtml(input.tourDate || 'TBC')}</p>` }),
  };
}

export function finalChecklistCustomerEmail(input: LifecycleEmailInput) {
  const name = firstName(input.firstName);
  return {
    subject: `Final check before Mongolia — 8 Lakes Tours ${input.reference}`,
    text: `Hi ${name},\n\nA final check before your 8 Lakes Tours departure: passport, insurance covering riding and evacuation, flights/bus, warm layers, medication, and clean USD cash for the host family.\n\nBooking reference: ${input.reference}\nTour date: ${input.tourDate || 'TBC'}\n\nReply if anything has changed.\n\nRob & the 8 Lakes Tours team`,
    html: emailShell({ preheader: `Final departure check for booking ${input.reference}.`, title: 'Final departure check.', intro: `Hi ${escapeHtml(name)}, a quick final check before departure.`, children: `<p style="margin:0;color:#3a3024;line-height:1.65;font-size:15px">Please check your passport, riding/evacuation insurance, flights or bus, warm layers, medication, and clean USD cash for the host family. Reply if anything has changed.</p>` }),
  };
}

export function leadInternalEmail(input: { name: string; email: string; source: string; interest: string }) {
  const name = input.name || 'Subscriber';
  return {
    subject: `New 8 Lakes newsletter subscriber: ${input.email}`,
    text: `New newsletter subscriber\n\nName: ${name}\nEmail: ${input.email}\nInterest: ${input.interest}\nSource: ${input.source}`,
    html: emailShell({
      preheader: `${input.email} joined the 8 Lakes newsletter list.`,
      title: 'New newsletter subscriber',
      footer: false,
      children: `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
          ${detailRow('Name', escapeHtml(name))}
          ${detailRow('Email', `<a href="mailto:${escapeHtml(input.email)}" style="color:#8a5a13">${escapeHtml(input.email)}</a>`)}
          ${detailRow('Interest', escapeHtml(input.interest || 'Not provided'))}
          ${detailRow('Source', escapeHtml(input.source || 'website'))}
        </table>
      `,
    }),
  };
}

export function leadCustomerEmail(input: { name: string }) {
  const greetingName = input.name ? firstName(input.name) : '';
  const greeting = greetingName ? `Hi ${escapeHtml(greetingName)},` : 'Hi,';
  return {
    subject: 'Welcome to the 8 Lakes Tours newsletter',
    text: `${greetingName ? `Hi ${greetingName},` : 'Hi,'}\n\nThanks for joining the 8 Lakes Tours newsletter. We’ll send occasional updates about Mongolia horse trekking, new departure dates, offers, deals, blog posts, field notes, and behind-the-scenes news from the business.\n\nNo booking has been made from this signup. If you ever want to reserve a place, you can do that on the website: ${SITE_URL}/#application\n\nYou can opt out any time by replying to this email.\n\n8 Lakes Tours`,
    html: emailShell({
      preheader: 'Occasional 8 Lakes Tours news, offers, dates, blog posts, and field notes.',
      title: greeting,
      intro: 'Thanks for joining the 8 Lakes Tours newsletter.',
      children: `
        <p style="margin:0 0 18px;color:#3a3024;line-height:1.65;font-size:15px">We’ll send occasional updates about Mongolia horse trekking, new departure dates, offers, deals, blog posts, field notes, and behind-the-scenes news from the business.</p>
        <p style="margin:0 0 18px;color:#3a3024;line-height:1.65;font-size:15px">No booking has been made from this signup. If you ever want to reserve a place, you can do that on the website.</p>
        <p style="margin:0 0 18px;color:#3a3024;line-height:1.65;font-size:15px">You can opt out any time by replying to this email.</p>
        <p style="margin:0"><a href="${SITE_URL}" style="display:inline-block;background:#241d14;color:#fff8ea;text-decoration:none;border-radius:0;padding:12px 16px;font-size:12px;text-transform:uppercase;letter-spacing:.12em;font-weight:700">Visit 8 Lakes Tours</a></p>
      `,
    }),
  };
}
