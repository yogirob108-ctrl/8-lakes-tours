import type { Metadata } from 'next';
import Link from 'next/link';
import SiteNav from '../components/SiteNav';

export const metadata: Metadata = {
  title: 'About 8 Lakes Tours',
  description: 'About 8 Lakes Tours, Robert Zaher, and the nomadic host-family horse trekking experience in Mongolia.',
  alternates: { canonical: 'https://www.8lakestours.com/about' },
  openGraph: {
    title: 'About 8 Lakes Tours',
    description: 'Meet the people and host-family relationship behind this Mongolian horse trekking expedition.',
    url: 'https://www.8lakestours.com/about',
    images: [{ url: '/images/og-8-lakes-about-2026.jpg', width: 1200, height: 630, alt: 'Robert Zaher with the Mongolian host family behind 8 Lakes Tours' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'About 8 Lakes Tours',
    description: 'Meet the people and host-family relationship behind this Mongolian horse trekking expedition.',
    images: ['/images/og-8-lakes-about-2026.jpg'],
  },
  robots: { index: true, follow: true },
};

const storyCards = [
  {
    title: 'Built from a real relationship',
    body: 'Rob met Ganbold and the Sandagdorj family while travelling through Mongolia, then returned to shape this trip with them directly. This is not a generic route bought from a distant operator — it is a small hosted journey built around people Rob knows.',
  },
  {
    title: 'Hosted by nomadic families',
    body: 'Guests stay close to local life: gers, horses, shared meals, weather, tea, work, rest, and the rhythm of the valley. The local family portion of the price is paid directly in cash to the hosts because many families cannot reliably receive online transfers.',
  },
  {
    title: 'Built around the real thing',
    body: '8 Lakes Tours is not a polished resort product. It is built around real environments over artificial comfort, movement over passive consumption, and a host-family experience that asks guests to arrive open, flexible, and ready for the land as it is.',
  },
];

const expectationCards = [
  {
    title: 'Real adventure, optional challenge',
    body: 'Weather can shift, horses and roads can change plans, and group dynamics matter in wild country. You should arrive mentally prepared for simple conditions, physical discomfort, and flexibility. You may be invited outside your comfort zone, but nothing is forced. You can say no, rest, or stay closer to nomadic life for the day.',
  },
  {
    title: 'Remote, but not abandoned',
    body: 'The steppe feels vast and far from city life, but it is not empty. A simple story explains the culture well: when travellers lost their way between distant gers, they could stop at another family home for tea, food, shelter, directions, or supplies. Hospitality was not decoration — it was how people crossed uncertain land together.',
  },
  {
    title: 'Food is part of the culture',
    body: 'Traditional Mongolian meals are usually meat- and dairy-heavy: milk tea, yoghurt, cheese, meat, and animal products are normal. Vegetarian guests may be possible with advance notice, but strict vegan diets or serious dairy/lactose issues may make this the wrong tour.',
  },
];

export default function Page() {
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'AboutPage',
        '@id': 'https://www.8lakestours.com/about#about-page',
        url: 'https://www.8lakestours.com/about',
        name: 'About 8 Lakes Tours',
        description: 'About 8 Lakes Tours, Robert Zaher, and the nomadic host-family horse trekking experience in Mongolia.',
        inLanguage: 'en',
        isPartOf: { '@id': 'https://www.8lakestours.com/#website' },
        about: { '@id': 'https://www.8lakestours.com/#organization' },
      },
      {
        '@type': ['Organization', 'TravelAgency'],
        '@id': 'https://www.8lakestours.com/#organization',
        name: '8 Lakes Tours',
        url: 'https://www.8lakestours.com',
        email: 'info@8lakestours.com',
        founder: { '@type': 'Person', name: 'Robert Zaher', sameAs: 'https://www.instagram.com/robzaher108' },
        sameAs: ['https://www.instagram.com/8lakestours', 'https://www.instagram.com/robzaher108'],
        areaServed: { '@type': 'Country', name: 'Mongolia' },
      },
    ],
  };

  return (
    <main className="about-page">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <SiteNav />

      <section className="about-hero">
        <div className="about-hero-image" role="img" aria-label="Host family and guests watching a white horse in the Mongolian valley">
          <div className="about-hero-overlay" />
        </div>
        <div className="about-hero-copy">
          <p className="eyebrow">About 8 Lakes Tours</p>
          <h1>A Mongolia trip built on relationship, not tourism theatre.</h1>
          <p>8 Lakes Tours is a small-group horse trekking journey through the Orkhon Valley and Naiman Nuur / Eight Lakes region, hosted with nomadic families and guided by people who know the land from the inside.</p>
          <div className="hero-actions">
            <Link href="/#book">Reserve online</Link>
            <Link href="/gallery" className="ghost">See the gallery</Link>
          </div>
        </div>
      </section>

      <section className="intro-grid">
        <div>
          <p className="eyebrow">The idea</p>
          <h2>Real people. Real horses. Real weather.</h2>
        </div>
        <div className="intro-copy">
          <p>The trip exists because Rob travelled through Mongolia, met Ganbold&apos;s family, rode with them, stayed with them, and saw that this valley could host something deeper than a standard sightseeing product.</p>
          <p>Guests do not come here to consume a polished show. They come to live closer to the family rhythm for a short time: ride, eat, adapt, rest, laugh, get cold, drink tea, look at the sky, and remember what simplicity feels like.</p>
          <p>That includes embracing variance. In steppe life, the plan is shaped by weather, distance, animals, and the people you meet along the way. The old hospitality logic of the ger — offer tea, food, shelter, and help to the traveller who appears at your door — is part of why uncertainty here can feel human rather than hostile.</p>
        </div>
      </section>

      <section className="story-section">
        <div className="story-image portrait" role="img" aria-label="Robert Zaher, organiser of 8 Lakes Tours" />
        <div className="story-copy">
          <p className="eyebrow">Who you&apos;re booking with</p>
          <h2>Rob Zaher</h2>
          <p>Rob leads the 8 Lakes Tours experience and customer communication. He is the bridge between international guests and the Mongolian host family relationship behind the trip.</p>
          <p>His role is not to over-polish the experience into something fake. It is to make the booking, preparation, expectations, safety, and communication clear enough that guests can arrive ready for the real thing.</p>
          <div className="link-row">
            <a href="https://www.instagram.com/robzaher108" target="_blank" rel="noopener noreferrer">Rob&apos;s Instagram</a>
            <Link href="/contact">Ask a question</Link>
          </div>
        </div>
      </section>

      <section className="cards-section">
        <p className="eyebrow">How it works</p>
        <h2>The structure behind the journey</h2>
        <div className="card-grid">
          {storyCards.map((card) => (
            <article key={card.title} className="info-card">
              <h3>{card.title}</h3>
              <p>{card.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="photo-band" aria-label="Mongolia trip photos">
        <div className="band-image wide ger" role="img" aria-label="Ger at blue hour beneath the Mongolian mountains" />
        <div className="band-image guide" role="img" aria-label="Suma standing with his horse on the open steppe" />
        <div className="band-image riders" role="img" aria-label="Riders looking over the valley in changing weather" />
      </section>

      <section className="cards-section expectations">
        <p className="eyebrow">Fit before fantasy</p>
        <h2>Who this trip is — and is not — for.</h2>
        <div className="card-grid">
          {expectationCards.map((card) => (
            <article key={card.title} className="info-card strong">
              <h3>{card.title}</h3>
              <p>{card.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="payment-strip">
        <div>
          <p className="eyebrow">Transparent payment</p>
          <h2>$1,999 per person. Half online, half cash to your hosts.</h2>
          <p className="payment-strip-note">Group rates apply for 3–8 guests.</p>
          <p>Many nomadic families live outside reliable online banking. The online half confirms your place with 8 Lakes Tours, and the other half is paid directly to your host family in clean USD cash in Mongolia.</p>
        </div>
        <Link href="/faq">Read payment FAQ</Link>
      </section>

      <section className="next-links">
        <p className="eyebrow">Next</p>
        <h2>Keep exploring</h2>
        <div className="next-grid">
          <Link href="/#book"><strong>Reserve a spot</strong><span>Dates, price, booking form, and payment structure.</span></Link>
          <Link href="/gallery"><strong>Gallery</strong><span>See the horses, gers, weather, guides, and valley.</span></Link>
          <Link href="/faq"><strong>FAQ</strong><span>Food, flexibility, safety, insurance, payment, and logistics.</span></Link>
          <Link href="/contact"><strong>Contact</strong><span>Ask Rob and the team before you book.</span></Link>
        </div>
      </section>

      <footer className="about-footer">
        <span>© 2026 8 Lakes Tours · All rights reserved</span>
        <div>
          <Link href="/terms">Terms</Link>
          <Link href="/privacy">Privacy</Link>
          <Link href="/llms.txt">LLMs.txt</Link>
        </div>
      </footer>

      <style>{`
        .about-page { --radius-soft:10px; --radius-card:12px; --radius-photo:4px; background:#0e0c09; min-height:100vh; color:#d4cfc4; font-family:var(--font-jost),'Jost',sans-serif; font-weight:300; overflow-x:hidden; }
        .eyebrow { margin:0 0 .85rem; color:#c8a96e; text-transform:uppercase; letter-spacing:.26em; font-size:.66rem; font-weight:600; }
        h1,h2,h3,p { margin-top:0; }
        h1,h2,h3 { color:#f5f0e8; font-family:var(--font-cormorant),'Cormorant Garamond',serif; font-weight:300; line-height:1; }
        h1 { font-size:clamp(3.1rem,8vw,7rem); max-width:980px; margin-bottom:1.4rem; }
        h2 { font-size:clamp(2.2rem,5vw,4.4rem); margin-bottom:1rem; }
        h3 { font-size:1.45rem; margin-bottom:.65rem; }
        p { color:rgba(212,207,196,.84); line-height:1.75; }
        a { color:inherit; }
        .about-hero { min-height:92vh; position:relative; display:flex; align-items:flex-end; padding:8rem 6rem 5rem; box-sizing:border-box; }
        .about-hero-image { position:absolute; inset:0; overflow:hidden; background-image:url('/images/gallery-extra/host-family-horse-training-valley.jpg'); background-size:cover; background-position:center 48%; }
        .about-hero-overlay { position:absolute; inset:0; background:linear-gradient(to top, rgba(14,12,9,.96) 0%, rgba(14,12,9,.72) 42%, rgba(14,12,9,.18) 100%); }
        .about-hero-copy { position:relative; z-index:1; max-width:1040px; }
        .about-hero-copy > p:last-of-type { max-width:680px; font-size:1.08rem; }
        .hero-actions,.link-row { display:flex; flex-wrap:wrap; gap:.8rem; margin-top:1.8rem; }
        .hero-actions a,.link-row a,.payment-strip a { display:inline-flex; align-items:center; justify-content:center; border:1px solid #c8a96e; border-radius:var(--radius-soft); background:#c8a96e; color:#0e0c09; text-decoration:none; text-transform:uppercase; letter-spacing:.16em; font-size:.7rem; font-weight:600; padding:.92rem 1.25rem; }
        .hero-actions a.ghost,.link-row a { background:rgba(14,12,9,.28); color:#c8a96e; }
        .intro-grid,.story-section,.cards-section,.payment-strip,.next-links { padding:6rem; }
        .intro-grid { display:grid; grid-template-columns:.9fr 1.1fr; gap:4rem; border-bottom:1px solid rgba(200,169,110,.14); }
        .intro-copy { display:grid; gap:1rem; font-size:1.02rem; }
        .story-section { display:grid; grid-template-columns:minmax(260px,.7fr) 1fr; gap:4rem; align-items:center; background:#18130e; }
        .story-image { position:relative; min-height:560px; background:#080806 url('/images/rob-zaher.jpg') center / cover no-repeat; overflow:hidden; border:1px solid rgba(200,169,110,.18); border-radius:var(--radius-photo); }
        .story-copy { max-width:720px; }
        .story-copy p { font-size:1rem; }
        .card-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:1rem; margin-top:2rem; }
        .info-card { border:1px solid rgba(200,169,110,.16); border-left:3px solid rgba(200,169,110,.52); border-radius:var(--radius-card); background:rgba(245,240,232,.035); padding:1.25rem; min-height:230px; }
        .info-card.strong { background:rgba(200,169,110,.065); }
        .info-card p { font-size:.93rem; line-height:1.7; }
        .photo-band { display:grid; grid-template-columns:2fr 1fr 1fr; gap:4px; background:#080806; padding:4px; }
        .band-image { position:relative; min-height:420px; background:#18130e center / cover no-repeat; overflow:hidden; border-radius:var(--radius-photo); }
        .band-image.ger { background-image:url('/images/expedition-originals/ger-blue-hour-original.jpg'); }
        .band-image.guide { background-image:url('/images/guide-horse-portrait.jpg'); background-position:center 36%; }
        .band-image.riders { background-image:url('/images/gallery-extra/rainy-horseback-overlook.jpg'); }
        .expectations { background:#120f0b; }
        .payment-strip { display:grid; grid-template-columns:1fr auto; gap:2rem; align-items:center; border-top:1px solid rgba(200,169,110,.14); border-bottom:1px solid rgba(200,169,110,.14); }
        .payment-strip p { max-width:820px; }
        .payment-strip .payment-strip-note { margin:-.35rem 0 1rem; color:#c8a96e; font-style:italic; font-size:.95rem; letter-spacing:.02em; }
        .next-links { text-align:center; }
        .next-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:.85rem; margin-top:2rem; text-align:left; }
        .next-grid a { border:1px solid rgba(200,169,110,.18); border-radius:var(--radius-card); background:rgba(245,240,232,.035); text-decoration:none; padding:1.1rem; min-height:130px; }
        .next-grid strong { display:block; color:#f5f0e8; margin-bottom:.45rem; }
        .next-grid span { display:block; color:rgba(212,207,196,.68); line-height:1.45; font-size:.86rem; }
        .about-footer { border-top:1px solid rgba(200,169,110,.15); padding:2rem 4rem; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:1rem; }
        .about-footer span { font-size:.75rem; color:rgba(212,207,196,.42); }
        .about-footer div { display:flex; gap:1.5rem; flex-wrap:wrap; }
        .about-footer a { font-size:.7rem; letter-spacing:.2em; text-transform:uppercase; color:#c8a96e; text-decoration:none; opacity:.78; }
        @media (max-width: 900px) {
          .about-hero { min-height:86svh; padding:7rem 1.35rem 3.5rem; }
          .about-hero-copy > p:last-of-type { font-size:.98rem; }
          .hero-actions a,.link-row a,.payment-strip a { width:100%; box-sizing:border-box; }
          .intro-grid,.story-section,.cards-section,.payment-strip,.next-links { padding:4rem 1.25rem; }
          .intro-grid,.story-section,.payment-strip { grid-template-columns:1fr; gap:2rem; }
          .story-image { min-height:420px; }
          .card-grid,.next-grid { grid-template-columns:1fr; }
          .info-card { min-height:0; }
          .photo-band { grid-template-columns:1fr 1fr; }
          .band-image { min-height:250px; }
          .band-image.wide { grid-column:1 / -1; min-height:280px; }
          .about-footer { padding:2rem 1.25rem; }
        }
      `}</style>
    </main>
  );
}
