import type { Metadata } from 'next';
import Link from 'next/link';
import SiteNav from '../components/SiteNav';

export const metadata: Metadata = {
  title: 'Terms & Conditions',
  description: 'Terms and Conditions for booking a tour with 8 Lakes Tours.',
  alternates: { canonical: 'https://www.8lakestours.com/terms' },
  robots: { index: true, follow: true },
};

export default function TermsAndConditions() {
  return (
    <main style={{ background: '#0e0c09', minHeight: '100vh', color: '#d4cfc4', fontFamily: "var(--font-jost), 'Jost', sans-serif", fontWeight: 300 }}>

      <SiteNav />

      <div style={{ maxWidth: '720px', margin: '0 auto', padding: '5rem 2rem' }}>
        <p style={{ fontSize: '0.65rem', letterSpacing: '0.3em', textTransform: 'uppercase', color: '#c8a96e', marginBottom: '1rem' }}>Legal</p>
        <h1 style={{ fontFamily: "var(--font-cormorant), 'Cormorant Garamond', serif", fontSize: '2.8rem', fontWeight: 300, color: '#f5f0e8', marginBottom: '0.5rem', lineHeight: 1.1 }}>Terms &amp; Conditions</h1>
        <p style={{ fontSize: '0.8rem', color: '#d4cfc4', opacity: 0.5, marginBottom: '3rem' }}>Last updated: August 2026</p>

        {[
          {
            title: '1. Agreement',
            body: 'By submitting a booking enquiry or making a payment through 8 Lakes Tours, you agree to these Terms & Conditions in full. These terms constitute the entire agreement between you and 8 Lakes Tours (operated by Robert Zaher, contact: info@8lakestours.com).',
          },
          {
            title: '2. Booking & Payment Structure',
            body: 'All official prices are in USD. For bookings of 1–2 guests on a fixed departure, a $999 USD online booking payment per guest is required to confirm your place with 8 Lakes Tours. Scheduled groups of 1–8 submit one booking and pay the exact group online amount together in a single Stripe checkout. The per-guest online payment for group bookings is $974 USD for 3–4 guests, $949 for 5–6, and $899 for 7–8, reflecting the group discount. Your spot is not guaranteed until the required online payment has been received and confirmed by us. The remaining local family payment is paid directly in clean USD cash to the nomadic host families in Mongolia and is not collected online by 8 Lakes Tours.',
          },
          {
            title: '3. Tour Price',
            body: 'The 2026 tour price depends on group size: $1,999 USD per person for 1–2 guests, $1,949 for 3–4, $1,899 for 5–6, and $1,799 for 7–8 guests booking together for the same departure. Each price is made up of an online booking payment through 8 Lakes Tours and a local family cash payment made directly to the nomadic host families in Mongolia. The group discount is shared evenly between the two, so the online booking payment is $999 USD per guest for 1–2 guests, $974 for 3–4, $949 for 5–6, and $899 for 7–8, and the local family cash payment is $1,000 USD per guest for 1–2 guests, $975 for 3–4, $950 for 5–6, and $900 for 7–8. The tour price includes all accommodation, meals, horses and guiding as described on our website. Flights, travel insurance, visas, and personal expenses are not included.',
          },
          {
            title: '4. Cancellation Policy',
            body: 'If you cancel more than 3 weeks / 21 days before departure, the online booking payment you made to 8 Lakes Tours is refundable minus unrecoverable Stripe/payment processing fees. If you cancel within 3 weeks / 21 days of departure, you are entitled to a refund of 50% of the online booking payment you made to 8 Lakes Tours, minus unrecoverable Stripe/payment processing fees. In addition, we will still try to help with a transfer to another available date or an approved replacement traveller where host, horse, transport, guide, or group logistics costs allow, which may recover more than the 50%. If 8 Lakes Tours cancels your departure, the online amount paid to us will be refunded minus unrecoverable Stripe/payment processing fees. The local family payment is paid in cash in Mongolia and is not collected online by 8 Lakes Tours before departure. We strongly recommend comprehensive travel insurance that includes trip cancellation coverage.',
          },
          {
            title: '5. Travel Insurance',
            body: 'Comprehensive travel insurance is mandatory for all participants. Your policy must include emergency medical treatment, emergency evacuation and repatriation, and coverage for horseback riding and adventure activities. Proof of insurance may be requested before departure. 8 Lakes Tours reserves the right to deny participation to anyone without adequate coverage.',
          },
          {
            title: '6. Liability Waiver',
            body: 'All participants must sign the 8 Lakes Tours Liability Waiver & Release before departure (or as part of the booking process). By signing, you acknowledge the inherent risks of the activity and release 8 Lakes Tours, its guides, and the host family from liability for injury, illness, or death arising from participation. The waiver is legally binding.',
          },
          {
            title: '7. Health & Fitness',
            body: 'Participation requires a reasonable level of physical fitness. You must disclose any pre-existing medical conditions at the time of booking. 8 Lakes Tours reserves the right to decline or remove any participant who, in the reasonable judgement of the guide, poses a safety risk to themselves or others.',
          },
          {
            title: '8. Itinerary Changes',
            body: 'The itinerary described on our website is indicative. Weather, terrain conditions, and the safety of participants may require changes to the route, schedule, or activities at short notice. These decisions rest with the lead guide and are final. No refund is given for itinerary modifications made for safety reasons.',
          },
          {
            title: '9. Group Size & Availability',
            body: 'Tours are limited to a maximum of 8 participants. 8 Lakes Tours reserves the right to cancel a tour date if minimum participant numbers are not reached, or for reasons beyond our control. In such cases, the online amount paid to us will be refunded minus unrecoverable Stripe/payment processing fees. The local family cash payment is not collected online before departure.',
          },
          {
            title: '10. Force Majeure',
            body: 'We are not liable for cancellations or changes caused by circumstances beyond our reasonable control, including but not limited to natural disasters, government restrictions, war, pandemics, or extreme weather events. In such cases, we will endeavour to offer an alternative date or a credit.',
          },
          {
            title: '11. Governing Law',
            body: 'These Terms & Conditions are governed by the laws of Mongolia for activities conducted on Mongolian territory, and by the laws of the jurisdiction of the operator for pre-departure matters. Any disputes shall be resolved in good faith between the parties.',
          },
          {
            title: '12. Contact',
            body: 'For any questions regarding these terms, contact us at info@8lakestours.com.',
          },
        ].map(({ title, body }) => (
          <section key={title} style={{ marginBottom: '2.5rem' }}>
            <h2 style={{ fontFamily: "var(--font-cormorant), 'Cormorant Garamond', serif", fontSize: '1.2rem', fontWeight: 400, color: '#f5f0e8', marginBottom: '0.6rem' }}>{title}</h2>
            <p style={{ fontSize: '0.9rem', lineHeight: 1.85, color: '#d4cfc4', opacity: 0.85 }}>{body}</p>
          </section>
        ))}
      </div>

      <footer style={{ borderTop: '1px solid rgba(200,169,110,0.15)', padding: '2rem 4rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
        <span style={{ fontSize: '0.75rem', color: '#d4cfc4', opacity: 0.4 }}>© 2026 8 Lakes Tours · All rights reserved</span>
        <div style={{ display: 'flex', gap: '1.5rem' }}>
          <Link href="/terms" style={{ fontSize: '0.7rem', letterSpacing: '0.15em', textTransform: 'uppercase', color: '#c8a96e', opacity: 0.7, textDecoration: 'none' }}>Terms & Conditions</Link>
          <Link href="/privacy" style={{ fontSize: '0.7rem', letterSpacing: '0.15em', textTransform: 'uppercase', color: '#c8a96e', opacity: 0.7, textDecoration: 'none' }}>Privacy Policy</Link>
        </div>
      </footer>
    </main>
  );
}
