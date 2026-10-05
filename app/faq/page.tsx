import type { Metadata } from 'next';
import Link from 'next/link';
import SiteNav from '../components/SiteNav';
import HeroVideo from '../components/HeroVideo';
import FaqAccordion from './FaqAccordion';
import { BASE_LOCAL_FAMILY_PAYMENT_USD, BASE_ONLINE_PAYMENT_USD, BASE_PRICE_USD, GROUP_PRICING_TIERS } from '@/lib/group-pricing.mjs';
import { PRICE_AFTER_HOLD_USD, PRICE_HOLD_DEADLINE_LABEL, PRICE_INCREASE_DATE_LABEL, isPriceHoldActive } from '@/lib/price-hold.mjs';

// The cost guide switches its founding-rate wording off after New Year.
export const revalidate = 3600;

export const metadata: Metadata = {
  title: 'FAQ',
  description: 'Frequently asked questions about 8 Lakes Tours and Mongolian horse trekking, plus planning guides: the best time to ride in Mongolia, what a horse trek costs, whether you need riding experience, and the Orkhon Valley vs Khövsgöl vs the Gobi.',
  alternates: { canonical: 'https://www.8lakestours.com/faq' },
  openGraph: {
    title: '8 Lakes Tours FAQ',
    description: 'Answers about Mongolian horse trekking dates, payment split, insurance, riding experience, food, safety, and booking.',
    url: 'https://www.8lakestours.com/faq',
    images: [{ url: '/images/og-8-lakes-horseback-2026.jpg', width: 1200, height: 630, alt: '8 Lakes Tours Mongolia horseback expedition' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: '8 Lakes Tours FAQ',
    description: 'Answers about Mongolian horse trekking dates, payment split, insurance, riding experience, food, safety, and booking.',
    images: ['/images/og-8-lakes-horseback-2026.jpg'],
  },
  robots: { index: true, follow: true },
};

const pageStyle = { background: '#0e0c09', minHeight: '100vh', color: '#d4cfc4', fontFamily: "var(--font-jost), 'Jost', sans-serif", fontWeight: 300 } as const;
const linkStyle = { fontSize: '0.7rem', letterSpacing: '0.2em', textTransform: 'uppercase', color: '#c8a96e', textDecoration: 'none' } as const;
const wrapperStyle = { maxWidth: '760px', margin: '0 auto', padding: '5rem 2rem' } as const;
const footerStyle = { borderTop: '1px solid rgba(200,169,110,0.15)', padding: '2rem 4rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' } as const;

const FAQ_ITEMS = [
  ['What is 8 Lakes Tours?', '8 Lakes Tours is a 9-day / 8-night small-group horse trekking expedition in Mongolia, focused on the Orkhon Valley and Naiman Nuur / Eight Lakes region. Guests stay with a nomadic family, ride Mongolian horses, sleep in traditional gers, and experience daily life on the steppe.'],
  ['Who organises the trip?', "8 Lakes Tours is organised by Robert Zaher after travelling and riding with Ganbold's family in the Orkhon Valley. Bookings, preparation, and payment communication are handled through 8 Lakes Tours, while the local family portion goes directly to your hosts in Mongolia."],
  ['Can I speak to someone before booking?', "Yes. Email info@8lakestours.com with any questions before paying. Rob's Instagram is @robzaher108, but tour enquiries currently stay centralised through info@8lakestours.com."],
  ['How much does the trip cost?', 'All official prices are in USD. Price depends on group size: $1,999 per person for 1–2 guests, $1,949 for 3–4, $1,899 for 5–6, and $1,799 for 7–8. Group rates apply when guests book together for the same departure, and the discount is shared evenly between 8 Lakes Tours and the host family rather than taken out of the family portion alone.'],
  ['What departure dates are available?', 'The website shows currently bookable departures and automatically removes dates once they begin. Scheduled departures book and pay online the same way. A private group date of your own choosing remains available on request. Each departure is capped at 8 guests and final availability depends on host-family, horse, guide, and group logistics.'],
  ['Why is part of the price paid in cash locally?', 'Many of the nomadic families we work with cannot reliably receive online payments or bank transfers. Paying the family portion directly in clean USD cash ensures that money reaches the hosts transparently.'],
  ['Is the online payment a deposit?', 'No. It is best understood as the online booking payment that confirms your place. It is $999 per guest for 1–2 guests, and $974, $949, or $899 per guest for larger groups, because the group discount is shared evenly between 8 Lakes Tours and the host family. Scheduled groups of 1–8 pay together in one secure Stripe checkout. The separate family portion is paid locally in clean USD cash to the host family and also varies by group size.'],
  ['What happens after I submit the booking form?', 'For bookings of 1–2 guests on a scheduled date, you can continue straight to the online payment and receive confirmation once payment is complete. Scheduled groups of 1–8 pay the exact online amount together in a single Stripe checkout. Only for a private date of your own choosing does our team confirm availability first and then send the correct payment link or custom order. Before arrival, our team coordinates timing with you and the host-family pickup from Bat-Ulzii.'],
  ['What is the cancellation policy?', 'If your plans change more than 3 weeks / 21 days before departure, the online booking payment is refundable minus unrecoverable Stripe/payment processing fees. If you cancel within 3 weeks / 21 days of departure, you are entitled to a refund of 50% of the online booking payment, minus unrecoverable Stripe/payment processing fees. We will still try to help with a transfer to another date or an approved replacement traveller as well, which can recover more than the 50%. If 8 Lakes Tours cancels your departure, the online amount you paid to us is refunded minus unrecoverable Stripe/payment processing fees. The local family payment is paid in cash in Mongolia and is not collected online by 8 Lakes Tours.'],
  ['Do I need riding experience?', 'No. Beginners are welcome, although a reasonable level of fitness is recommended. Local guides teach basic horse handling before the trek.'],
  ['How flexible do I need to be?', 'This is a real remote adventure, not a perfectly controlled resort itinerary. Weather, horse conditions, road access, and group dynamics can affect the plan. We ask guests to arrive with flexibility, patience, and a willingness to adapt. That said, you never have to do every challenge or activity. If something feels like too much, you can say no, rest, or take a quieter day around the host family and ger life.'],
  ['Why is uncertainty part of the trip?', 'The Eight Lakes region sits in real steppe country, where distance, weather, animals, and road conditions can shape the day. A simple Mongolian hospitality story explains the mindset: when travellers lost their way between distant gers, they could stop at another family home for tea, food, shelter, directions, or supplies. The trip asks guests to embrace that same culture of flexibility, hospitality, and variance rather than expecting a perfectly controlled resort itinerary.'],
  ['Are we completely isolated in the wilderness?', 'No. The landscape is wide and remote from city life, but it is not empty or abandoned. Mongolian steppe culture is famously hospitable: neighbouring families visit each other, share food and tea, help with animals and work, and know the land around them. You should expect simple conditions, but not a survival scenario where food, people, or basic support disappear.'],
  ['What if communication or translation gets difficult?', 'The host-family setting is cross-cultural, and not every moment will happen in perfect English. Guides and organisers help with the main logistics, but Grok has worked best for simple Mongolian communication so far; ChatGPT voice mode also works well for translation. The host nomadic camp has strong Starlink and a solar-powered inverter for charging phones, cameras, and other electronics, though remote trek days can still be more offline.'],
  ['Will I be pushed outside my comfort zone?', 'Sometimes, yes — gently and with common sense. The trip is built around the idea that wild places, movement, and challenge can be good for people. You may be encouraged to try more than you expected, but participation is never forced. This trip suits people who are open-minded and mentally prepared for simple conditions, physical discomfort, changing plans, and sharing space with a group without needing everything to be polished or predictable.'],
  ['Are there Western toilets or showers in the countryside?', 'No. Once you leave the city, countryside toilet facilities are simple outhouses with squat toilets rather than Western flush toilets, and there are no regular showers. The cabins and ger stays can still be warm, welcoming, and comfortable in a rural way, but bathroom facilities are basic. Bring wet wipes for cleaning hands and body between river washes; optional daily river cold plunges can be part of the simple, therapeutic steppe rhythm when conditions allow.'],
  ['What medical supplies should I bring?', 'Bring a small personal first-aid kit, blister care, any prescription medication, basic toiletries, and any painkillers or anti-inflammatory medicine you normally use and can safely take. Guides carry basic first aid, but they are not medical professionals and cannot replace your own personal medical supplies.'],
  ['What is included?', 'The trip includes accommodation, meals, horses, local guiding, ger stays, and the hosted horse trekking experience described on the site, plus camping gear for the trek: tents, sleeping mats, warm sleeping bags and camp cooking kit. You are welcome to bring your own gear if you prefer. Flights, visas, travel insurance, and personal expenses are not included.'],
  ['Can you support vegan, lactose-free, or strict dietary requirements?', 'This trip is not a good fit for strict vegan travellers, and it may be unsuitable for anyone with serious dairy or lactose intolerance. In rural Mongolia, daily host-family food is traditionally meat- and dairy-heavy: milk tea, yoghurt, cheese, meat, and animal products are normal parts of the diet and hospitality. The dairy is also one of the highest-quality parts of the experience: families always produce their own milk from yaks or cows and serve it fresh in traditional foods. Vegetarian guests may be possible with advance notice, but remote families cannot reliably provide fully separate vegan or dairy-free meals. Please contact us before booking if diet is a major health, allergy, or ethical requirement.'],
  ['What airport should I use?', 'Fly into Chinggis Khaan International Airport in Ulaanbaatar, Mongolia. Guests then travel onward into the countryside before the host-family stay and trek begin.'],
  ['Do I need a visa?', 'Many travellers can enter Mongolia visa-free for tourism, but the allowance depends on your passport. US and South Korean passport holders commonly receive up to 90 days; UK/EU, Australian, Canadian, Japanese, New Zealand, and many other passport holders commonly receive up to 30 days. Rules and temporary exemptions can change, so check the current Mongolian consular or e-visa guidance for your nationality before booking flights.'],
  ['Is there WiFi or cell service?', 'Remote trek days are mostly offline, with little to no cell service. The host family camp has Starlink and solar-powered charging for phones, cameras, and essentials, so you can reconnect between riding days. For simple Mongolian communication, Grok has worked best for us so far; ChatGPT also works well for translation when you have signal.'],
  ['Is this trip safe?', 'Yes. Basic first aid is available on site and experienced local guides — including Suma, who has led numerous tourist groups through this terrain — are with you throughout the journey. Ground transportation is on call for emergencies and can reach the ger village within a few hours. All participants are required to carry travel insurance with emergency evacuation coverage before departure.'],
  ['Is travel insurance required?', 'Yes. Comprehensive travel insurance is mandatory and should include medical treatment, emergency evacuation and repatriation, and horseback riding or adventure activity coverage.'],
  ['Can children join?', 'For the full horse trek, we generally encourage families with younger children not to book the standard expedition because the riding days, remote conditions, weather, and group pace can be too much. Riders aged 16+ can join the trek with a parent or guardian if the fit is right. For younger children, a custom stay-only setup with shorter horse rides around the host family can be arranged — the families can facilitate that without problem.'],
  ['How do I contact 8 Lakes Tours?', "Use the booking form on the website or email info@8lakestours.com. Instagram is available at @8lakestours, and Rob's personal Instagram is @robzaher108."],
] as const;

const usd = (amount: number) => `$${amount.toLocaleString('en-US')}`;

type Guide = { id: string; title: string; paragraphs: string[] };

function planningGuides(priceHoldActive: boolean): Guide[] {
  const groupTiers = GROUP_PRICING_TIERS.slice(1).map(tier => usd(tier.perPersonUsd));
  const priceParagraph = priceHoldActive
    ? `Our 9-day trip is ${usd(BASE_PRICE_USD)} per person for one or two guests if you book by ${PRICE_HOLD_DEADLINE_LABEL}. From ${PRICE_INCREASE_DATE_LABEL} the price is ${usd(PRICE_AFTER_HOLD_USD)}. Groups of three to eight booking together currently pay less per person: ${groupTiers.slice(0, -1).join(', ')} or ${groupTiers[groupTiers.length - 1]}, depending on group size.`
    : `Our 9-day trip is ${usd(BASE_PRICE_USD)} per person for one or two guests, with lower group rates for three to eight guests booking together.`;

  return [
    {
      id: 'best-time-to-go',
      title: 'When is the best time to go horse trekking in Mongolia?',
      paragraphs: [
        'The riding season runs from late spring to early autumn. We run departures every two weeks from May to September. Outside those months it is too cold for days in the saddle and nights in a tent.',
        'May and early June: the steppe is waking up. Days are mild, nights are cold, and the grass is only starting to come back. It is quiet, with very few other travellers around.',
        'June: my favourite month. The valleys turn green, the evenings are long and golden, and it is usually drier than July and August. If you are coming to take photos or film, come in June.',
        'July: the warmest month and the busiest for travel in Mongolia. Naadam, the national festival of horse racing, wrestling and archery, happens in mid-July. It is also the wettest stretch of summer, so expect afternoon storms.',
        'August: still warm and green, with rain on and off. The grass is at its tallest and the horses are strong after a summer of grazing.',
        'September: the larch forests turn gold, the nights get properly cold and the crowds are gone. Snow can come early in the mountains toward the end of the month. Our last departure of the season leaves on 21 September.',
        'Whatever month you pick, pack for all four seasons. Steppe weather can go from hot sun to cold wind and rain in one afternoon.',
      ],
    },
    {
      id: 'how-much-does-it-cost',
      title: 'How much does a horse trek in Mongolia cost?',
      paragraphs: [
        priceParagraph,
        `You pay ${usd(BASE_ONLINE_PAYMENT_USD)} per guest online when you book. The other ${usd(BASE_LOCAL_FAMILY_PAYMENT_USD)} is paid in US dollar cash straight to the host family when you arrive, because most nomadic families cannot easily receive bank transfers.`,
        'That covers everything once you are with us: your ger stay, all your meals, horses, local guides, camping gear for the trek, and pickup from Bat-Ulzii.',
        'It does not cover flights to Ulaanbaatar, the bus from Ulaanbaatar to Bat-Ulzii, a visa if your passport needs one, travel insurance (which you must have, and it has to cover horse riding), or anything you buy for yourself. Most people also spend a night or two in Ulaanbaatar on either end.',
        `Worked out per day, ${usd(BASE_PRICE_USD)} comes to about ${usd(Math.round(BASE_PRICE_USD / 9))} a day for your food, your bed, your horse and your guide.`,
      ],
    },
    {
      id: 'riding-experience',
      title: 'Do I need riding experience to ride in Mongolia?',
      paragraphs: [
        'No. Most of our guests are beginners or ride a few times a year. The local horsemen teach you the basics before the trek starts and ride with you the whole way.',
        'Mongolian horses are smaller than most Western horses. They are tough and sure-footed, and they know the ground far better than you do.',
        'Fitness matters more than experience. On the trek you are in the saddle for several hours a day, and there is a lot of trotting. A few lessons at home before you come will make the first days much more comfortable, especially practising the trot. Expect sore legs for the first couple of days. It passes.',
        'You never have to do more than you want to. If you need a rest, you can stay back with the family for a quieter day.',
        'Riders aged 16 and over can join the trek with a parent or guardian if the fit is right. For families with younger children we can set up a stay with the host family and shorter rides instead.',
      ],
    },
    {
      id: 'orkhon-khovsgol-gobi',
      title: 'Orkhon Valley, Khövsgöl or the Gobi: where should you ride?',
      paragraphs: [
        'These are the three places most people look at for a trip to Mongolia, and they are very different.',
        'Lake Khövsgöl is in the far north near the Russian border: a huge, clear lake surrounded by forest. It is beautiful, and it is one of the most visited places in the country, so in July you will share it with plenty of other travellers and tourist camps. Getting there means a flight to Mörön or a long drive.',
        'The Gobi is desert country in the south, with sand dunes, rock canyons and huge empty plains. It is more of a camel and jeep trip than a horse trip, and summer days get very hot.',
        'The Orkhon Valley is in central Mongolia. It is a UNESCO World Heritage site, a wide river valley where nomadic families have grazed their herds for centuries. From there we ride up into the hills to the Eight Lakes (Naiman Nuur), a remote cluster of lakes among larch forest.',
        'If you want desert, go to the Gobi. If you want a famous lake with plenty of places to stay, Khövsgöl is great. If you want to spend most of your days on horseback and live with a nomadic family while you do it, I would go to central Mongolia, and that is where we ride.',
      ],
    },
  ];
}

export default function Page() {
  const guides = planningGuides(isPriceHoldActive());
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    '@id': 'https://www.8lakestours.com/faq#faq',
    url: 'https://www.8lakestours.com/faq',
    inLanguage: 'en',
    mainEntity: [
      ...FAQ_ITEMS.map(([question, answer]) => ({
        '@type': 'Question',
        name: question,
        acceptedAnswer: { '@type': 'Answer', text: answer },
      })),
      ...guides.map(guide => ({
        '@type': 'Question',
        name: guide.title,
        url: `https://www.8lakestours.com/faq#${guide.id}`,
        acceptedAnswer: { '@type': 'Answer', text: guide.paragraphs.join(' ') },
      })),
    ],
  };

  return (
    <main style={pageStyle}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <SiteNav />
      <style>{`
        .page-hero { position: relative; display: flex; align-items: flex-end; justify-content: center; min-height: 58vh; padding: 8rem 2rem 3rem; text-align: center; overflow: hidden; }
        .page-hero-media { position: absolute; inset: 0; background: #0e0c09 url('/videos/faq-horse-mane-poster.jpg?v=4') center / cover no-repeat; }
        .page-hero-video.is-playing { opacity: 1; }
        .page-hero-video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: center 45%; opacity: 0; transition: opacity 1.6s ease; }
        @media (max-width: 900px) { .page-hero-media { background-image: url('/videos/faq-horse-mane-poster-mobile.jpg?v=4'); } }
        @media (prefers-reduced-motion: reduce) { .page-hero-video { display: none; } }
        .page-hero-overlay { position: absolute; inset: 0; background: radial-gradient(ellipse at 50% 35%, rgba(14,12,9,0) 28%, rgba(14,12,9,0.5) 100%), linear-gradient(to top, rgba(14,12,9,1) 2%, rgba(14,12,9,0.76) 30%, rgba(14,12,9,0.34) 68%, rgba(14,12,9,0.66) 100%); }
        .page-hero-copy { position: relative; z-index: 1; max-width: 820px; }
        .page-hero-copy .page-hero-eyebrow { font-size: 0.65rem; letter-spacing: 0.3em; text-transform: uppercase; color: #c8a96e; margin: 0 0 1rem; }
        .page-hero-copy h1 { font-family: var(--font-cormorant), 'Cormorant Garamond', serif; font-size: clamp(2.8rem, 8vw, 5rem); font-weight: 300; line-height: 0.98; color: #f5f0e8; margin: 0; }
        .page-hero-copy .page-hero-intro { margin: 1.4rem auto 0; max-width: 660px; font-size: 1rem; line-height: 1.8; color: rgba(212,207,196,0.86); }
        @media (max-width: 900px) { .page-hero { min-height: 48vh; padding: 6rem 1.25rem 2.25rem; } }
        .guides { margin-top: 4.5rem; padding-top: 3rem; border-top: 1px solid rgba(200,169,110,0.15); }
        .guides-eyebrow { font-size: 0.65rem; letter-spacing: 0.3em; text-transform: uppercase; color: #c8a96e; margin: 0 0 0.8rem; }
        .guides-title { font-family: var(--font-cormorant), 'Cormorant Garamond', serif; font-size: clamp(2rem, 5vw, 2.8rem); font-weight: 300; color: #f5f0e8; margin: 0 0 1.2rem; line-height: 1.1; }
        .guides-toc { list-style: none; padding: 0; margin: 0 0 1rem; display: grid; gap: 0.5rem; }
        .guides-toc a { color: #c8a96e; text-decoration: none; font-size: 0.95rem; line-height: 1.5; }
        .guides-toc a:hover { text-decoration: underline; }
        .guide { padding-top: 2.6rem; scroll-margin-top: 5rem; }
        .guide h3 { font-family: var(--font-cormorant), 'Cormorant Garamond', serif; font-size: clamp(1.5rem, 4vw, 1.9rem); font-weight: 400; color: #f5f0e8; margin: 0 0 1rem; line-height: 1.2; }
        .guide p { font-size: 0.98rem; line-height: 1.85; margin: 0 0 1rem; color: rgba(212,207,196,0.9); }
        .guide-cta { display: inline-block; margin-top: 0.4rem; }
      `}</style>
      <header className="page-hero">
        <div className="page-hero-media" role="img" aria-label="Close-up of a Mongolian horse&apos;s mane and eye">
          <HeroVideo className="page-hero-video" desktopSrc="/videos/faq-horse-mane-loop.mp4?v=5" mobileSrc="/videos/faq-horse-mane-loop-mobile.mp4?v=5" />
          <div className="page-hero-overlay" />
        </div>
        <div className="page-hero-copy">
          <p className="page-hero-eyebrow">FAQ</p>
          <h1>Common Questions</h1>
          <p className="page-hero-intro">Clear answers for travellers comparing Mongolian horse trekking trips, checking payment structure, or asking an AI assistant to explain 8 Lakes Tours.</p>
        </div>
      </header>
      <div style={{...wrapperStyle, paddingTop: '3.5rem'}}>
        <FaqAccordion items={FAQ_ITEMS} />
        <section className="guides" aria-labelledby="planning-guides">
          <p className="guides-eyebrow">Planning your ride</p>
          <h2 className="guides-title" id="planning-guides">Before you book</h2>
          <ul className="guides-toc">
            {guides.map(guide => <li key={guide.id}><a href={`#${guide.id}`}>{guide.title}</a></li>)}
          </ul>
          {guides.map(guide => (
            <article className="guide" id={guide.id} key={guide.id}>
              <h3>{guide.title}</h3>
              {guide.paragraphs.map(paragraph => <p key={paragraph.slice(0, 40)}>{paragraph}</p>)}
            </article>
          ))}
          <p className="guide"><Link href="/#book" className="guide-cta" style={linkStyle}>See dates and book</Link></p>
        </section>
      </div>
      <footer style={footerStyle}>
        <span style={{ fontSize: '0.75rem', color: '#d4cfc4', opacity: 0.4 }}>© 2026 8 Lakes Tours · All rights reserved</span>
        <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
          <Link href="/terms" style={{...linkStyle, opacity: 0.75}}>Terms</Link>
          <Link href="/privacy" style={{...linkStyle, opacity: 0.75}}>Privacy</Link>
          <Link href="/llms.txt" style={{...linkStyle, opacity: 0.75}}>LLMs.txt</Link>
        </div>
      </footer>
    </main>
  );
}
