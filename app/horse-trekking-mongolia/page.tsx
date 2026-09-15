import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import SiteNav from '../components/SiteNav';
import LandingCta from './LandingCta';
import styles from './page.module.css';

const canonical = 'https://www.8lakestours.com/horse-trekking-mongolia';

export const metadata: Metadata = {
  title: 'Mongolia Horse Trekking | 9-Day Eight Lakes Expedition',
  description: 'Ride Mongolia’s Orkhon Valley and Naiman Nuur on a 9-day small-group horse trek with local horsemen and a nomadic host family. Beginners welcome. 2027 interest and private departures open by request.',
  alternates: { canonical },
  // Paid-search landing page: live for Google Ads, kept out of the organic index so it
  // does not compete with the homepage for "Mongolian horse trekking".
  robots: { index: false, follow: true },
  openGraph: {
    title: '9-Day Mongolia Horse Trekking Expedition | 8 Lakes Tours',
    description: 'A small-group horse trek through the Orkhon Valley and Eight Lakes, hosted with a Mongolian nomadic family.',
    url: canonical,
    type: 'website',
    images: [{ url: '/images/og-8-lakes-horseback-2026.jpg', width: 1200, height: 630, alt: 'Horseback expedition through Mongolia’s Eight Lakes region' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: '9-Day Mongolia Horse Trekking Expedition',
    description: 'Ride the Orkhon Valley and Eight Lakes with local horsemen and a nomadic host family.',
    images: ['/images/og-8-lakes-horseback-2026.jpg'],
  },
};

const facts = [
  ['9 days', '8 nights'],
  ['Maximum 8', 'small group'],
  ['$1,799–$1,999', 'per person'],
  ['Beginner friendly', 'local guidance'],
];

const route = [
  {
    days: 'Days 1–3',
    title: 'Settle into nomadic life',
    body: 'Meet the host family near Bat-Ulzii, sleep in traditional gers, learn the horses and find your rhythm before the remote trek begins.',
  },
  {
    days: 'Days 4–7',
    title: 'Cross the Eight Lakes',
    body: 'Ride with local horsemen through the Orkhon Valley and Naiman Nuur, camp remotely and adapt each day to the horses and the group.',
  },
  {
    days: 'Days 8–9',
    title: 'Return to the family',
    body: 'Ride back to the ger village, share farewell meals and prepare for the transfer to Bat-Ulzii and onward travel.',
  },
];

export default function HorseTrekkingMongoliaPage() {
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'TouristTrip',
    '@id': `${canonical}#trip`,
    name: '8 Lakes Tours — 9-Day Mongolia Horse Trekking Expedition',
    description: 'A 9-day small-group horse trek through Mongolia’s Orkhon Valley and Naiman Nuur / Eight Lakes region, hosted with a nomadic family and guided by local horsemen.',
    url: canonical,
    touristType: 'Adventure travellers, beginner and intermediate riders',
    provider: {
      '@type': 'Organization',
      name: '8 Lakes Tours',
      url: 'https://www.8lakestours.com',
      email: 'info@8lakestours.com',
    },
    location: {
      '@type': 'Place',
      name: 'Orkhon Valley and Naiman Nuur, Mongolia',
    },
    offers: {
      '@type': 'AggregateOffer',
      priceCurrency: 'USD',
      lowPrice: '1799',
      highPrice: '1999',
      offerCount: '4',
      url: 'https://www.8lakestours.com/#application',
    },
  };

  return (
    <main className={styles.page}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <SiteNav />

      <section className={styles.hero}>
        <Image
          src="/images/gallery-extra/horseback-storm-valley-pov.jpg"
          alt="Horseback view across a remote Mongolian mountain valley"
          fill
          priority
          quality={82}
          sizes="100vw"
          className={styles.heroImage}
        />
        <div className={styles.heroShade} />
        <div className={styles.heroContent}>
          <p className={styles.eyebrow}>9 Days · Orkhon Valley · Naiman Nuur</p>
          <h1>Mongolia horse trekking,<br /><em>beyond the usual tour.</em></h1>
          <p className={styles.lede}>Ride into the Eight Lakes with local horsemen, live with a nomadic host family and travel in a group small enough to remain part of the landscape.</p>
          <div className={styles.heroActions}>
            <LandingCta href="/#application" label="Request 2027 dates" placement="hero" />
            <a href="#route" className={styles.textLink}>See the route</a>
          </div>
          <p className={styles.heroNote}>2027 small-group dates are being planned. Private 2027 departures are available by request and confirmed personally before payment.</p>
        </div>
      </section>

      <section className={styles.factBar} aria-label="Trip summary">
        {facts.map(([value, label]) => (
          <div key={value}><strong>{value}</strong><span>{label}</span></div>
        ))}
      </section>

      <section className={styles.intro}>
        <div>
          <p className={styles.eyebrow}>The real thing</p>
          <h2>Not a riding resort.<br /><em>A family expedition.</em></h2>
        </div>
        <div className={styles.copyStack}>
          <p>8 Lakes Tours exists through Robert Zaher’s direct relationship with Ganbold’s family in the Orkhon Valley. You stay with the family, share meals and ride with Suma and experienced local horsemen.</p>
          <p>The journey is remote and flexible. Weather, horses, roads and group rhythm shape the day. Remote does not mean abandoned: your guides and hosts remain the centre of the experience.</p>
        </div>
      </section>

      <section id="route" className={styles.routeSection}>
        <div className={styles.sectionHead}>
          <p className={styles.eyebrow}>The route</p>
          <h2>Nine days from ger village<br /><em>to the Eight Lakes.</em></h2>
        </div>
        <div className={styles.routeGrid}>
          {route.map(item => (
            <article key={item.days}>
              <span>{item.days}</span>
              <h3>{item.title}</h3>
              <p>{item.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className={styles.familySection}>
        <div className={styles.familyImage}>
          <Image src="/images/rob-family.jpg" alt="Robert Zaher with the nomadic host family outside a ger" fill quality={82} sizes="(max-width: 860px) 100vw, 50vw" />
        </div>
        <div className={styles.familyCopy}>
          <p className={styles.eyebrow}>Who you travel with</p>
          <h2>Robert, Suma and the<br /><em>nomadic host family.</em></h2>
          <p>Robert handles online preparation and booking communication. Ganbold’s family hosts the journey, and Suma guides riders through the terrain he grew up in.</p>
          <p>Every booking includes a local family portion paid directly to your hosts in Mongolia. The split is explicit before you commit.</p>
          <div className={styles.trustLinks}>
            <Link href="/about">Meet the team</Link>
            <a href="mailto:info@8lakestours.com">Email Robert</a>
          </div>
        </div>
      </section>

      <section className={styles.priceSection}>
        <div className={styles.priceLead}>
          <p className={styles.eyebrow}>Transparent pricing</p>
          <h2>$1,799–$1,999<br /><em>per person.</em></h2>
          <p>Price depends on the number of guests booking together, and the group discount is shared evenly between 8 Lakes Tours and your host family. Fixed 2026 departures can be booked and paid online; no automatic payment is taken for 2027 interest or private-date requests.</p>
        </div>
        <div className={styles.paymentCard}>
          <div><span>Online booking payment</span><strong>$899–$999 pp</strong><p>Paid online for fixed 2026 dates; confirmed first for request-only dates.</p></div>
          <div className={styles.plus}>+</div>
          <div><span>Direct to host family</span><strong>$900–$1,000 pp</strong><p>Clean USD cash paid locally in Mongolia.</p></div>
          <p className={styles.total}>Total: $1,799–$1,999 per person · flights and insurance not included</p>
        </div>
      </section>

      <section className={styles.fitSection}>
        <div className={styles.sectionHead}>
          <p className={styles.eyebrow}>Before you request</p>
          <h2>Beginner friendly.<br /><em>Still a real expedition.</em></h2>
        </div>
        <div className={styles.fitGrid}>
          <div><strong>Riding level</strong><p>Beginners and intermediate riders are welcome. Local horsemen help you learn before the remote trek.</p></div>
          <div><strong>Conditions</strong><p>Expect simple gers, remote camping, changing weather, limited showers and long hours outside.</p></div>
          <div><strong>Insurance</strong><p>Comprehensive travel insurance covering horseback riding and emergency evacuation is mandatory.</p></div>
          <div><strong>Group size</strong><p>Maximum 8 guests. Private groups and custom dates depend on hosts, horses, guides and logistics.</p></div>
        </div>
      </section>

      <section className={styles.ctaSection}>
        <Image src="/images/expedition-originals/orkhon-valley-sunset-wide.jpg" alt="Sunset over the Orkhon Valley river bends" fill quality={82} sizes="100vw" />
        <div className={styles.ctaShade} />
        <div>
          <p className={styles.eyebrow}>2027 Mongolia</p>
          <h2>Fixed dates are being planned.<br /><em>Private departures are open by request.</em></h2>
          <p>Tell us your preferred window and group size. Robert will check the host family, horses, guide and route before any payment step.</p>
          <LandingCta href="/#application" label="Request 2027 availability" placement="closing" />
        </div>
      </section>

      <footer className={styles.footer}>
        <div><strong>8 Lakes Tours</strong><span>Horse trekking through Mongolia’s Orkhon Valley and Eight Lakes.</span></div>
        <nav aria-label="Landing page footer">
          <Link href="/">Mongolian horse trekking</Link>
          <Link href="/about">About</Link>
          <Link href="/preparation">Preparation</Link>
          <Link href="/terms">Terms</Link>
          <Link href="/privacy">Privacy</Link>
        </nav>
      </footer>
    </main>
  );
}
