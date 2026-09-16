"use client";
import Image from 'next/image';
import { track } from '@vercel/analytics';
import { type FormEvent, type MouseEvent, useEffect, useMemo, useRef, useState } from 'react';
import { GROUP_INVOICE, manualPaymentReason, normalizeTourDateSelection } from '@/lib/tour-booking.mjs';
import { getDefaultTourDate } from '@/lib/tour-dates.mjs';
import { BASE_LOCAL_FAMILY_PAYMENT_USD, BASE_ONLINE_PAYMENT_USD, BASE_PRICE_USD, GROUP_PRICING_TIERS, MAX_GROUP_SIZE, clampGuestCount, getGroupPricing } from '@/lib/group-pricing.mjs';
import { normalizeBookingTravellers } from '@/lib/booking-travellers.mjs';
import { composeDateOfBirth, splitDateOfBirth } from '@/lib/date-of-birth-fields.mjs';
import MobileNavMenu from './components/MobileNavMenu';

type FunnelEventProperties = Record<string, string | number | boolean>;

type TourDateOption = {
  date: string;
  detail: string;
  status: string;
  startDate?: string;
  endDate?: string;
  muted?: boolean;
  availableUntil?: string;
  requiresConfirmation?: boolean;
};

type AttributionPayload = {
  landing_url?: string;
  current_url?: string;
  referrer?: string;
  source?: string;
  medium?: string;
  campaign?: string;
  term?: string;
  content?: string;
  gclid?: string;
  fbclid?: string;
  ttclid?: string;
  msclkid?: string;
  ga_client_id?: string;
  ga_session_id?: string;
};

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
  }
}

const GA_MEASUREMENT_ID = 'G-E9PW7T08LZ';

function trackFunnelEvent(name: string, properties: FunnelEventProperties = {}) {
  track(name, properties);

  if (typeof window === 'undefined' || typeof window.gtag !== 'function') return;

  window.gtag('event', name, {
    event_category: 'booking_funnel',
    ...properties,
  });
}

const ATTRIBUTION_STORAGE_KEY = 'eight_lakes_first_attribution';

function getGaClientId() {
  if (typeof document === 'undefined') return '';
  const gaCookie = document.cookie
    .split('; ')
    .find(cookie => cookie.startsWith('_ga='))
    ?.split('=')[1];

  if (!gaCookie) return '';
  const parts = gaCookie.split('.');
  return parts.length >= 4 ? `${parts[2]}.${parts[3]}` : gaCookie;
}

function getGaClientIdFromGtag(): Promise<string> {
  if (typeof window === 'undefined' || typeof window.gtag !== 'function') return Promise.resolve('');

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: unknown) => {
      if (settled) return;
      settled = true;
      resolve(typeof value === 'string' ? value : '');
    };

    window.setTimeout(() => finish(''), 700);
    window.gtag?.('get', GA_MEASUREMENT_ID, 'client_id', finish);
  });
}

// The GA session id arrives in the _ga_<MEASUREMENT_ID> cookie (the same
// identifier the tag sends as ga_session_id). It is read directly from the
// consented browser and never defaulted: without a real session id, GA4
// Measurement Protocol session attribution cannot join the server-side
// payment_received event to the visitor's session source.
function getGaSessionIdFromCookie(): string {
  if (typeof document === 'undefined') return '';
  const rawParts = document.cookie
    .split('; ')
    .find(cookie => cookie.startsWith(`_ga_${GA_MEASUREMENT_ID.slice(2)}=`))
    ?.split('=');
  const parts = Array.isArray(rawParts) ? rawParts : [];
  return parts.length >= 2 ? parts.slice(1).join('=') : '';
}

async function collectAttributionWithGaRetry() {
  const attribution = collectAttribution();
  if (attribution.ga_client_id) return attribution;

  const clientId = await getGaClientIdFromGtag();
  if (!clientId) return attribution;

  const next = { ...attribution, ga_client_id: clientId };
  try {
    const stored = window.localStorage.getItem(ATTRIBUTION_STORAGE_KEY);
    const first = stored ? JSON.parse(stored) as AttributionPayload : {};
    window.localStorage.setItem(ATTRIBUTION_STORAGE_KEY, JSON.stringify({ ...first, ga_client_id: first.ga_client_id || clientId }));
  } catch {
    // Storage can be blocked; the current submit payload still carries the client id.
  }
  return next;
}

function collectAttribution(): AttributionPayload {
  if (typeof window === 'undefined') return {};

  const params = new URLSearchParams(window.location.search);
  const current: AttributionPayload = {
    landing_url: window.location.href,
    current_url: window.location.href,
    referrer: document.referrer || '',
    source: params.get('utm_source') || '',
    medium: params.get('utm_medium') || '',
    campaign: params.get('utm_campaign') || '',
    term: params.get('utm_term') || '',
    content: params.get('utm_content') || '',
    gclid: params.get('gclid') || '',
    fbclid: params.get('fbclid') || '',
    ttclid: params.get('ttclid') || '',
    msclkid: params.get('msclkid') || '',
    ga_client_id: getGaClientId(),
    ga_session_id: getGaSessionIdFromCookie(),
  };

  let first: AttributionPayload = {};
  try {
    const stored = window.localStorage.getItem(ATTRIBUTION_STORAGE_KEY);
    first = stored ? JSON.parse(stored) as AttributionPayload : {};
  } catch {
    first = {};
  }

  if (!first.landing_url) {
    first = current;
    try {
      window.localStorage.setItem(ATTRIBUTION_STORAGE_KEY, JSON.stringify(first));
    } catch {
      // Storage can be blocked in private browsing; attribution is best-effort.
    }
  }

  return {
    ...first,
    current_url: current.current_url,
    ga_client_id: current.ga_client_id || first.ga_client_id || '',
    // The session id is read fresh at submit time: a stored value from an
    // earlier visit could be a different, expired session, which would point
    // GA4 session attribution at the wrong session.
    ga_session_id: current.ga_session_id || first.ga_session_id || '',
  };
}

type CurrencyCode = 'USD' | 'EUR' | 'GBP' | 'RUB' | 'MNT';

type LocalizedPricing = {
  currency: CurrencyCode;
  countryLabel: string;
  tourPrice: string;
  onlinePayment: string;
  localFamilyPayment: string;
};

const COUNTRY_LABEL_BY_CURRENCY: Record<CurrencyCode, string> = {
  USD: 'USD pricing',
  EUR: 'Europe pricing',
  GBP: 'UK pricing',
  RUB: 'Russia pricing',
  MNT: 'Mongolia pricing',
};

const DISPLAY_EXCHANGE_RATES: Record<CurrencyCode, number> = {
  USD: 1,
  EUR: 0.92,
  GBP: 0.79,
  RUB: 90,
  MNT: 3450,
};

const PACKING_LIST = [
  'Warm sleeping bag rated for cold steppe nights',
  'Enough layers to handle all seasons in one trip — pack warmer rather than lighter',
  'Comfortable riding boots or sturdy hiking boots',
  'Light camp shoes or flip-flops',
  'Rain jacket or waterproof shell for sudden weather changes',
  'Warm base layer, fleece/down layer, hat and gloves for cold mornings and evenings',
  'Riding gloves or lightweight outdoor gloves',
  'Sun hat or cap',
  'Sunglasses with secure strap',
  'Swimsuit for daily river ice baths, lakes or hot springs',
  'Headlamp or small flashlight',
  'Reusable water bottle',
  'Sunscreen and lip balm with SPF',
  'Mosquito repellent',
  'Personal medication and basic toiletries',
  'Personal first-aid kit, blister care and any painkillers/anti-inflammatory medicine you normally use',
  'Wet wipes for cleaning hands and body when there are no showers',
  'Hand cream or Vaseline for dry weather',
  'Travel pillow if you sleep better with one',
  'Universal adapter plug and power bank',
  'Binoculars or camera if you want them',
];

function detectRegion(): string | undefined {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (timezone?.startsWith('Europe/')) return 'NL';
  if (timezone?.startsWith('America/')) return 'US';
  if (timezone === 'Asia/Ulaanbaatar') return 'MN';

  if (typeof navigator !== 'undefined') {
    const locales = navigator.languages?.length ? navigator.languages : [navigator.language];
    for (const locale of locales) {
      try {
        const region = new Intl.Locale(locale).region;
        if (region) return region.toUpperCase();
      } catch {
        // Ignore malformed browser locale strings.
      }
    }
  }

  return undefined;
}

function formatApproxUsd(amountUsd: number, currency: CurrencyCode) {
  const converted = amountUsd * DISPLAY_EXCHANGE_RATES[currency];
  const rounded = currency === 'MNT' ? Math.round(converted / 1000) * 1000 : Math.round(converted);
  const useCompactNotation = rounded >= 100000;

  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    notation: useCompactNotation ? 'compact' : 'standard',
    maximumFractionDigits: useCompactNotation ? 2 : 0,
  }).format(rounded);
}

function getLocalizedPricing(groupPricing = getGroupPricing(1)): LocalizedPricing {
  // Official trip pricing is USD for all customers. We avoid browser-localized
  // conversion estimates because checkout and the host-family cash portion are
  // both operationally USD.
  detectRegion();
  const currency: CurrencyCode = 'USD';

  return {
    currency,
    countryLabel: COUNTRY_LABEL_BY_CURRENCY[currency],
    tourPrice: formatApproxUsd(groupPricing.perPersonUsd, currency),
    onlinePayment: formatApproxUsd(groupPricing.onlinePerPersonUsd, currency),
    localFamilyPayment: formatApproxUsd(groupPricing.localFamilyPerPersonUsd, currency),
  };
}

const STRIP_IMAGES = [
  { src: '/images/expedition-originals/river-horseman-silhouette-portrait.jpg', alt: 'Horseman silhouetted beside the river' },
  { src: '/images/expedition-originals/horseman-valley-lookout-portrait.jpg', alt: 'Horseman looking across the Orkhon Valley' },
  { src: '/images/expedition-originals/suma-river-crossing-original.jpg', alt: 'Suma riding through a shallow river crossing' },
  { src: '/images/expedition-originals/orkhon-valley-sunset-wide.jpg', alt: 'Sunset over the Orkhon Valley river bends' },
  { src: '/images/expedition-originals/ger-and-van-camp-wide.jpg', alt: 'Traditional ger camp with a van and mountain backdrop' },
  { src: '/images/expedition-originals/yaks-river-backlit-portrait.jpg', alt: 'Yaks grazing beside the river in backlit evening sun' },
];

const MAIN_ALBUM_IMAGES = [
  { src: '/images/guide-horse-portrait.jpg', alt: 'Suma standing with his horse on the open steppe', orientation: 'portrait', collage: 'lead' },
  { src: '/images/gallery-extra/horseback-storm-valley-pov.jpg', alt: 'Horseback point of view riding into a stormy mountain valley', orientation: 'landscape', collage: 'hero' },
  { src: '/images/gallery-extra/packed-horses-rain-camp.jpg', alt: 'Packed horses waiting under storm clouds', orientation: 'landscape', collage: 'wide-left' },
  { src: '/images/gallery-extra/horses-in-forest-rain.jpg', alt: 'Pack horses resting in the forest rain', orientation: 'landscape', collage: 'wide-right' },
  { src: '/images/expedition-originals/ger-blue-hour-original.jpg', alt: 'Ger at blue hour beneath the mountains', orientation: 'landscape', collage: 'small-a' },
  { src: '/images/gallery-extra/orkhon-valley-sunburst-panorama.jpg', alt: 'Sunburst over the Orkhon Valley river bends after rain', orientation: 'landscape', collage: 'small-b' },
  { src: '/images/eagle-portrait-original.jpg', alt: 'Close portrait of a Mongolian eagle', orientation: 'portrait', objectPosition: '72% center', collage: 'tall' },
  { src: '/images/gallery-extra/rider-rearing-horse-wide.jpg', alt: 'Rider on a rearing horse against the sky', orientation: 'landscape', collage: 'bottom-left' },
  { src: '/images/gers2.jpg', alt: 'White gers spread across open grassland below the mountains', orientation: 'landscape', collage: 'bottom-mid' },
  { src: '/images/expedition-originals/rider-storm-valley-panorama-portrait.jpg', alt: 'Horseback point of view crossing a grassy Mongolian valley under storm clouds', orientation: 'portrait', mobileFullWidth: true, collage: 'bottom-right' },
];

const HOME_FAQS = [
  { q: 'What happens after I submit the form?', a: 'For standard 1–2 guest bookings, you can continue to the online payment and receive confirmation once payment is complete. Scheduled groups of 1–8 pay the exact group online amount in one Stripe checkout. Private, custom, and unconfirmed dates require our team to confirm availability before payment. Before arrival, our team coordinates timing with you and the host-family pickup from Bat-Ulzii.' },
  { q: 'Do I need riding experience?', a: 'No experience necessary. Beginners are welcome — our local guides will teach you everything you need to know before the trek begins.' },
  { q: 'What departure dates are available?', a: 'Remaining 2026 fixed departures stay listed while bookable. 2027 small-group dates are being planned, and private 2027 departures can be requested for June through September. All 2027 options require our team to confirm the host family, horses, guide and logistics before payment.' },
  { q: 'How does payment work?', a: 'All official prices are in USD. The 2026 rate depends on group size: $1,999 per person for 1–2 guests, $1,949 for 3–4, $1,899 for 5–6, and $1,799 for 7–8. Bookings of 1–2 guests on a fixed date pay the $999 per-guest online booking payment straight after the form. Groups of 1–8 book together and pay the exact group online amount in one secure Stripe checkout. Group discounts are shared evenly between 8 Lakes Tours and the host family, so the online payment runs $899–$999 per guest and the local family cash runs $900–$1,000 per guest. The family portion is paid directly in clean USD cash to the nomadic host families in Mongolia.' },
  { q: 'Do I need a visa?', a: 'Many travellers can enter Mongolia visa-free for tourism, but the allowance depends on your passport. US and South Korean passport holders commonly receive up to 90 days; UK/EU, Australian, Canadian, Japanese, New Zealand, and many other passport holders commonly receive up to 30 days. Rules and temporary exemptions can change, so check the current Mongolian consular or e-visa guidance for your nationality before booking flights.' },
  { q: 'Is there WiFi or cell service?', a: 'Remote trek days are mostly offline, with little to no cell service. The host family camp has Starlink and solar-powered charging for phones, cameras, and essentials, so you can reconnect between riding days. For simple Mongolian communication, Grok has worked best for us so far; ChatGPT also works well for translation when you have signal.' },
];

const TESTIMONIAL_CARDS = [
            {
              name: 'Irik · USA',
              src: '/images/testimonial-irik-clawson-sunset.jpg',
              alt: 'Robert Zaher smiling on horseback beside a river valley',
              quote: 'Endless riding from one plain to the next, across the Steppe, by the lakes…. Magical. What more is there in life?',
              objectPosition: 'center',
            },
            {
              name: 'Milou · AU',
              src: '/images/testimonial-milou.jpeg',
              alt: 'Milou travelling by motorbike through the Mongolian steppe',
              quote: 'So grateful to be able to stay with the loveliest family in Mongolia, experience life on the steppe and trek with horses through the most beautiful landscapes!',
              objectPosition: '76% center',
            },
            {
              name: 'Fin · UK',
              src: '/images/testimonial-fin-bennet-host.jpg',
              alt: 'Fin Bennet and his Mongolian host wearing traditional deels on the open steppe',
              quote: 'It couldn’t be further from back home and that makes me so excited.',
              objectPosition: 'center 42%',
            },
          ];

const GALLERY_IMAGES = [
  { src: '/images/guide.jpg', alt: 'Mongolian horseman in traditional dress' },
  { src: '/images/rob-family.jpg', alt: 'Robert with the host family outside a traditional ger in Mongolia' },
  { src: '/images/testimonial-irik-clawson-sunset.jpg', alt: 'Robert Zaher smiling on horseback beside a river valley' },
  { src: '/images/testimonial-fin-bennet-host.jpg', alt: 'Fin Bennet and his Mongolian host wearing traditional deels on the open steppe' },
  { src: '/images/testimonial-milou.jpeg', alt: 'Milou travelling by motorbike through the Mongolian steppe' },
  { src: '/images/lake.jpg', alt: 'Sunlit river valley in Mongolia' },
  { src: '/images/riding2.jpg', alt: 'Rider crossing shallow water on horseback' },
  { src: '/images/mosaic1.jpg', alt: 'Traditional Mongolian gers with grazing animals' },
  { src: '/images/mosaic2.jpg', alt: 'Ger camp at sunrise in the valley' },
  { src: '/images/mosaic3.jpg', alt: 'Mongolian eagle portrait' },
  { src: '/images/mosaic4.jpg', alt: 'Wide sunset view across the Orkhon Valley' },
  { src: '/images/riding3.jpg', alt: 'Grazing animals beside the river' },
  { src: '/images/mosaic5.jpg', alt: 'Ger silhouette at dusk' },
  ...STRIP_IMAGES.map(({ src, alt }) => ({ src, alt })),
  ...MAIN_ALBUM_IMAGES.map(({ src, alt }) => ({ src, alt })),
];

// Every image that can be opened full-frame, in one list, so the lightbox always
// shows the photo that was clicked (and arrow keys walk the whole set).
const LIGHTBOX_IMAGES: { src: string; alt: string }[] = Array.from(
  new Map(
    [
      ...GALLERY_IMAGES,
      ...STRIP_IMAGES,
      ...MAIN_ALBUM_IMAGES,
      ...TESTIMONIAL_CARDS,
      { src: '/images/suma-horseback-deel.jpg', alt: 'Suma on horseback in a traditional deel on the Mongolian steppe' },
      { src: '/images/host-family-horses-deels.jpg', alt: 'Robert with the host family and their horses, all in traditional deels on the Mongolian steppe' },
    ].map(image => [image.src, { src: image.src, alt: image.alt }] as const),
  ).values(),
);


function WaiverModal({ onClose, onAgree }: { onClose: () => void; onAgree: () => void }) {
  const [signature, setSignature] = useState('');
  const [agreed, setAgreed] = useState(false);
  const canProceed = signature.trim().length > 1 && agreed;

  return (
    <div style={{position:'fixed',inset:0,zIndex:1000,display:'flex',alignItems:'center',justifyContent:'center',padding:'1rem',background:'rgba(14,12,9,0.92)'}}>
      <div style={{background:'#1a1510',border:'1px solid rgba(200,169,110,0.3)',borderRadius:'var(--radius-card)',maxWidth:'600px',width:'100%',maxHeight:'90vh',display:'flex',flexDirection:'column'}}>
        <div style={{padding:'2rem 2rem 0',borderBottom:'1px solid rgba(200,169,110,0.15)'}}>
          <p style={{fontSize:'0.6rem',letterSpacing:'0.3em',textTransform:'uppercase',color:'var(--gold)',marginBottom:'0.6rem'}}>Required Before Payment</p>
          <h2 style={{fontFamily:"var(--font-cormorant), 'Cormorant Garamond', serif",fontSize:'1.6rem',color:'var(--cream)',fontWeight:300,marginBottom:'1.2rem'}}>Liability Waiver & Release</h2>
        </div>
        <div style={{overflowY:'auto',padding:'1.5rem 2rem',fontSize:'0.82rem',color:'var(--mist)',lineHeight:1.8,flex:1}}>
          <p style={{marginBottom:'1rem'}}>Please read this waiver carefully before proceeding. This signature records the lead booker&apos;s own waiver agreement only; it does not sign or fabricate a waiver for any companion. By signing below, you acknowledge and agree to the following terms for yourself:</p>

          <p style={{fontSize:'0.65rem',letterSpacing:'0.2em',textTransform:'uppercase',color:'var(--gold)',marginBottom:'0.4rem',marginTop:'1.2rem'}}>1. Nature of Activity</p>
          <p style={{marginBottom:'1rem'}}>8 Lakes Tours operates multi-day horseback trekking expeditions in remote wilderness areas of Mongolia. These activities take place in the Orkhon Valley and surrounding steppe, far from medical facilities, emergency services, and modern infrastructure. Participants acknowledge that this is an inherently adventurous and physically demanding experience.</p>

          <p style={{fontSize:'0.65rem',letterSpacing:'0.2em',textTransform:'uppercase',color:'var(--gold)',marginBottom:'0.4rem',marginTop:'1.2rem'}}>2. Horseback Riding Risks</p>
          <p style={{marginBottom:'1rem'}}>Horseback riding carries inherent risks including, but not limited to: falling from or being thrown by a horse, being kicked or bitten, collision with obstacles, and unpredictable animal behaviour. Horses are living animals and may react in unexpected ways regardless of rider experience. Participants ride at their own risk and must follow all instructions from their guide at all times.</p>

          <p style={{fontSize:'0.65rem',letterSpacing:'0.2em',textTransform:'uppercase',color:'var(--gold)',marginBottom:'0.4rem',marginTop:'1.2rem'}}>3. Remote Wilderness Travel</p>
          <p style={{marginBottom:'1rem'}}>Travel takes place in remote, off-grid terrain with no road access, no mobile phone coverage, and no nearby emergency services. In the event of injury or illness, evacuation may take many hours or longer. Participants must be in adequate physical health to undertake the journey and must disclose any pre-existing medical conditions to their guide prior to departure.</p>

          <p style={{fontSize:'0.65rem',letterSpacing:'0.2em',textTransform:'uppercase',color:'var(--gold)',marginBottom:'0.4rem',marginTop:'1.2rem'}}>4. Medical Emergencies</p>
          <p style={{marginBottom:'1rem'}}>8 Lakes Tours and its guides carry basic first aid supplies but are not medical professionals. In the event of a serious medical emergency, all costs associated with evacuation, treatment, and repatriation are the sole responsibility of the participant. 8 Lakes Tours accepts no liability for injury, illness, or death arising from participation in this tour.</p>

          <p style={{fontSize:'0.65rem',letterSpacing:'0.2em',textTransform:'uppercase',color:'var(--gold)',marginBottom:'0.4rem',marginTop:'1.2rem'}}>5. Travel Insurance Requirement</p>
          <p style={{marginBottom:'1rem'}}>Comprehensive travel insurance is <strong style={{color:'var(--cream)'}}>mandatory</strong> for all participants. Your policy must include coverage for: emergency medical treatment, emergency evacuation and repatriation, horseback riding and adventure activities, and trip cancellation or interruption. Proof of insurance may be requested before your departure. 8 Lakes Tours reserves the right to deny participation to anyone without adequate coverage. We recommend <a href="https://www.worldnomads.com" target="_blank" rel="noopener noreferrer" style={{color:'var(--gold)'}}>World Nomads</a> for adventure travel coverage.</p>

          <p style={{fontSize:'0.65rem',letterSpacing:'0.2em',textTransform:'uppercase',color:'var(--gold)',marginBottom:'0.4rem',marginTop:'1.2rem'}}>6. Release of Liability</p>
          <p style={{marginBottom:'1rem'}}>In consideration of being permitted to participate in this tour, I hereby release, waive, discharge, and covenant not to sue 8 Lakes Tours, its guides, the host family, their agents, employees, and representatives from any and all liability, claims, demands, or causes of action arising out of or related to any loss, damage, injury, or death, whether caused by negligence or otherwise, that may be sustained by me while participating in this tour or while on the premises of any location associated with the tour.</p>

          <p style={{fontSize:'0.65rem',letterSpacing:'0.2em',textTransform:'uppercase',color:'var(--gold)',marginBottom:'0.4rem',marginTop:'1.2rem'}}>7. Assumption of Risk</p>
          <p style={{marginBottom:'1rem'}}>I expressly acknowledge and assume all risks associated with this tour, including those resulting from the actions, inactions, or negligence of 8 Lakes Tours or any other party. I confirm that I am physically and mentally capable of participating in this activity, that I have not been advised otherwise by a medical professional, and that I undertake this activity entirely at my own risk.</p>

          <p style={{marginBottom:'0'}}>This waiver is binding upon myself, my heirs, executors, administrators, and assigns. I have read this document in full and understand its contents.</p>
        </div>
        <div style={{padding:'1.5rem 2rem',borderTop:'1px solid rgba(200,169,110,0.15)',display:'flex',flexDirection:'column',gap:'1rem'}}>
          <div>
            <label style={{fontSize:'0.65rem',letterSpacing:'0.2em',textTransform:'uppercase',color:'var(--gold)',display:'block',marginBottom:'0.5rem'}}>Type Your Full Name as Signature</label>
            <input
              type="text"
              value={signature}
              onChange={e => setSignature(e.target.value)}
              placeholder="Your full name"
              style={{width:'100%',background:'rgba(255,255,255,0.04)',border:'1px solid rgba(200,169,110,0.3)',borderRadius:'var(--radius-soft)',padding:'0.7rem 1rem',color:'var(--cream)',fontSize:'0.9rem',fontFamily:"var(--font-cormorant), 'Cormorant Garamond', serif",fontStyle:'italic',outline:'none'}}
            />
          </div>
          <label style={{display:'flex',alignItems:'flex-start',gap:'0.75rem',cursor:'pointer',fontSize:'0.82rem',color:'var(--mist)',lineHeight:1.5}}>
            <input type="checkbox" checked={agreed} onChange={e => setAgreed(e.target.checked)} style={{marginTop:'0.2rem',accentColor:'var(--gold)',flexShrink:0}} />
            <span>I have read and understood this Liability Waiver in full, and I voluntarily agree to its terms. I confirm I will obtain adequate travel insurance before departure.</span>
          </label>
          <div style={{display:'flex',flexDirection:'column',gap:'0.8rem'}}>
            {!canProceed && (
              <div style={{padding:'0.8rem',background:'rgba(200,169,110,0.1)',border:'1px solid rgba(200,169,110,0.2)',borderRadius:'var(--radius-soft)',color:'rgba(212,207,196,0.4)',fontSize:'0.75rem',letterSpacing:'0.15em',textTransform:'uppercase',textAlign:'center'}}>
                Complete Fields Above to Continue
              </div>
            )}
            {canProceed && (
              <a
                href="#application"
                target="_self"
                rel="noopener noreferrer"
                onClick={onAgree}
                style={{display:'flex',alignItems:'center',justifyContent:'center',padding:'0.8rem',background:'#635bff',border:'1px solid #635bff',color:'#fff',fontSize:'0.75rem',letterSpacing:'0.15em',textTransform:'uppercase',cursor:'pointer',borderRadius:'var(--radius-soft)',textDecoration:'none'}}
              >
                Continue to booking →
              </a>
            )}
            <button
              onClick={onClose}
              style={{padding:'0.8rem',background:'transparent',border:'1px solid rgba(200,169,110,0.3)',color:'var(--mist)',fontSize:'0.75rem',letterSpacing:'0.15em',textTransform:'uppercase',cursor:'pointer',borderRadius:'var(--radius-soft)'}}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const DOB_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOB_YEARS = Array.from({ length: new Date().getFullYear() - 1900 + 1 }, (_, index) => String(new Date().getFullYear() - index));

function DateOfBirthFields({ name, label, isLead = false }: { name: string; label: string; isLead?: boolean }) {
  const [parts, setParts] = useState({ day: '', month: '', year: '' });
  const [touched, setTouched] = useState(false);
  const result = composeDateOfBirth(parts.day, parts.month, parts.year);
  const error = touched && (result.error || (!result.value && parts.day && parts.month && parts.year ? 'Choose a real day, month and year.' : ''));
  const errorId = `${name.replaceAll('.', '-')}-date-error`;
  // Draft restore can hand back zero-padded parts ("03"); options use plain numbers.
  const update = (part: 'day' | 'month' | 'year', value: string) => {
    setParts(current => ({ ...current, [part]: value && part !== 'year' ? String(Number(value)) : value }));
  };
  const options = {
    day: Array.from({ length: 31 }, (_, index) => ({ value: String(index + 1), label: String(index + 1) })),
    month: DOB_MONTHS.map((month, index) => ({ value: String(index + 1), label: month })),
    year: DOB_YEARS.map(year => ({ value: year, label: year })),
  };
  const autocomplete = (part: 'day' | 'month' | 'year') => isLead ? `bday-${part}` : 'off';
  return (
    <fieldset className="date-of-birth-group" aria-describedby={error ? errorId : undefined}>
      <legend className="form-label">{label}</legend>
      <div className="date-of-birth-inputs">
        {(['day', 'month', 'year'] as const).map(part => (
          <div className={`date-of-birth-part ${part}`} key={part}>
            <label className="sr-only" htmlFor={`${name}-${part}`}>{`${label} ${part}`}</label>
            <select id={`${name}-${part}`} name={`${name}_${part}`} className="form-select" autoComplete={autocomplete(part)} value={parts[part]} onChange={event => { update(part, event.target.value); setTouched(true); }} onBlur={() => setTouched(true)} aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined}>
              <option value="">{part[0].toUpperCase() + part.slice(1)}</option>
              {options[part].map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </div>
        ))}
      </div>
      <input data-date-of-birth-canonical="true" name={name} type="hidden" value={result.value} autoComplete={isLead ? 'bday' : 'off'} />
      {error && <p id={errorId} className="field-error" role="alert">{error}</p>}
    </fieldset>
  );
}

export default function Home({ tourDates }: { tourDates: TourDateOption[] }) {
  const lateSeasonDepartures = tourDates.filter(option => option.startDate && option.startDate >= '2026-09-01');
  const [showWaiver, setShowWaiver] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [waiverExpanded, setWaiverExpanded] = useState(false);
  const [signature, setSignature] = useState('');
  const [email, setEmail] = useState('');
  const [formSubmitted, setFormSubmitted] = useState(false);
  const [formSubmitting, setFormSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const [validationErrors, setValidationErrors] = useState<Array<{ id: string; message: string }>>([]);
  const [bookingReference, setBookingReference] = useState('');
  const [paymentUrl, setPaymentUrl] = useState('');
  const [guestCount, setGuestCount] = useState(1);
  const [travellerAnnouncement, setTravellerAnnouncement] = useState('1 traveller section ready.');
  const [leadName, setLeadName] = useState('');
  const [leadEmail, setLeadEmail] = useState('');
  const [leadStatus, setLeadStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [leadError, setLeadError] = useState('');
  const [selectedTourDate, setSelectedTourDate] = useState(() => getDefaultTourDate(tourDates));
  const tourDateTouchedRef = useRef(false);
  const [openFaqIndex, setOpenFaqIndex] = useState<number | null>(null);
  const tourDateOptions = tourDates.map(dateOption => dateOption.date);
  const groupPricing = useMemo(() => getGroupPricing(guestCount), [guestCount]);
  const bookingFormStartedRef = useRef(false);
  const stripeClickTrackedRef = useRef(false);
  const formSubmittingRef = useRef(false);
  const submissionKeyRef = useRef<string | null>(null);
  const heroVideoRef = useRef<HTMLVideoElement | null>(null);
  const draftTimerRef = useRef<number | null>(null);
  const draftOwnershipRef = useRef<{ draft_id: string; credential: string } | null>(null);
  const bookingFormRef = useRef<HTMLFormElement | null>(null);
  const [pricing, setPricing] = useState<LocalizedPricing>({
    currency: 'USD',
    countryLabel: COUNTRY_LABEL_BY_CURRENCY.USD,
    tourPrice: formatApproxUsd(BASE_PRICE_USD, 'USD'),
    onlinePayment: formatApproxUsd(BASE_ONLINE_PAYMENT_USD, 'USD'),
    localFamilyPayment: formatApproxUsd(BASE_LOCAL_FAMILY_PAYMENT_USD, 'USD'),
  });
  const emailIsValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const signatureIsValid = signature.trim().length > 1;
  const hasRequiredContact = signatureIsValid && emailIsValid;
  const manualReason = manualPaymentReason(selectedTourDate, guestCount);
  const requiresHumanConfirmation = manualReason !== null;
  const awaitsGroupInvoice = manualReason === GROUP_INVOICE;
  const canPay = formSubmitted && Boolean(paymentUrl) && !requiresHumanConfirmation;
  const checkoutFallbackHref = canPay ? paymentUrl : '#book';
  const lightboxImage = lightboxIndex === null ? null : LIGHTBOX_IMAGES[lightboxIndex];
  const isLightboxOpen = lightboxIndex !== null;
  const restoreCheckoutDraft = async (ownership: { draft_id: string; credential: string }) => {
    const response = await fetch('/api/checkout-draft', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'load', ...ownership }),
    });
    const restored = await response.json().catch(() => null);
    const draft = restored?.ok ? restored.draft : null;
    const form = bookingFormRef.current;
    if (!draft || !form) return;
    const assign = (name: string, value: unknown) => {
      const field = form.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
      if (!field || field.value) return;
      const text = String(value || '');
      // Day/month dropdown options are unpadded ("3", not "03").
      field.value = /_(day|month)$/.test(name) && /^\d+$/.test(text) ? String(Number(text)) : text;
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
    };
    assign('first_name', draft.first_name); assign('last_name', draft.last_name); assign('email', draft.email);
    assign('phone', draft.phone); assign('tour_date', draft.tour_date); assign('guest_count', draft.guest_count); assign('notes', draft.notes);
    const restoreDate = (name: string, value: unknown, raw?: { date_of_birth_day?: string; date_of_birth_month?: string; date_of_birth_year?: string }) => {
      const parts = splitDateOfBirth(String(value || ''));
      assign(`${name}_day`, parts.day || raw?.date_of_birth_day); assign(`${name}_month`, parts.month || raw?.date_of_birth_month); assign(`${name}_year`, parts.year || raw?.date_of_birth_year);
    };
    restoreDate('date_of_birth', draft.date_of_birth, draft);
    (draft.travellers || []).forEach((traveller: { first_name?: string; last_name?: string; date_of_birth?: string; date_of_birth_day?: string; date_of_birth_month?: string; date_of_birth_year?: string }, index: number) => {
      assign(`travellers.${index + 1}.first_name`, traveller.first_name);
      assign(`travellers.${index + 1}.last_name`, traveller.last_name);
      restoreDate(`travellers.${index + 1}.date_of_birth`, traveller.date_of_birth, traveller);
    });
    // This form has controlled fields.  A restore response can arrive after the
    // visitor has already picked a date, so never write stale draft state over a
    // value currently in the form.  The date starts at the earliest bookable
    // departure, so "empty select" is no longer the user-edit signal: a draft
    // date only lands while the visitor has not personally touched either date
    // control, and a real user edit is never overwritten.
    const currentEmail = (form.elements.namedItem('email') as HTMLInputElement | null)?.value;
    const currentGuestCount = (form.elements.namedItem('guest_count') as HTMLSelectElement | null)?.value;
    const draftTourDate = normalizeTourDateSelection(String(draft.tour_date || ''));
    if (!currentEmail) setEmail(String(draft.email || ''));
    if (!tourDateTouchedRef.current && draftTourDate) setSelectedTourDate(draftTourDate);
    if (!currentGuestCount) setGuestCount(Number(draft.guest_count) || 1);
  };

  // The poster image is the LCP element; the drone loop only loads once the page is
  // up, and never for reduced-motion or data-saver visitors.
  useEffect(() => {
    const video = heroVideoRef.current;
    if (!video) return;
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || connection?.saveData) return;
    const start = () => {
      video.preload = 'auto';
      video.play().catch(() => {});
    };
    if (document.readyState === 'complete') start();
    else window.addEventListener('load', start, { once: true });
    return () => window.removeEventListener('load', start);
  }, []);

  useEffect(() => {
    const hashParams = new URLSearchParams(window.location.hash.slice(1));
    const resumeToken = hashParams.get('resume');
    if (resumeToken) {
      // The server redirects the email URL to a fragment; remove it before any later navigation.
      history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
      void fetch('/api/checkout-draft', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'recover', token: resumeToken }),
      }).then(response => response.json()).then(recovered => {
        if (!recovered?.ok || !recovered.draft_id || !recovered.credential) return;
        const ownership = { draft_id: recovered.draft_id, credential: recovered.credential };
        draftOwnershipRef.current = ownership;
        try { sessionStorage.setItem('8l_checkout_draft', JSON.stringify(ownership)); } catch { /* Storage is optional. */ }
        void restoreCheckoutDraft(ownership);
      }).catch(() => undefined);
      return;
    }
    try {
      const saved = JSON.parse(sessionStorage.getItem('8l_checkout_draft') || 'null');
      if (saved?.draft_id && saved?.credential) {
        draftOwnershipRef.current = saved;
        void restoreCheckoutDraft(saved);
      }
    } catch { /* Private browsing can disable session storage. */ }
  }, []);
  const openLightbox = (src: string) => {
    const imageIndex = LIGHTBOX_IMAGES.findIndex(image => image.src === src);
    setLightboxIndex(imageIndex >= 0 ? imageIndex : 0);
  };
  const showPreviousImage = () => setLightboxIndex(current => current === null ? current : (current + LIGHTBOX_IMAGES.length - 1) % LIGHTBOX_IMAGES.length);
  const showNextImage = () => setLightboxIndex(current => current === null ? current : (current + 1) % LIGHTBOX_IMAGES.length);

  const markBookingFormStarted = () => {
    if (bookingFormStartedRef.current) return;
    bookingFormStartedRef.current = true;
    trackFunnelEvent('booking_form_start');
  };

  const trackStripePaymentClick = () => {
    if (!canPay || stripeClickTrackedRef.current) return;
    stripeClickTrackedRef.current = true;
    trackFunnelEvent('stripe_payment_click', {
      reference: bookingReference || 'unknown',
      currency: 'USD',
      value: groupPricing.onlinePaymentUsd,
    });
  };

  const chooseTourDate = (date: string) => {
    if (formSubmitted || formSubmitting) return;
    trackFunnelEvent('date_selected', { tour_date: date });
    tourDateTouchedRef.current = true;
    setSelectedTourDate(date);
    window.setTimeout(() => {
      document.getElementById('application')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      window.setTimeout(() => document.getElementById('tour_date')?.focus({ preventScroll: true }), 520);
    }, 40);
  };

  const scrollToTourDates = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    const target = document.getElementById('tour-dates');
    if (!target) return;
    history.pushState(null, '', '#tour-dates');
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const submitLead = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLeadError('');
    setLeadStatus('saving');
    try {
      const response = await fetch('/api/leads', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: leadName,
          email: leadEmail,
          source: 'homepage_newsletter_cta',
          interest: '8 Lakes Tours newsletter, offers, deals, blog posts, field notes, and business updates',
          attribution: await collectAttributionWithGaRetry(),
        }),
      });
      const payload = await response.json().catch(() => null) as { ok?: boolean; error?: string } | null;
      if (!response.ok || !payload?.ok) throw new Error(payload?.error || 'Could not save your email. Please try again.');
      trackFunnelEvent('newsletter_signup', { source: 'homepage_newsletter_cta' });
      setLeadStatus('saved');
    } catch (error) {
      setLeadError(error instanceof Error ? error.message : 'Could not save your email. Please try again.');
      setLeadStatus('error');
    }
  };

  useEffect(() => {
    if (lightboxIndex === null || typeof window === 'undefined') return;

    const preloadIndexes = [
      lightboxIndex,
      (lightboxIndex + 1) % LIGHTBOX_IMAGES.length,
      (lightboxIndex + LIGHTBOX_IMAGES.length - 1) % LIGHTBOX_IMAGES.length,
      (lightboxIndex + 2) % LIGHTBOX_IMAGES.length,
    ];

    preloadIndexes.forEach(index => {
      const src = LIGHTBOX_IMAGES[index]?.src;
      if (!src) return;
      const image = new window.Image();
      image.decoding = 'async';
      image.src = src;
    });
  }, [lightboxIndex]);

  useEffect(() => {
    collectAttribution();
    setPricing(getLocalizedPricing(groupPricing));
  }, [groupPricing]);

  useEffect(() => {
    if (!isLightboxOpen) return;

    const scrollY = window.scrollY;
    const previousBodyStyles = {
      overflow: document.body.style.overflow,
      position: document.body.style.position,
      top: document.body.style.top,
      width: document.body.style.width,
    };
    const previousHtmlOverflow = document.documentElement.style.overflow;
    const previousHtmlScrollBehavior = document.documentElement.style.scrollBehavior;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setLightboxIndex(null);
      if (event.key === 'ArrowLeft') {
        setLightboxIndex(current => current === null ? current : (current + LIGHTBOX_IMAGES.length - 1) % LIGHTBOX_IMAGES.length);
      }
      if (event.key === 'ArrowRight') {
        setLightboxIndex(current => current === null ? current : (current + 1) % LIGHTBOX_IMAGES.length);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    document.documentElement.style.scrollBehavior = 'auto';
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
    document.body.style.position = 'fixed';
    document.body.style.top = `-${scrollY}px`;
    document.body.style.width = '100%';

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.documentElement.style.overflow = previousHtmlOverflow;
      document.body.style.overflow = previousBodyStyles.overflow;
      document.body.style.position = previousBodyStyles.position;
      document.body.style.top = previousBodyStyles.top;
      document.body.style.width = previousBodyStyles.width;
      window.scrollTo(0, scrollY);
      requestAnimationFrame(() => {
        window.scrollTo(0, scrollY);
        document.documentElement.style.scrollBehavior = previousHtmlScrollBehavior;
      });
    };
  }, [isLightboxOpen]);

  useEffect(() => {
    const root = document.documentElement;
    const revealElements = Array.from(document.querySelectorAll<HTMLElement>('.reveal'));

    root.classList.add('js-reveal');

    if (!('IntersectionObserver' in window)) {
      revealElements.forEach(el => el.classList.add('visible'));
      return () => root.classList.remove('js-reveal');
    }

    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });

    revealElements.forEach(el => observer.observe(el));

    let lastScrollY = window.scrollY;

    const updateNavBackground = () => {
      const nav = document.getElementById('main-nav');
      if (!nav) return;

      const currentScrollY = window.scrollY;
      const isMobile = window.matchMedia('(max-width: 900px)').matches;

      nav.style.background = currentScrollY > 100 ? 'rgba(14,12,9,0.95)' : '';

      const scrollDelta = currentScrollY - lastScrollY;

      if (!isMobile || currentScrollY <= 120 || scrollDelta < -4) {
        nav.classList.remove('mobile-nav-hidden');
      } else if (scrollDelta > 4) {
        nav.classList.add('mobile-nav-hidden');
      }

      lastScrollY = Math.max(currentScrollY, 0);
    };

    updateNavBackground();
    window.addEventListener('scroll', updateNavBackground, { passive: true });

    return () => {
      observer.disconnect();
      window.removeEventListener('scroll', updateNavBackground);
      root.classList.remove('js-reveal');
    };
  }, []);

  const openSecureCheckout = async (privateUrl: string) => {
    const link = new URL(privateUrl, window.location.origin);
    const response = await fetch('/api/checkout', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ reference: link.searchParams.get('reference') || '', token: link.searchParams.get('token') || '' }),
    });
    const checkout = await response.json().catch(() => null);
    if (!response.ok || !checkout?.url) throw new Error('Secure checkout could not be opened. Use the private payment link below to retry without submitting another booking. Your place is not confirmed until payment is verified.');
    const destination = new URL(checkout.url);
    if (destination.origin !== 'https://checkout.stripe.com' || destination.username || destination.password) throw new Error('Secure checkout is unavailable. Please use the private payment link below.');
    window.location.assign(destination.href);
  };

  const scheduleDraftSave = (form: HTMLFormElement) => {
    if (draftTimerRef.current) window.clearTimeout(draftTimerRef.current);
    draftTimerRef.current = window.setTimeout(async () => {
      const data = new FormData(form);
      const payload = {
        first_name: data.get('first_name'), last_name: data.get('last_name'), email: data.get('email'), phone: data.get('phone'),
        date_of_birth: data.get('date_of_birth'), date_of_birth_day: data.get('date_of_birth_day'), date_of_birth_month: data.get('date_of_birth_month'), date_of_birth_year: data.get('date_of_birth_year'),
        tour_date: data.get('tour_date'), guest_count: data.get('guest_count'), notes: data.get('notes'),
        travellers: Array.from({ length: Math.max(0, guestCount - 1) }, (_, index) => ({
          first_name: data.get(`travellers.${index + 1}.first_name`), last_name: data.get(`travellers.${index + 1}.last_name`), date_of_birth: data.get(`travellers.${index + 1}.date_of_birth`),
          date_of_birth_day: data.get(`travellers.${index + 1}.date_of_birth_day`), date_of_birth_month: data.get(`travellers.${index + 1}.date_of_birth_month`), date_of_birth_year: data.get(`travellers.${index + 1}.date_of_birth_year`),
        })), ...draftOwnershipRef.current,
      };
      try {
        const response = await fetch('/api/checkout-draft', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), keepalive: true });
        const saved = await response.json();
        if (response.ok && saved?.draft_id && saved?.credential) {
          draftOwnershipRef.current = { draft_id: saved.draft_id, credential: saved.credential };
          sessionStorage.setItem('8l_checkout_draft', JSON.stringify(draftOwnershipRef.current));
        }
      } catch { /* A later edit or submit retries; a draft failure never pretends a booking exists. */ }
    }, 700);
  };

  const clearFieldValidation = (target: EventTarget | null) => {
    if (!(target instanceof HTMLElement)) return;
    target.removeAttribute('aria-invalid');
    const id = target.id;
    if (id) {
      document.getElementById(`${id}-inline-error`)?.remove();
      setValidationErrors(current => current.filter(error => error.id !== id));
    }
  };

  const validateBookingForm = (form: HTMLFormElement) => {
    const invalid: Array<{ element: HTMLElement; message: string }> = [];
    const labelFor = (element: HTMLElement) => element.id ? form.querySelector(`label[for="${CSS.escape(element.id)}"]`)?.textContent?.trim() : '';
    form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input[required], select[required], textarea[required]').forEach(element => {
      if (!element.disabled && !element.validity.valid) {
        const label = labelFor(element) || (element.type === 'checkbox' ? 'the required confirmation' : 'this field');
        const message = element.id === 'tour_date'
          ? 'Choose a tour date before continuing.'
          : element.type === 'checkbox'
            ? `Confirm ${label.replace(/^I /, '').replace(/\.$/, '')}.`
            : `Enter ${label.replace(/\s*\(Optional\)/i, '')}.`;
        invalid.push({ element, message });
      }
    });
    form.querySelectorAll<HTMLInputElement>('input[data-date-of-birth-canonical="true"]').forEach(element => {
      if (!element.value) {
        const firstPart = form.querySelector<HTMLInputElement>(`#${CSS.escape(element.name)}-day`);
        if (firstPart) invalid.push({ element: firstPart, message: `${element.name.startsWith('travellers.') ? `Traveller ${element.name.split('.')[1]} ` : ''}date of birth needs a real day, month and year.` });
      }
    });
    form.querySelectorAll<HTMLElement>('.form-inline-validation-error').forEach(error => error.remove());
    form.querySelectorAll<HTMLElement>('[aria-invalid="true"]').forEach(element => element.removeAttribute('aria-invalid'));
    const summary = invalid.map(({ element, message }, index) => {
      const id = element.id || `booking-invalid-${index}`;
      element.id ||= id;
      element.setAttribute('aria-invalid', 'true');
      const inline = document.createElement('p'); inline.className = 'field-error form-inline-validation-error'; inline.id = `${id}-inline-error`; inline.textContent = message; inline.setAttribute('role', 'alert');
      element.setAttribute('aria-describedby', `${element.getAttribute('aria-describedby') || ''} ${inline.id}`.trim());
      (element.closest('.form-group, .date-of-birth-group') || element.parentElement)?.append(inline);
      return { id, message };
    });
    setValidationErrors(summary);
    if (invalid.length) {
      const first = invalid[0].element;
      window.setTimeout(() => first.focus({ preventScroll: true }), 0);
      first.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
      return false;
    }
    return true;
  };

  const submitBooking = async (form: HTMLFormElement) => {
    if (formSubmitted || formSubmittingRef.current || !validateBookingForm(form)) return;
    formSubmittingRef.current = true;
    submissionKeyRef.current ||= crypto.randomUUID();
    setFormError('');
    setFormSubmitting(true);
    try {
      const formData = new FormData(form);
      const travellerManifest = [
        {
          first_name: formData.get('first_name'),
          last_name: formData.get('last_name'),
          email: formData.get('email'),
          phone: formData.get('phone'),
          nationality: formData.get('nationality'),
          gender: formData.get('gender'),
          date_of_birth: formData.get('date_of_birth'),
          riding_experience: formData.get('riding_experience'),
          dietary_notes: formData.get('dietary_restrictions'),
        },
        ...Array.from({ length: guestCount - 1 }, (_, index) => ({
          first_name: formData.get(`travellers.${index + 1}.first_name`),
          last_name: formData.get(`travellers.${index + 1}.last_name`),
          email: formData.get(`travellers.${index + 1}.email`),
          phone: formData.get(`travellers.${index + 1}.phone`),
          nationality: formData.get(`travellers.${index + 1}.nationality`),
          gender: formData.get(`travellers.${index + 1}.gender`),
          date_of_birth: formData.get(`travellers.${index + 1}.date_of_birth`),
          riding_experience: formData.get(`travellers.${index + 1}.riding_experience`),
          dietary_notes: formData.get(`travellers.${index + 1}.dietary_notes`),
        })),
      ];
      const manifestResult = normalizeBookingTravellers(guestCount, travellerManifest);
      if (!manifestResult.ok) throw new Error(manifestResult.error);
      const bookingPayload = {
        ...Object.fromEntries(formData.entries()),
        submission_key: submissionKeyRef.current,
        travellers: travellerManifest,
        attribution: await collectAttributionWithGaRetry(),
      };
      const response = await fetch('/api/bookings', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(bookingPayload),
      });
      const payload = await response.json().catch(() => null) as { ok?: boolean; reference?: string; error?: string; paymentUrl?: string | null } | null;

      if (!response.ok || !payload?.ok || !payload.reference) {
        throw new Error(payload?.error || 'The booking could not be saved. Please try again or email info@8lakestours.com.');
      }

      setBookingReference(payload.reference);
      setPaymentUrl(payload.paymentUrl || '');
      stripeClickTrackedRef.current = false;
      trackFunnelEvent('booking_form_submit', {
        tour_date: String(formData.get('tour_date') || 'TBC'),
        guest_count: groupPricing.guestCount,
        price_per_person_usd: groupPricing.perPersonUsd,
        riding_experience: String(formData.get('riding_experience') || 'Not provided'),
        reference: payload.reference,
      });
      setFormSubmitted(true);
      if (payload.paymentUrl) await openSecureCheckout(payload.paymentUrl);

    } catch (error) {
      trackFunnelEvent('booking_form_error', { status: 'client' });
      setFormError(error instanceof Error ? error.message : 'The booking could not be saved. Please try again or email info@8lakestours.com.');
    } finally {
      formSubmittingRef.current = false;
      setFormSubmitting(false);
    }
  };

  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebSite',
        name: '8 Lakes Tours',
        url: 'https://www.8lakestours.com',
        inLanguage: 'en',
        publisher: { '@type': 'Organization', name: '8 Lakes Tours' },
      },
      {
        '@type': 'TouristTrip',
        '@id': 'https://www.8lakestours.com/#trip',
        name: '8 Lakes Tours — 9-Day Mongolian Horse Trekking Expedition',
        description: '9-day immersive Mongolian horse trekking expedition through the Naiman Nuur (Eight Lakes) region and Orkhon Valley, Mongolia, hosted by the Sandagdorj nomadic family.',
        url: 'https://www.8lakestours.com',
        mainEntityOfPage: 'https://www.8lakestours.com',
        inLanguage: 'en',
        image: ['https://www.8lakestours.com/images/hero-sunset-valley.jpg', 'https://www.8lakestours.com/images/hero-horseback.jpg', 'https://www.8lakestours.com/images/rob-family.jpg'],
        touristType: 'Adventure travellers seeking authentic nomadic experiences',
        itinerary: {
          '@type': 'ItemList',
          numberOfItems: 9,
        },
        offers: {
          '@type': 'AggregateOffer',
          lowPrice: '1799',
          highPrice: '1999',
          offerCount: '4',
          priceCurrency: 'USD',
          availability: 'https://schema.org/LimitedAvailability',
          validFrom: '2026-01-01',
          validThrough: '2027-09-30',
        },
        provider: {
          '@type': 'Organization',
          name: '8 Lakes Tours',
          url: 'https://www.8lakestours.com',
          email: 'info@8lakestours.com',
          sameAs: ['https://www.instagram.com/8lakestours', 'https://www.instagram.com/robzaher108'],
          founder: { '@type': 'Person', name: 'Robert Zaher', sameAs: 'https://www.instagram.com/robzaher108' },
        },
        location: {
          '@type': 'Place',
          name: 'Orkhon Valley & Naiman Nuur, Mongolia',
          geo: { '@type': 'GeoCoordinates', latitude: 46.8, longitude: 102.2 },
        },
        areaServed: {
          '@type': 'Country',
          name: 'Mongolia',
        },
        review: [
          {
            '@type': 'Review',
            author: { '@type': 'Person', name: 'Irik Clawson' },
            reviewBody: 'Endless riding from one plain to the next, across the Steppe, by the lakes…. Magical. What more is there in life?',
          },
          {
            '@type': 'Review',
            author: { '@type': 'Person', name: 'Fin Bennet' },
            reviewBody: 'It couldn’t be further from back home and that makes me so excited.',
          },
        ],
      },
      {
        '@type': 'ItemList',
        '@id': 'https://www.8lakestours.com/#departure-options',
        name: '8 Lakes Tours departure dates and 2027 request options',
        itemListElement: tourDates.map((tourDate, index) => ({
          '@type': 'ListItem',
          position: index + 1,
          name: tourDate.date,
          description: `${tourDate.detail} · ${tourDate.status}`,
        })),
      },
      {
        '@type': 'FAQPage',
        mainEntity: HOME_FAQS.map(({ q, a }) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })),
      },
    ],
  };

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <style>{`
        :root {
          --ink: #1a1510;
          --cream: #f5f0e8;
          --gold: #c8a96e;
          --rust: #a85c38;
          --sage: #7a8c6e;
          --mist: #d4cfc4;
          --dark: #0e0c09;
          --radius-soft: 10px;
          --radius-card: 12px;
          --radius-payment: 14px;
          --radius-photo: 4px;
        }

        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        html { scroll-behavior: smooth; overflow-x: clip; max-width: 100%; overscroll-behavior-x: none; }
        body {
          background: var(--dark);
          color: var(--cream);
          font-family: var(--font-jost), 'Jost', sans-serif;
          font-weight: 300;
          overflow-x: clip;
          max-width: 100%;
          overscroll-behavior-x: none;
        }

        @supports not (overflow: clip) {
          html, body { overflow-x: hidden; }
        }

        #main-nav {
          position: fixed; top: 0; left: 0; right: 0; z-index: 100;
          padding: 1.5rem 3rem;
          display: flex; justify-content: space-between; align-items: center;
          background: linear-gradient(to bottom, rgba(14,12,9,0.85) 0%, transparent 100%);
          transition: background 0.3s ease, transform 0.3s ease;
        }
        .nav-logo {
          font-family: var(--font-cormorant), 'Cormorant Garamond', serif;
          font-size: 1.3rem; font-weight: 300; letter-spacing: 0.15em;
          color: var(--cream); text-decoration: none; text-transform: uppercase;
        }
        .nav-links { display: flex; align-items: center; gap: 0.9rem; }
        .nav-social {
          font-size: 0.68rem; letter-spacing: 0.18em; text-transform: uppercase;
          color: rgba(245,240,232,0.78); text-decoration: none; transition: color 0.3s ease;
        }
        .nav-social:hover { color: var(--gold); }
        .nav-cta {
          font-size: 0.75rem; letter-spacing: 0.2em; text-transform: uppercase;
          color: var(--cream); text-decoration: none;
          border: 1px solid rgba(245,240,232,0.4); border-radius: var(--radius-soft); padding: 0.6rem 1.4rem;
          transition: all 0.3s ease; white-space: nowrap;
        }
        .nav-cta:hover { background: var(--gold); border-color: var(--gold); color: var(--dark); }

        .hero {
          position: relative; height: 100vh; min-height: 700px;
          display: flex; align-items: flex-end; overflow: hidden;
        }
        .hero-bg {
          position: absolute; inset: 0;
          transform-origin: 54% 58%;
          animation: droneDrift 18s ease-in-out infinite alternate;
          will-change: transform;
        }
        .hero-bg img, .hero-video { object-fit: cover; object-position: center 45%; }
        .hero-video { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; transition: opacity 1.8s ease; }
        .hero-video.is-playing { opacity: 1; }
        @keyframes droneDrift {
          from { transform: scale(1.08) translate3d(-1.2%, 1.4%, 0); }
          to { transform: scale(1.14) translate3d(1.4%, -1.1%, 0); }
        }
        .hero-overlay {
          position: absolute; inset: 0;
          background:
            radial-gradient(circle at 47% 38%, rgba(255,190,112,0.18), transparent 25%),
            linear-gradient(to top, rgba(14,12,9,0.88) 0%, rgba(14,12,9,0.34) 44%, rgba(14,12,9,0.08) 100%),
            radial-gradient(circle at 50% 50%, transparent 48%, rgba(0,0,0,0.34) 100%);
        }
        .hero::after {
          content: '';
          position: absolute;
          inset: 0;
          pointer-events: none;
          z-index: 1;
          background:
            radial-gradient(circle at 47% 36%, rgba(255,215,148,0.12), transparent 20%),
            linear-gradient(115deg, transparent 0%, rgba(255,255,255,0.035) 38%, transparent 58%);
          mix-blend-mode: screen;
          opacity: 0.58;
        }
        .hero-content {
          position: relative; z-index: 2;
          padding: 0 6rem 6.5rem; max-width: 920px;
          animation: heroFade 1.5s ease-out 0.3s both;
        }
        @keyframes heroFade {
          from { opacity: 0; transform: translateY(30px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .hero-eyebrow {
          font-size: 0.7rem; letter-spacing: 0.35em; text-transform: uppercase;
          color: #fff; margin-bottom: 1.2rem; font-weight: 400; text-shadow: 0 1px 6px rgba(0,0,0,0.7), 0 2px 16px rgba(0,0,0,0.5);
        }
        .hero-title {
          font-family: var(--font-cormorant), 'Cormorant Garamond', serif;
          font-size: clamp(3.2rem, 6.2vw, 5.85rem);
          font-weight: 300; line-height: 1.05; color: var(--cream); margin-bottom: 1.5rem;
        }
        .hero-title em { font-style: italic; color: var(--gold); }
        .hero-sub { font-size: 1.05rem; line-height: 1.7; color: var(--mist); max-width: 680px; margin-bottom: 1.5rem; }
        .hero-sub .mobile-line { display: none; }
        .hero-sub .desktop-line { display: inline; }
        .hero-actions { display: flex; gap: 1rem; align-items: center; }
        .btn-primary {
          display: inline-block; background: var(--gold); color: var(--dark);
          font-size: 0.75rem; letter-spacing: 0.2em; text-transform: uppercase;
          padding: 1rem 2.2rem; text-decoration: none; font-weight: 500; border-radius: var(--radius-soft);
          transition: all 0.3s ease;
        }
        .btn-primary:hover { background: var(--rust); color: var(--cream); }
        .btn-ghost {
          display: inline-block; color: var(--cream);
          font-size: 0.75rem; letter-spacing: 0.2em; text-transform: uppercase;
          text-decoration: none; border-bottom: 1px solid rgba(245,240,232,0.3);
          padding-bottom: 2px; transition: border-color 0.3s ease;
        }
        .btn-ghost:hover { border-color: var(--gold); color: var(--gold); }

        .stats-bar {
          background: var(--ink);
          border-top: 1px solid rgba(200,169,110,0.2);
          border-bottom: 1px solid rgba(200,169,110,0.2);
          display: grid; grid-template-columns: repeat(4, 1fr); padding: 2rem 6rem;
        }
        .stat { text-align: center; padding: 1rem; border-right: 1px solid rgba(245,240,232,0.08); }
        .stat:last-child { border-right: none; }
        .stat-num {
          font-family: var(--font-cormorant), 'Cormorant Garamond', serif;
          font-size: 2.4rem; font-weight: 300; color: var(--gold);
          display: block; margin-bottom: 0.3rem;
        }
        .stat-label { font-size: 0.65rem; letter-spacing: 0.25em; text-transform: uppercase; color: var(--mist); opacity: 0.7; }

        section { padding: 8rem 6rem; }
        .section-eyebrow { font-size: 0.65rem; letter-spacing: 0.35em; text-transform: uppercase; color: var(--gold); margin-bottom: 1rem; display: block; }
        .section-title { font-family: var(--font-cormorant), 'Cormorant Garamond', serif; font-size: clamp(2.2rem, 4vw, 3.5rem); font-weight: 300; line-height: 1.15; color: var(--cream); margin-bottom: 1.5rem; }
        .section-title em { font-style: italic; color: var(--gold); }
        .section-body { font-size: 1rem; line-height: 1.8; color: var(--mist); max-width: 560px; }
        .faq-item { border-top: 1px solid rgba(200,169,110,0.15); }
        .faq-see-all { display: inline-block; margin-top: 1.6rem; color: var(--gold); font-size: 0.7rem; letter-spacing: 0.18em; text-transform: uppercase; text-decoration: none; border-bottom: 1px solid rgba(200,169,110,0.45); padding-bottom: 0.2rem; }
        .faq-see-all:hover { color: var(--cream); border-color: var(--cream); }
        .faq-question { width: 100%; cursor: pointer; appearance: none; border: 0; background: transparent; display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 1.3rem 0; text-align: left; font-family: var(--font-cormorant), 'Cormorant Garamond', serif; font-size: 1.15rem; font-weight: 400; color: var(--cream); }
        .faq-question:focus-visible { outline: 1px solid rgba(200,169,110,0.75); outline-offset: 4px; }
        .faq-toggle { position: relative; width: 1rem; height: 1rem; flex: 0 0 auto; color: var(--gold); }
        .faq-toggle::before,
        .faq-toggle::after { content: ''; position: absolute; top: 50%; left: 50%; width: 0.85rem; height: 1px; background: currentColor; transform: translate(-50%, -50%); transition: transform 0.25s ease, opacity 0.25s ease; }
        .faq-toggle::after { transform: translate(-50%, -50%) rotate(90deg); }
        .faq-item.is-open .faq-toggle::after { transform: translate(-50%, -50%) rotate(0deg); opacity: 0; }
        .faq-panel { display: grid; grid-template-rows: 0fr; transition: grid-template-rows 0.34s ease; }
        .faq-item.is-open .faq-panel { grid-template-rows: 1fr; }
        .faq-panel-inner { overflow: hidden; }
        .faq-answer { padding: 0 0 1.35rem; font-size: 0.875rem; color: var(--mist); line-height: 1.75; opacity: 0.8; }
        .faq-practical-link { margin: 1.8rem 0 0; padding: 1.15rem; border: 1px solid rgba(200,169,110,0.2); border-radius: var(--radius-card); background: rgba(245,240,232,0.04); }
        .faq-practical-link span { display: block; color: var(--cream); font-family: var(--font-cormorant), 'Cormorant Garamond', serif; font-size: 1.15rem; margin-bottom: 0.35rem; }
        .faq-practical-link p { color: var(--mist); font-size: 0.875rem; line-height: 1.65; opacity: 0.82; margin-bottom: 0.9rem; }
        .faq-practical-link a { color: var(--gold); text-transform: uppercase; letter-spacing: 0.14em; font-size: 0.68rem; font-weight: 800; text-decoration: none; }
        .faq-practical-link a:hover { color: var(--cream); }

        .offer-strip { background: var(--ink); border-top: 1px solid rgba(200,169,110,0.22); border-bottom: 1px solid rgba(200,169,110,0.22); padding: 1.3rem 6rem; display: grid; grid-template-columns: minmax(0,1.1fr) minmax(0,1.5fr) auto; gap: 1.5rem; align-items: center; }
        .offer-strip-kicker { font-size: 0.6rem; letter-spacing: 0.26em; text-transform: uppercase; color: var(--gold); margin-bottom: 0.35rem; }
        .offer-strip-title { font-family: var(--font-cormorant), 'Cormorant Garamond', serif; font-size: 1.65rem; font-weight: 300; color: var(--cream); line-height: 1.12; }
        .offer-strip-note { margin-top: 0.45rem; max-width: 36rem; color: rgba(212,207,196,0.72); font-size: 0.72rem; line-height: 1.5; }
        .offer-strip-facts { display: grid; grid-template-columns: repeat(4, minmax(0,1fr)); gap: 0.6rem; }
        .offer-fact { border-left: 1px solid rgba(200,169,110,0.28); padding-left: 0.85rem; min-width: 0; }
        .offer-fact strong { display: block; color: var(--cream); font-size: 0.92rem; line-height: 1.25; overflow-wrap: anywhere; }
        .offer-fact span { display: block; margin-top: 0.2rem; color: rgba(212,207,196,0.68); font-size: 0.58rem; line-height: 1.45; letter-spacing: 0.16em; text-transform: uppercase; }
        .offer-fact-note { display: block; margin-top: 0.15rem; color: var(--gold); font-size: 0.62rem; font-style: italic; letter-spacing: 0.04em; opacity: 0.85; }
        .offer-strip-cta { display: inline-flex; justify-content: center; align-items: center; white-space: nowrap; background: var(--gold); border: 1px solid var(--gold); border-radius: var(--radius-soft); color: var(--dark); text-decoration: none; font-size: 0.7rem; letter-spacing: 0.18em; text-transform: uppercase; font-weight: 700; padding: 0.9rem 1.2rem; transition: background 0.3s ease, border-color 0.3s ease, transform 0.3s ease; }
        .offer-strip-cta:hover { background: var(--cream); border-color: var(--cream); transform: translateY(-1px); }

        .intro { background: var(--dark); display: grid; grid-template-columns: 1fr 1fr; gap: 6rem; align-items: center; }
        .intro-img { position: relative; aspect-ratio: 3/4; overflow: hidden; border-radius: var(--radius-photo); }
        .intro-img img { width: 100%; height: 100%; object-fit: cover; transition: transform 0.8s ease; }
        .intro-img.portrait-full { background: #0f0f0d; border: 1px solid rgba(200,169,110,0.14); }
        .intro-img.portrait-full img { object-fit: contain; }
        .intro-img:hover img { transform: scale(1.03); }
        .intro-img.portrait-full:hover img { transform: none; }
        .intro-img-accent { position: absolute; bottom: -1.5rem; right: -1.5rem; width: 55%; aspect-ratio: 1; overflow: hidden; border: 4px solid var(--dark); border-radius: var(--radius-photo); }
        .intro-img-accent img { width: 100%; height: 100%; object-fit: cover; }
        .intro-points { margin-top: 2.5rem; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1.6rem 2rem; }
        .intro-point-value { font-family: var(--font-cormorant), 'Cormorant Garamond', serif; font-size: 1.8rem; color: var(--gold); line-height: 1; }
        .intro-point-label { font-size: 0.7rem; letter-spacing: 0.2em; text-transform: uppercase; color: var(--mist); opacity: 0.6; margin-top: 0.4rem; line-height: 1.4; }

        .photo-strip { padding: 0; display: flex; gap: 0; overflow: hidden; height: 50vh; min-height: 350px; }
        .strip-item { flex: 1; overflow: hidden; position: relative; transition: flex 0.6s cubic-bezier(0.4,0,0.2,1); cursor: pointer; }
        .strip-item:hover { flex: 2.5; }
        .strip-item img { width: 100%; height: 100%; object-fit: cover; transition: transform 0.6s ease; }
        .strip-item:hover img { transform: scale(1.04); }
        .partnership { background: var(--ink); display: grid; grid-template-columns: 1fr 1fr; gap: 0; }
        .partnership-text { padding: 6rem; display: flex; flex-direction: column; justify-content: center; }
        .partnership-inline-photo { display: none !important; position: relative; width: 100%; height: auto; aspect-ratio: 1.46; margin: 2rem 0; overflow: hidden; border: 1px solid rgba(200,169,110,0.22); border-radius: var(--radius-photo); }
        .partnership-inline-photo img { object-fit: cover; filter: saturate(0.88) contrast(1.04) brightness(0.9); }
        .partnership-quote { font-family: var(--font-cormorant), 'Cormorant Garamond', serif; font-size: 1.6rem; font-style: italic; font-weight: 300; color: var(--cream); line-height: 1.6; border-left: 2px solid var(--gold); padding-left: 2rem; margin: 2.5rem 0; }
        .partnership-img { position: relative; overflow: hidden; min-height: 600px; border-left: 1px solid rgba(200,169,110,0.18); background: #0f0f0d; }
        .partnership-img::before { content: ''; position: absolute; inset: 0; z-index: 1; pointer-events: none; background: linear-gradient(90deg, rgba(18,15,11,0.38), rgba(18,15,11,0.06) 42%, rgba(18,15,11,0.18)), linear-gradient(180deg, rgba(200,169,110,0.10), transparent 38%, rgba(14,12,9,0.30)); mix-blend-mode: multiply; }
        .partnership-img img { width: 100%; height: 100%; object-fit: cover; object-position: 52% center; filter: saturate(0.84) contrast(1.08) brightness(0.88); }

        .trust { background: var(--dark); padding: 5rem 5rem 6rem; }
        .trust-header { max-width: 760px; margin: 0 auto 3rem; text-align: center; }
        .trust-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; max-width: 1120px; margin: 0 auto; }
        .trust-card { border: 1px solid rgba(200,169,110,0.2); border-radius: var(--radius-card); background: rgba(200,169,110,0.045); padding: 1.6rem; min-height: 210px; display: flex; flex-direction: column; justify-content: space-between; }
        .trust-quote { font-family: var(--font-cormorant), 'Cormorant Garamond', serif; font-size: 1.25rem; color: var(--cream); line-height: 1.55; font-style: italic; }
        .trust-source { font-size: 0.62rem; letter-spacing: 0.22em; text-transform: uppercase; color: var(--gold); margin-top: 1.4rem; }
        .testimonial-grid { max-width: 1120px; margin: 0 auto; display: grid; grid-template-columns: repeat(3, 1fr); gap: 1.2rem; }
        .testimonial-card { background: rgba(245,240,232,0.04); border: 1px solid rgba(200,169,110,0.18); border-radius: var(--radius-card); overflow: hidden; }
        .testimonial-photo { position: relative; height: 360px; overflow: hidden; display: block; width: 100%; }
        .testimonial-photo img { object-fit: cover; }
        .testimonial-body { padding: 1.6rem; }
        .testimonial-quote { font-family: var(--font-cormorant), 'Cormorant Garamond', serif; font-size: 1.45rem; line-height: 1.45; color: var(--cream); font-style: italic; }
        .testimonial-name { margin-top: 1.2rem; font-size: 0.68rem; letter-spacing: 0.22em; text-transform: uppercase; color: var(--gold); }
        .contact-section { background: var(--dark); padding: 5.5rem 6rem; }
        .contact-layout { max-width: 1080px; margin: 0 auto; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 3.5rem; align-items: center; }
        .contact-intro .section-body { margin: 1rem 0 1.6rem; }
        .contact-cards { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 0.75rem; }
        .contact-card { display: flex; align-items: center; gap: 0.8rem; min-width: 0; padding: 0.9rem 1rem; background: rgba(200,169,110,0.06); border: 1px solid rgba(200,169,110,0.25); border-radius: var(--radius-soft); color: inherit; text-decoration: none; transition: border-color 0.3s ease; }
        .contact-card:hover { border-color: var(--gold); }
        .contact-card-icon { display: inline-flex; flex-shrink: 0; color: var(--cream); font-size: 1.1rem; }
        .contact-card-icon .instagram-glyph { width: 1.15rem; height: 1.15rem; }
        .contact-card-text { display: grid; gap: 0.2rem; min-width: 0; }
        .contact-card-label { font-size: 0.58rem; letter-spacing: 0.22em; text-transform: uppercase; color: var(--gold); }
        .contact-card-value { font-size: 0.85rem; color: var(--cream); overflow-wrap: anywhere; }

        .itinerary { background: var(--dark); padding-bottom: 4rem; }
        .itinerary-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.75rem; margin-top: 4rem; }
        .itin-card { background: var(--ink); border-radius: var(--radius-card); padding: 3rem; position: relative; overflow: hidden; transition: background 0.3s ease; }
        .itin-card::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px; background: var(--gold); transform: scaleX(0); transform-origin: left; transition: transform 0.4s ease; }
        .itin-card:hover::before { transform: scaleX(1); }
        .itin-card:hover { background: #1e1b15; }
        .itin-days { font-family: var(--font-cormorant), 'Cormorant Garamond', serif; font-size: 3.4rem; font-weight: 300; color: rgba(200,169,110,0.24); position: absolute; top: 1.5rem; right: 1.5rem; line-height: 1; }
        .itin-tag { font-size: 0.72rem; letter-spacing: 0.26em; text-transform: uppercase; color: var(--gold); margin-bottom: 1rem; display: block; }
        .itin-title { font-family: var(--font-cormorant), 'Cormorant Garamond', serif; font-size: 1.85rem; font-weight: 300; color: var(--cream); margin-bottom: 1.1rem; line-height: 1.15; }
        .itin-desc { font-size: 1rem; line-height: 1.8; color: rgba(245,240,232,0.78); opacity: 1; }
        .itin-list { list-style: none; margin-top: 1.2rem; }
        .itin-list li { font-size: 0.95rem; line-height: 1.65; color: rgba(245,240,232,0.72); padding: 0.45rem 0; padding-left: 1.15rem; position: relative; opacity: 1; }
        .itin-list li::before { content: '—'; position: absolute; left: 0; color: var(--gold); }

        .mosaic { padding: 0; display: grid; grid-template-columns: 2fr 1fr 1fr; grid-template-rows: 350px 350px 350px; gap: 3px; }
        .mosaic-item { overflow: hidden; position: relative; border-radius: var(--radius-photo); }
        .mosaic-item img { width: 100%; height: 100%; object-fit: cover; transition: transform 0.6s ease; }
        .mosaic-item.portrait-full { background: #0f0f0d; }
        .mosaic-item.portrait-full img { object-fit: contain; }
        .mosaic-item:hover img { transform: scale(1.04); }
        .mosaic-item.portrait-full:hover img { transform: none; }
        .mosaic-item.tall { grid-row: span 2; }
        .main-album { padding: 3px; display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); grid-auto-rows: clamp(82px, 7vw, 116px); gap: 3px; background: #0f0f0d; }
        .main-album-item { position: relative; overflow: hidden; background: var(--ink); border-radius: var(--radius-photo); min-height: 0; }
        .main-album-item.collage-lead { grid-column: 1 / 4; grid-row: 1 / 7; }
        .main-album-item.collage-hero { grid-column: 4 / 9; grid-row: 1 / 4; }
        .main-album-item.collage-tall { grid-column: 9 / 11; grid-row: 1 / 5; }
        .main-album-item.collage-wide-left { grid-column: 4 / 7; grid-row: 4 / 7; }
        .main-album-item.collage-wide-right { grid-column: 7 / 9; grid-row: 4 / 7; }
        .main-album-item.collage-small-a { grid-column: 11 / 13; grid-row: 1 / 3; }
        .main-album-item.collage-small-b { grid-column: 11 / 13; grid-row: 3 / 5; }
        .main-album-item.collage-bottom-left { grid-column: 1 / 5; grid-row: 7 / 10; }
        .main-album-item.collage-bottom-mid { grid-column: 5 / 9; grid-row: 7 / 10; }
        .main-album-item.collage-bottom-right { grid-column: 9 / 13; grid-row: 5 / 10; }
        .main-album-item img { width: 100%; height: 100%; object-fit: cover; transition: transform 0.6s ease; }
        .main-album-item:hover img { transform: scale(1.04); }
        .image-button { all: unset; display: block; width: 100%; height: 100%; position: relative; cursor: zoom-in; }
        .image-button.testimonial-photo { height: 360px; }
        .image-button.partnership-inline-photo { height: auto; aspect-ratio: 1.46; }
        .image-button:focus-visible { outline: 2px solid var(--gold); outline-offset: -2px; }
        .lightbox { position: fixed; inset: 0; z-index: 1000; background: rgba(14,12,9,0.96); display: flex; align-items: center; justify-content: center; padding: 1.5rem; cursor: zoom-out; overscroll-behavior: contain; touch-action: none; }
        .lightbox-frame { position: relative; width: min(96vw, 1800px); height: min(86vh, 1100px); display: flex; align-items: center; justify-content: center; }
        .lightbox-frame img { width: 100%; height: 100%; object-fit: contain; }
        .lightbox-close { position: fixed; top: calc(1rem + env(safe-area-inset-top)); right: calc(1rem + env(safe-area-inset-right)); z-index: 1001; width: 3rem; height: 3rem; border-radius: 999px; border: 1px solid rgba(245,240,232,0.35); background: rgba(14,12,9,0.82); color: var(--cream); cursor: pointer; font-size: 1.35rem; line-height: 1; display: flex; align-items: center; justify-content: center; box-shadow: 0 12px 28px rgba(0,0,0,0.32); }
        .lightbox-nav { position: fixed; top: 50%; transform: translateY(-50%); z-index: 1001; width: 3rem; height: 3rem; border-radius: 999px; border: 1px solid rgba(245,240,232,0.35); background: rgba(14,12,9,0.68); color: var(--cream); cursor: pointer; font-size: 1.8rem; line-height: 1; display: flex; align-items: center; justify-content: center; }
        .lightbox-nav:hover { background: var(--gold); color: var(--dark); border-color: var(--gold); }
        .lightbox-prev { left: 1rem; }
        .lightbox-next { right: 1rem; }
        .trust-conversion { background: var(--ink); display: grid; grid-template-columns: minmax(260px, 0.8fr) 1.2fr; gap: 4rem; align-items: center; }
        .rob-photo { position: relative; aspect-ratio: 1; border: 1px solid rgba(200,169,110,0.24); border-radius: var(--radius-photo); background: rgba(200,169,110,0.06); overflow: hidden; }
        .rob-photo img { object-fit: cover; object-position: 50% 44%; }
        .trust-card-founder h3 { font-family: var(--font-cormorant), 'Cormorant Garamond', serif; font-size: 1.55rem; font-weight: 300; color: var(--cream); margin-bottom: 0.8rem; }
        .trust-card-founder p { font-size: 0.9rem; line-height: 1.75; color: rgba(212,207,196,0.82); }
        .trust-actions { display: flex; flex-wrap: wrap; gap: 0.8rem; margin-top: 1.6rem; }
        .trust-link { display: inline-flex; padding: 0.8rem 1rem; border: 1px solid rgba(200,169,110,0.35); border-radius: var(--radius-soft); color: var(--gold); text-decoration: none; font-size: 0.68rem; letter-spacing: 0.16em; text-transform: uppercase; }
        .trust-link:hover { background: var(--gold); color: var(--dark); }

        .included { background: var(--ink); display: grid; grid-template-columns: 1fr 1fr; gap: 6rem; align-items: start; padding-top: 6rem; }
        .included-list { list-style: none; display: grid; gap: 0.45rem; }
        .included-list li { position: relative; overflow: hidden; padding: 1rem 1rem 1rem 0.9rem; border: 1px solid rgba(245,240,232,0.065); border-left-color: rgba(200,169,110,0.26); border-radius: var(--radius-soft); font-size: 0.9rem; color: var(--mist); display: flex; align-items: center; gap: 1rem; background: rgba(245,240,232,0.018); transition: color 0.25s ease, border-color 0.25s ease, background 0.25s ease, transform 0.25s ease, box-shadow 0.25s ease; }
        .included-list li::before { content: ''; position: absolute; inset: 0; pointer-events: none; background: linear-gradient(90deg, rgba(200,169,110,0.12), transparent 45%); opacity: 0; transform: translateX(-18%); transition: opacity 0.25s ease, transform 0.25s ease; }
        .included-list li:hover { color: var(--cream); border-color: rgba(200,169,110,0.34); background: rgba(200,169,110,0.055); transform: translateX(6px); box-shadow: 0 14px 32px rgba(0,0,0,0.16); }
        .included-list li:hover::before { opacity: 1; transform: translateX(0); }
        .included-list li .icon { position: relative; z-index: 1; color: var(--gold); font-size: 1rem; flex-shrink: 0; transition: transform 0.25s ease, color 0.25s ease; }
        .included-list li:hover .icon { transform: rotate(45deg) scale(1.1); }
        .included-list li > * { position: relative; z-index: 1; }
        .included-list.not li .icon { color: var(--rust); opacity: 0.82; }
        .included-list.not li:hover { border-color: rgba(185,74,48,0.34); background: rgba(185,74,48,0.05); }
        .included-list.not li::before { background: linear-gradient(90deg, rgba(185,74,48,0.13), transparent 45%); }
        .packing-details { margin-top: 1.5rem; border: 1px solid rgba(200,169,110,0.22); border-radius: var(--radius-card); background: rgba(200,169,110,0.045); overflow: hidden; transition: border-color 0.25s ease, background 0.25s ease, transform 0.25s ease; }
        .packing-details:hover { border-color: rgba(200,169,110,0.42); background: rgba(200,169,110,0.07); transform: translateY(-2px); }
        .packing-summary { list-style: none; cursor: pointer; display: flex; justify-content: space-between; align-items: center; gap: 1rem; padding: 1rem 1.2rem; color: var(--gold); font-size: 0.65rem; letter-spacing: 0.22em; text-transform: uppercase; }
        .packing-summary::-webkit-details-marker { display: none; }
        .packing-summary::after { content: '▼'; font-size: 0.7rem; transition: transform 0.25s ease; }
        .packing-details[open] .packing-summary::after { transform: rotate(180deg); }
        .packing-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.55rem 1.2rem; padding: 0 1.2rem 1.2rem; border-top: 1px solid rgba(200,169,110,0.15); }
        .packing-grid li { list-style: none; position: relative; padding-left: 1rem; font-size: 0.82rem; line-height: 1.55; color: rgba(212,207,196,0.82); }
        .packing-grid li::before { content: '•'; position: absolute; left: 0; color: var(--gold); }
        .getting-there-steps { counter-reset: step; display: grid; gap: 0.8rem; margin: 0; padding: 1rem 1.2rem 0; border-top: 1px solid rgba(200,169,110,0.15); list-style: none; }
        .getting-there-steps li { counter-increment: step; position: relative; padding-left: 2rem; font-size: 0.82rem; line-height: 1.55; color: rgba(212,207,196,0.82); }
        .getting-there-steps li::before { content: counter(step, decimal-leading-zero); position: absolute; left: 0; top: 0.1rem; color: var(--gold); font-size: 0.62rem; letter-spacing: 0.12em; }
        .getting-there-steps strong { display: block; color: var(--cream); font-weight: 400; }
        .getting-there-note { margin: 0.9rem 1.2rem 1.2rem; padding-left: 0.8rem; border-left: 2px solid var(--gold); font-size: 0.78rem; line-height: 1.55; color: rgba(212,207,196,0.7); }

        .booking { background: var(--dark); display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 6rem; align-items: start; overflow-x: clip; }
        .scarcity-pill { display:inline-flex; max-width:100%; box-sizing:border-box; align-items:center; gap:0.6rem; margin-top:1.2rem; padding:0.6rem 1.1rem; background:rgba(185,74,48,0.12); border:1px solid rgba(185,74,48,0.35); border-radius: var(--radius-soft); overflow:hidden; }
        .scarcity-pill span:last-child { min-width:0; font-size:0.72rem; letter-spacing:0.2em; text-transform:uppercase; color:var(--rust); line-height:1.45; overflow-wrap:anywhere; }
        .price-card { max-width:100%; box-sizing:border-box; overflow:hidden; background: var(--ink); border: 1px solid rgba(200,169,110,0.25); border-radius: var(--radius-card); padding: 3rem; }
        .price-badge { max-width:100%; box-sizing:border-box; font-size: 0.6rem; letter-spacing: 0.3em; line-height:1.55; text-transform: uppercase; background: var(--rust); color: var(--cream); display: inline-block; padding: 0.4rem 1rem; margin-bottom: 1.5rem; border-radius: var(--radius-soft); overflow-wrap:anywhere; }
        .price-amount { max-width:100%; font-family: var(--font-cormorant), 'Cormorant Garamond', serif; font-size: clamp(2.45rem, 8vw, 4rem); font-weight: 300; color: var(--gold); line-height: 0.98; margin-bottom: 0.4rem; overflow-wrap:anywhere; word-break: normal; }
        .price-per { max-width:100%; font-size: 0.75rem; letter-spacing: 0.15em; line-height:1.5; text-transform: uppercase; color: var(--mist); opacity: 0.6; margin-bottom: 2rem; overflow-wrap:anywhere; }
        .price-note { max-width:100%; box-sizing:border-box; font-size: 0.8rem; color: var(--mist); opacity: 0.7; line-height: 1.6; margin-bottom: 1rem; padding: 1rem; background: rgba(245,240,232,0.04); border-left: 2px solid var(--gold); border-radius: 0 var(--radius-soft) var(--radius-soft) 0; overflow-wrap:anywhere; }
        .group-rate-table { display:grid; gap:0.45rem; padding:0.85rem 1rem 1rem; border-top:1px solid rgba(200,169,110,0.14); }
        .group-rate-row { display:flex; align-items:center; justify-content:space-between; gap:1rem; border:1px solid rgba(200,169,110,0.18); background:rgba(14,12,9,0.28); border-radius:var(--radius-soft); padding:0.62rem 0.75rem; }
        .group-rate-row span { color:var(--mist); font-size:0.78rem; }
        .group-rate-price { display:flex; flex-direction:column; align-items:flex-end; gap:0.15rem; text-align:right; }
        .group-rate-price strong { color:var(--cream); font-size:0.86rem; letter-spacing:0.02em; }
        .group-rate-price small { color:rgba(212,207,196,0.6); font-size:0.66rem; }
        .payment-split { display:grid; grid-template-columns:1fr auto 1fr; gap:0.85rem; align-items:stretch; margin:1.1rem 0; }
        .payment-split-card { border:1px solid rgba(200,169,110,0.2); background:rgba(14,12,9,0.32); border-radius:var(--radius-card); padding:0.9rem; text-align:left; }
        .payment-split-label { display: block; color: rgba(212,207,196,0.62); font-size: 0.58rem; letter-spacing: 0.18em; text-transform: uppercase; margin-bottom: 0.35rem; }
        .payment-split-amount { display: block; color: var(--cream); font-family: var(--font-cormorant), 'Cormorant Garamond', serif; font-size: 1.45rem; line-height: 1; margin-bottom: 0.35rem; overflow-wrap: anywhere; }
        .payment-split-copy { color: rgba(212,207,196,0.76); font-size: 0.72rem; line-height: 1.5; }
        .payment-split-arrow { display: flex; align-items: center; justify-content: center; color: var(--gold); font-size: 1.1rem; opacity: 0.76; }
        .payment-details { margin-top: 1rem; border: 1px solid rgba(200,169,110,0.22); border-radius: var(--radius-card); background: rgba(200,169,110,0.045); overflow: hidden; }
        .payment-summary { list-style: none; cursor: pointer; display: flex; justify-content: space-between; align-items: center; gap: 1rem; padding: 0.85rem 1rem; color: var(--gold); font-size: 0.62rem; letter-spacing: 0.2em; text-transform: uppercase; }
        .payment-summary::-webkit-details-marker { display: none; }
        .payment-summary::after { content: '▼'; font-size: 0.65rem; transition: transform 0.25s ease; }
        .payment-details[open] .payment-summary::after { transform: rotate(180deg); }
        .payment-detail-body { padding: 0 1rem 1rem; border-top: 1px solid rgba(200,169,110,0.14); font-size: 0.8rem; line-height: 1.65; color: rgba(212,207,196,0.82); overflow-wrap:anywhere; }
        .payment-detail-body p { margin-top: 0.8rem; }
        .payment-details + .payment-details { margin-top: 0.6rem; }
        .ask-card { margin-top: 1.1rem; border: 1px solid rgba(200,169,110,0.24); border-radius: var(--radius-card); background: rgba(200,169,110,0.055); padding: 1rem; }
        .ask-card h3 { font-family: var(--font-cormorant), 'Cormorant Garamond', serif; color: var(--cream); font-size: 1.25rem; font-weight: 300; margin-bottom: 0.4rem; }
        .ask-card p { color: rgba(212,207,196,0.78); font-size: 0.82rem; line-height: 1.6; margin-bottom: 0.75rem; }
        .ask-card a { display: inline-flex; color: var(--gold); border-bottom: 1px solid rgba(200,169,110,0.45); text-decoration: none; font-size: 0.68rem; letter-spacing: 0.16em; text-transform: uppercase; }
        .ask-card a:hover { color: var(--cream); border-color: var(--cream); }
        .ask-card-alt { margin-top: 0.95rem; padding-top: 0.95rem; border-top: 1px solid rgba(200,169,110,0.16); }
        .price-spec-list { display:flex; flex-direction:column; gap:0.8rem; margin-top:1.5rem; }
        .price-spec-row { display:flex; justify-content:space-between; gap:1rem; min-width:0; font-size:0.8rem; color:var(--mist); padding:0.6rem 0; border-bottom:1px solid rgba(245,240,232,0.07); }
        .price-spec-row span { min-width:0; overflow-wrap:anywhere; }
        .price-spec-row span:last-child { color:var(--cream); text-align:right; }
        .tour-dates-card { margin-top: 1.5rem; padding: 1.25rem; background: rgba(200,169,110,0.08); border: 1px solid rgba(200,169,110,0.35); border-radius: var(--radius-card); }
        .tour-date-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.55rem; }
        .tour-date-row { appearance: none; width: 100%; min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; justify-content: space-between; gap: 0.75rem; padding: 0.72rem 0.78rem; background: rgba(200,169,110,0.07); border: 1px solid rgba(200,169,110,0.2); border-radius: var(--radius-soft); font: inherit; text-align: left; color: inherit; cursor: pointer; transition: background 0.24s ease, border-color 0.24s ease, transform 0.24s ease, box-shadow 0.24s ease; }
        .tour-date-row:hover, .tour-date-row:focus-visible { background: rgba(200,169,110,0.12); border-color: rgba(200,169,110,0.52); transform: translateY(-1px); outline: none; }
        .tour-date-row.selected { border-color: var(--gold); background: rgba(200,169,110,0.16); box-shadow: inset 0 0 0 1px rgba(200,169,110,0.22), 0 10px 24px rgba(0,0,0,0.12); }
        .tour-date-row.muted { background: rgba(200,169,110,0.03); border-color: rgba(200,169,110,0.1); }
        .tour-date-title { font-size: 0.94rem; font-family: var(--font-cormorant), 'Cormorant Garamond', serif; color: var(--cream); font-weight: 400; margin-bottom: 0.1rem; }
        .tour-date-row.muted .tour-date-title { color: var(--mist); }
        .tour-date-detail { font-size: 0.66rem; color: var(--mist); opacity: 0.7; }
        .tour-date-row.muted .tour-date-detail { opacity: 0.5; }
        .tour-date-status { font-size: 0.6rem; letter-spacing: 0.15em; text-transform: uppercase; color: var(--gold); background: rgba(200,169,110,0.12); border: 1px solid rgba(200,169,110,0.3); padding: 0.3rem 0.7rem; border-radius: var(--radius-soft); white-space: nowrap; }
        .tour-date-row.selected .tour-date-status { background: var(--gold); color: var(--dark); border-color: var(--gold); }
        .tour-date-row.muted .tour-date-status { color: var(--mist); background: transparent; border-color: transparent; opacity: 0.5; }
        #application, #tour-dates { scroll-margin-top: 6rem; }
        .booking-form { display: flex; flex-direction: column; gap: 1rem; }
        .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
        .form-section { border: 1px solid rgba(200,169,110,0.16); border-radius: var(--radius-card); background: rgba(245,240,232,0.025); padding: 1.2rem; display: flex; flex-direction: column; gap: 1rem; }
        .companion-fields { min-width: 0; margin: 0; }
        .form-section-title { font-size: 0.62rem; letter-spacing: 0.24em; text-transform: uppercase; color: rgba(200,169,110,0.9); margin-bottom: 0.1rem; }
        .form-fields { border: 0; padding: 0; margin: 0; display: contents; }
        .form-fields:disabled { opacity: 0.58; }
        .form-fields:disabled input, .form-fields:disabled select, .form-fields:disabled textarea, .form-fields:disabled button { cursor: not-allowed; }
        .form-group { display: flex; flex-direction: column; gap: 0.4rem; }
        .form-label { font-size: 0.65rem; letter-spacing: 0.2em; text-transform: uppercase; color: var(--gold); }
        .form-input, .form-select, .form-textarea { background: rgba(245,240,232,0.05); border: 1px solid rgba(245,240,232,0.12); border-radius: var(--radius-soft); color: var(--cream); padding: 0.8rem 1rem; font-family: var(--font-jost), 'Jost', sans-serif; font-size: 0.875rem; line-height: 1.3; font-weight: 300; width: 100%; min-height: 48px; box-sizing: border-box; transition: border-color 0.3s ease; outline: none; -webkit-appearance: none; }
        .form-input:focus, .form-select:focus, .form-textarea:focus { border-color: var(--gold); }
        .date-of-birth-group { min-width: 0; margin: 0; padding: 0; border: 0; }
        .date-of-birth-group .form-label { margin-bottom: 0.35rem; }
                .date-of-birth-inputs { display: grid; grid-template-columns: 0.9fr 1fr 1.2fr; gap: 0.5rem; }
                .date-of-birth-part .form-select { width: 100%; padding-inline: 0.65rem; }
        .field-error { margin: 0.45rem 0 0; color: #fff; font-size: 0.78rem; font-weight: 500; }
        .booking-error-summary { margin: 0 0 1rem; padding: 0.9rem 1rem; border: 2px solid #ff8f70; border-radius: var(--radius-soft); background: #35170f; color: #fff; }
        .booking-error-summary strong { display: block; margin-bottom: 0.35rem; }
        .booking-error-summary ul { margin: 0; padding-left: 1.1rem; }
        .booking-error-summary button { padding: 0.18rem 0; border: 0; background: transparent; color: #fff; text-decoration: underline; cursor: pointer; text-align: left; font: inherit; }
        .form-input[aria-invalid="true"], .form-select[aria-invalid="true"], .form-textarea[aria-invalid="true"] { border: 2px solid #ff8f70; box-shadow: inset 0 0 0 1px #35170f; background-image: linear-gradient(135deg, transparent calc(100% - 1.2rem), rgba(255,143,112,0.35)); }
        @media (max-width: 520px) { .date-of-birth-inputs { gap: 0.4rem; } .date-of-birth-part .form-select { padding-inline: 0.5rem; } }
        @media (max-width: 520px) { .contact-cards, .lead-card-public .lead-form { grid-template-columns: 1fr; } }
        .form-input:-webkit-autofill, .form-input:-webkit-autofill:hover, .form-input:-webkit-autofill:focus, input:-webkit-autofill, input:-webkit-autofill:hover, input:-webkit-autofill:focus, textarea:-webkit-autofill, textarea:-webkit-autofill:hover, textarea:-webkit-autofill:focus { -webkit-box-shadow: 0 0 0 1000px #15120e inset !important; box-shadow: 0 0 0 1000px #15120e inset !important; -webkit-text-fill-color: var(--cream) !important; caret-color: var(--cream); border-color: rgba(200,169,110,0.35) !important; transition: background-color 9999s ease-in-out 0s; }
        .form-select option { background: var(--ink); }
        .form-textarea { resize: vertical; min-height: 80px; }
        .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
        .form-check { display: flex; align-items: flex-start; gap: 0.75rem; font-size: 0.8rem; color: var(--mist); opacity: 0.8; line-height: 1.5; cursor: pointer; }
        .group-pricing-card { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:0.85rem; border:1px solid rgba(200,169,110,0.28); background:rgba(200,169,110,0.075); border-radius:var(--radius-card); padding:1rem; }
        .group-pricing-card div { min-width:0; }
        .group-pricing-card strong { display:block; color:var(--cream); font-family:var(--font-cormorant), 'Cormorant Garamond', serif; font-size:1.35rem; line-height:1.05; font-weight:400; }
        .group-pricing-card small, .group-pricing-card span { display:block; color:var(--mist); font-size:0.74rem; line-height:1.45; opacity:0.76; margin-top:0.28rem; }
        .group-pricing-eyebrow { font-size:0.58rem; letter-spacing:0.18em; text-transform:uppercase; color:var(--gold); margin:0 0 0.45rem; }
        .form-check input[type="checkbox"] { appearance: none; width: 16px; height: 16px; flex-shrink: 0; margin-top: 2px; border: 1px solid rgba(245,240,232,0.3); border-radius: 4px; background: transparent; cursor: pointer; position: relative; }
        .form-check input[type="checkbox"]:checked { background: var(--gold); border-color: var(--gold); }
        .submit-btn { background: var(--gold); color: var(--dark); border: none; border-radius: var(--radius-soft); padding: 1.1rem 2rem; font-family: var(--font-jost), 'Jost', sans-serif; font-size: 0.75rem; letter-spacing: 0.2em; text-transform: uppercase; font-weight: 500; cursor: pointer; transition: all 0.3s ease; width: 100%; margin-top: 0.5rem; }
        .submit-btn:hover { background: var(--rust); color: var(--cream); }
        .submit-btn:disabled { background: var(--sage); color: var(--cream); cursor: default; }
        .payment-checkout-card { max-width:100%; box-sizing:border-box; overflow:hidden; margin-top: 1rem; padding: 1.2rem; background: linear-gradient(145deg, rgba(245,240,232,0.075), rgba(99,91,255,0.08)); border: 1px solid rgba(200,169,110,0.24); border-radius: var(--radius-payment); text-align: center; box-shadow: inset 0 1px 0 rgba(255,255,255,0.05); }
        .booking-save-spinner { display:inline-block; width:1em; height:1em; margin-right:0.7em; border:2px solid currentColor; border-right-color:transparent; border-radius:50%; vertical-align:middle; animation:booking-saving 0.8s linear infinite; }
        @keyframes booking-saving { to { transform:rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) { .booking-save-spinner { animation:none; } }
        .checkout-eyebrow { font-size: 0.72rem; letter-spacing: 0.2em; text-transform: uppercase; color: var(--gold); margin-bottom: 0.55rem; }
        .checkout-copy { font-size: 0.85rem; color: var(--mist); line-height: 1.6; margin-bottom: 1rem; }
        .checkout-copy strong { color: var(--cream); }
        .stripe-trust-row { display: flex; flex-wrap: wrap; justify-content: center; gap: 0.4rem; margin: 0 0 0.85rem; }
        .stripe-trust-row span { border: 1px solid rgba(245,240,232,0.14); background: rgba(14,12,9,0.44); color: rgba(245,240,232,0.72); border-radius: 999px; padding: 0.32rem 0.55rem; font-size: 0.62rem; letter-spacing: 0.08em; }
        .stripe-trust-row .stripe-wordmark { background: #635bff; border-color: #635bff; color: #fff; font-weight: 700; letter-spacing: -0.02em; text-transform: lowercase; }
        .checkout-note { font-size: 0.72rem; color: rgba(212,207,196,0.62); line-height: 1.6; margin-bottom: 1rem; }
        .form-error { margin-top: 0.75rem; color: #ffb4a6; font-size: 0.72rem; line-height: 1.5; text-align: center; }
        .checkout-button-wrap { position: relative; }
        .stripe-embed-wrap { width:100%; max-width:min(430px, 100%); margin: 0 auto; overflow:hidden; }
        .stripe-checkout-preview { width: 100%; border: 1px solid rgba(255,255,255,0.12); border-radius: 10px; background: linear-gradient(180deg, rgba(255,255,255,0.98), rgba(241,244,249,0.96)); color: #0a2540; padding: 0; overflow: hidden; box-shadow: 0 18px 38px rgba(0,0,0,0.24); transition: opacity 0.25s ease, filter 0.25s ease, transform 0.25s ease; }
        .stripe-checkout-preview:not(:disabled) { cursor: pointer; }
        .stripe-checkout-preview:not(:disabled):hover { transform: translateY(-1px); }
        .stripe-checkout-preview:disabled { opacity: 0.48; filter: grayscale(0.16); cursor: not-allowed; }
        .stripe-preview-top { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 0.9rem 1rem 0.55rem; border-bottom: 1px solid rgba(10,37,64,0.08); }
        .stripe-preview-wordmark { background: #635bff; color: #fff; border-radius: 5px; padding: 0.28rem 0.5rem; font-size: 0.76rem; font-weight: 700; letter-spacing: -0.02em; text-transform: lowercase; }
        .stripe-preview-secure { color: rgba(10,37,64,0.62); font-size: 0.62rem; letter-spacing: 0.12em; text-transform: uppercase; }
        .stripe-preview-body { display: block; padding: 0.85rem 1rem 1rem; text-align: left; }
        .stripe-preview-label { display: block; color: rgba(10,37,64,0.58); font-size: 0.66rem; letter-spacing: 0.12em; text-transform: uppercase; margin-bottom: 0.32rem; }
        .stripe-preview-amount { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; color: var(--cream); font-size: 1.34rem; font-weight: 700; letter-spacing: -0.03em; }
        .stripe-preview-amount span { color: var(--mist); font-size: 0.62rem; letter-spacing: 0.12em; text-transform: uppercase; font-weight: 600; white-space: nowrap; }
        .stripe-card-row { display: flex; gap: 0.35rem; margin-top: 0.85rem; }
        .stripe-card-row span { border: 1px solid rgba(10,37,64,0.14); border-radius: 4px; background: #fff; color: rgba(10,37,64,0.7); padding: 0.25rem 0.38rem; font-size: 0.58rem; font-weight: 700; letter-spacing: 0.04em; }
        .stripe-pay-button { display: flex; width: 100%; box-sizing: border-box; align-items: center; justify-content: space-between; gap: 1rem; padding: 1rem 1.15rem; background: linear-gradient(135deg, #635bff, #7b72ff); border: 1px solid rgba(255,255,255,0.16); border-radius: 5px; color: #fff; font-size: 0.72rem; letter-spacing: 0.16em; text-transform: uppercase; font-weight: 500; text-decoration: none; box-shadow: 0 14px 34px rgba(99,91,255,0.24); transition: transform 0.25s ease, box-shadow 0.25s ease; }
        .stripe-pay-button:hover { transform: translateY(-1px); box-shadow: 0 18px 42px rgba(99,91,255,0.34); }
        .stripe-pay-button strong { font-size: 0.78rem; color: #fff; white-space: nowrap; }
        .stripe-pay-button.disabled { opacity: 0.38; cursor: not-allowed; box-shadow: none; }
        .stripe-pay-button.disabled:hover { transform: none; box-shadow: none; }
        .stripe-buy-button-frame { width:100%; max-width:100%; overflow:hidden; min-height: 230px; border-radius: var(--radius-payment); }
        .stripe-buy-button-frame stripe-buy-button { display:block; max-width:100%; overflow:hidden; }
        .stripe-buy-button-frame.locked { pointer-events: none; }
        .stripe-link-fallback { display: inline-flex; justify-content: center; margin-top: 0.75rem; color: rgba(245,240,232,0.58); font-size: 0.68rem; text-decoration: underline; text-underline-offset: 3px; }
        .checkout-lock-overlay { position: absolute; inset: 0; z-index: 2; cursor: pointer; display: flex; align-items: flex-start; justify-content: center; padding-top: 0.65rem; background: transparent; }
        .checkout-lock-overlay p { max-width:calc(100% - 1.5rem); box-sizing:border-box; font-size: 0.62rem; letter-spacing: 0.1em; line-height:1.35; text-transform: uppercase; color: var(--gold); background: rgba(14,12,9,0.72); border: 1px solid rgba(200,169,110,0.32); border-radius: var(--radius-soft); padding: 0.36rem 0.58rem; pointer-events: none; white-space:normal; overflow-wrap:anywhere; box-shadow: 0 8px 18px rgba(0,0,0,0.22); }
        .checkout-error { margin-top: 0.75rem; color: #ffb4a6; font-size: 0.72rem; line-height: 1.5; text-align: center; }
        .group-request-next-step { display:flex; flex-direction:column; gap:0.35rem; border:1px solid rgba(200,169,110,0.28); background:rgba(200,169,110,0.08); border-radius:var(--radius-card); padding:0.9rem; text-align:left; }
        .group-request-next-step strong { color:var(--cream); font-size:0.86rem; }
        .group-request-next-step span { color:var(--mist); font-size:0.76rem; line-height:1.55; opacity:0.78; }
        .lead-card-public { margin: 0; padding: 1.6rem; border: 1px solid rgba(200,169,110,0.22); border-radius: var(--radius-card); background: rgba(245,240,232,0.045); }
        .lead-card-public h3 { color: var(--cream); font-family: var(--font-cormorant), 'Cormorant Garamond', serif; font-size: 1.65rem; font-weight: 300; margin: 0 0 0.4rem; }
        .lead-card-public p { color: rgba(212,207,196,0.72); font-size: 0.82rem; line-height: 1.6; margin: 0 0 1rem; }
        .lead-form { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 0.6rem; }
        .lead-form button { grid-column: 1 / -1; }
        .lead-form input { width: 100%; box-sizing: border-box; border: 1px solid rgba(245,240,232,0.14); background: rgba(14,12,9,0.54); color: var(--cream); border-radius: var(--radius-soft); padding: 0.86rem 1rem; font: inherit; outline: none; }
        .lead-form input:focus { border-color: var(--gold); }
        .lead-form button { display: inline-flex; align-items: center; justify-content: center; border: 1px solid var(--gold); background: var(--gold); color: var(--dark); border-radius: var(--radius-soft); padding: 1rem 1.25rem; font-family: var(--font-jost), 'Jost', sans-serif; font-size: 0.72rem; letter-spacing: 0.18em; line-height: 1; text-transform: uppercase; font-weight: 700; cursor: pointer; transition: background 0.3s ease, border-color 0.3s ease, color 0.3s ease, transform 0.3s ease; }
        .lead-form button:hover:not(:disabled) { background: var(--cream); border-color: var(--cream); color: var(--dark); transform: translateY(-1px); }
        .lead-form button:disabled { opacity: 0.86; cursor: default; color: rgba(14,12,9,0.88); }
        .lead-message { margin-top: 0.75rem; font-size: 0.74rem; line-height: 1.5; color: var(--gold); }
        .lead-message.error { color: #ffb4a6; }
        .lead-privacy { margin-top: 0.75rem !important; margin-bottom: 0 !important; font-size: 0.68rem !important; line-height: 1.5 !important; color: rgba(212,207,196,0.56) !important; }
        .lightbox-backdrop { position: fixed; inset: 0; z-index: 100; background: rgba(0,0,0,0.94); display: flex; align-items: center; justify-content: center; padding: 2rem; cursor: zoom-out; }
        .gallery-handoff { background:#0f0f0d; border-top:1px solid rgba(200,169,110,0.14); border-bottom:1px solid rgba(200,169,110,0.14); padding: 1.6rem 6rem; display:grid; grid-template-columns:minmax(0,1fr) auto; gap:2rem; align-items:center; }
        .gallery-handoff-copy p:first-child { font-size:0.62rem; letter-spacing:0.26em; text-transform:uppercase; color:var(--gold); margin-bottom:0; }
        .gallery-handoff-copy p:not(:first-child) { font-size:0.88rem; color:rgba(212,207,196,0.72); line-height:1.55; max-width:640px; }
        .divider { display: flex; align-items: center; gap: 1.5rem; padding: 0 6rem; }
        .divider-line { flex: 1; height: 1px; background: rgba(200,169,110,0.15); }
        .divider-ornament { color: var(--gold); font-size: 0.8rem; }

        .faq-section { background: var(--ink); padding: 7rem 2rem; }
        footer { background: #120f0b; border-top: 1px solid rgba(200,169,110,0.18); padding: 4.5rem 2rem 3rem; text-align: center; }
        .footer-inner { max-width: 860px; margin: 0 auto; display: block; }
        .footer-kicker { font-size: 0.62rem; letter-spacing: 0.28em; text-transform: uppercase; color: var(--gold); margin-bottom: 1rem; }
        .footer-logo { font-family: var(--font-cormorant), 'Cormorant Garamond', serif; font-size: clamp(2.4rem, 5vw, 4rem); line-height: 0.95; letter-spacing: 0.16em; color: var(--cream); text-transform: uppercase; }
        .footer-tagline { font-size: 0.72rem; line-height: 1.8; letter-spacing: 0.22em; text-transform: uppercase; color: rgba(200,169,110,0.88); margin: 1rem auto 0; max-width: 520px; }
        .footer-cta { display: inline-flex; margin-top: 2rem; padding: 1rem 1.8rem; background: var(--gold); border: 1px solid var(--gold); border-radius: var(--radius-soft); color: var(--dark); text-decoration: none; font-size: 0.75rem; letter-spacing: 0.18em; text-transform: uppercase; font-weight: 600; transition: background 0.3s ease, border-color 0.3s ease, transform 0.3s ease; }
        .footer-cta:hover { background: var(--cream); border-color: var(--cream); color: var(--dark); transform: translateY(-2px); }
        .footer-links { margin: 3rem auto 0; display: flex; flex-wrap: wrap; gap: 0.9rem 1.5rem; justify-content: center; }
        .footer-link { color: rgba(200,169,110,0.86); text-decoration: none; font-size: 0.68rem; letter-spacing: 0.18em; text-transform: uppercase; transition: color 0.3s ease; }
        .privacy-choices-link { appearance: none; border: 0; background: transparent; padding: 0; font-family: inherit; line-height: inherit; cursor: pointer; }
        .footer-link:hover { color: var(--cream); }
        .footer-note { border-top: 1px solid rgba(200,169,110,0.14); max-width: 1120px; margin: 3.5rem auto 0; padding-top: 1.4rem; display: flex; justify-content: space-between; gap: 1rem; font-size: 0.75rem; color: rgba(212,207,196,0.68); }

        .reveal { opacity: 1; transform: translateY(0); transition: opacity 0.8s ease, transform 0.8s ease; }
        .js-reveal .reveal { opacity: 1; transform: translateY(0); }
        .js-reveal .reveal.visible { opacity: 1; transform: translateY(0); }
        .reveal-delay-1 { transition-delay: 0.1s; }
        .reveal-delay-2 { transition-delay: 0.2s; }
        .reveal-delay-3 { transition-delay: 0.3s; }

        @media (prefers-reduced-motion: reduce) {
          html { scroll-behavior: auto; }
          .js-reveal .reveal, .js-reveal .reveal.visible { opacity: 1 !important; transform: none !important; }
          .hero-bg { animation: none !important; }
          .hero-video { display: none; }
          *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; scroll-behavior: auto !important; transition-duration: 0.01ms !important; }
        }

        @media (max-width: 900px) {
          section { padding: 5rem 2rem; }
          #main-nav { padding: 1.1rem 1.5rem; }
          .nav-links { display: none; }
          .nav-logo { font-size: 1.15rem; letter-spacing: 0.18em; }
          #main-nav.mobile-nav-hidden { transform: translateY(-100%); }
          .hero {
            height: auto;
            min-height: 100svh;
            min-height: 100dvh;
            padding-top: calc(5.25rem + env(safe-area-inset-top));
          }
          .hero-content {
            padding: 0 1.55rem calc(5.25rem + env(safe-area-inset-bottom));
            width: 100%;
          }
          .hero-overlay { background: linear-gradient(to top, rgba(14,12,9,0.97) 0%, rgba(14,12,9,0.6) 45%, rgba(14,12,9,0.25) 100%); }
          .hero-sub { margin-bottom: 1.2rem; }
          .hero-sub .mobile-line { display: inline; }
          .hero-sub .desktop-line { display: none; }
          .hero-actions { flex-direction: column; align-items: stretch; gap: 0.8rem; }
          .hero-actions .btn-primary, .hero-actions .btn-ghost { text-align: center; }
          .intro-points { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1.1rem 0.75rem; margin-top: 2.2rem; align-items: start; }
          .offer-strip { padding: 1.25rem 1.2rem; grid-template-columns: 1fr; gap: 1rem; }
          .offer-strip-facts { grid-template-columns: repeat(2, minmax(0, 1fr)); }
          .offer-fact { padding-left: 0.65rem; }
          .offer-fact strong { font-size: 0.82rem; }
          .offer-strip-cta { width: 100%; }
          .intro-point-value { font-size: clamp(1.25rem, 7vw, 1.55rem); }
          .intro-point-label { font-size: 0.48rem; letter-spacing: 0.12em; line-height: 1.55; overflow-wrap: normal; }
          .trust-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.65rem; }
          .trust-link { justify-content: center; align-items: center; text-align: center; padding: 0.85rem 0.6rem; font-size: 0.58rem; letter-spacing: 0.12em; line-height: 1.35; }
          .stats-bar { grid-template-columns: repeat(2,1fr); padding: 1.5rem 2rem; }
          .intro, .partnership, .booking, .included, .trust-conversion { grid-template-columns: 1fr; gap: 3rem; }
          .booking { padding: 3.4rem 1.05rem; gap: 1.55rem; }
          .scarcity-pill { display:flex; width:100%; padding:0.55rem 0.7rem; }
          .scarcity-pill span:last-child { font-size:0.6rem; letter-spacing:0.12em; }
          .price-card { padding: 1.25rem 0.9rem; margin-top:1.5rem !important; }
          .price-badge { display:block; width:100%; padding:0.45rem 0.55rem; text-align:center; font-size:0.52rem; letter-spacing:0.18em; }
          .price-amount { font-size: clamp(2.15rem, 15vw, 3.05rem); line-height:0.95; }
          .price-per { font-size:0.62rem; letter-spacing:0.1em; margin-bottom:1.15rem; }
          .price-note { display:none; }
          .payment-split { grid-template-columns: minmax(0,1fr) auto minmax(0,1fr); gap: 0.35rem; margin:0.9rem 0 0.75rem; }
          .payment-split-card { padding: 0.68rem 0.55rem; text-align:center; border-radius: var(--radius-soft); }
          .payment-split-label { font-size:0.46rem; letter-spacing:0.12em; margin-bottom:0.28rem; }
          .payment-split-amount { font-size: clamp(1.05rem, 6.2vw, 1.35rem); margin-bottom:0; }
          .payment-split-copy { display:none; }
          .payment-split-arrow { transform:none; height:auto; font-size:0.9rem; padding-top:1.3rem; }
          .payment-summary { padding:0.72rem 0.8rem; font-size:0.54rem; letter-spacing:0.12em; line-height:1.45; }
          .payment-detail-body { padding:0 0.8rem 0.85rem; }
          .payment-details + .payment-details { margin-top:0.45rem; }
          .group-rate-table { gap:0.35rem; padding:0.65rem 0.8rem 0.8rem; }
          .group-rate-row { padding:0.5rem 0.62rem; gap:0.6rem; }
          .group-rate-row span { font-size:0.7rem; }
          .group-rate-price strong { font-size:0.78rem; }
          .group-rate-price small { font-size:0.58rem; }
          .price-spec-list { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:1px; margin-top:0.9rem; background:rgba(245,240,232,0.08); border:1px solid rgba(245,240,232,0.08); border-radius:var(--radius-card); overflow:hidden; }
          .price-spec-row { display:flex; flex-direction:column; gap:0.18rem; background:var(--ink); border-bottom:0; padding:0.62rem 0.68rem; font-size:0.68rem; line-height:1.28; }
          .price-spec-row span:last-child { text-align:left; font-size:0.74rem; }
          .ask-card { padding:0.78rem; margin-top:0.85rem; }
          .ask-card h3 { font-size:1.05rem; margin-bottom:0.35rem; }
          .ask-card p { display:none; }
          .ask-card a { font-size:0.58rem; letter-spacing:0.12em; }
          .ask-card .ask-card-alt { margin-top:0.75rem; padding-top:0.75rem; }
          .ask-card .ask-card-alt p { display:block; font-size:0.74rem; line-height:1.5; margin-bottom:0.5rem; }
          .contact-section { padding: 4rem 1.5rem; }
          .contact-layout { grid-template-columns: 1fr; gap: 2rem; }
          .lead-card-public { padding: 1.2rem; }
          .tour-dates-card { margin-top: 1rem; padding: 0.8rem 0.62rem; border-radius: var(--radius-card); }
          .tour-dates-heading { font-size:0.52rem !important; letter-spacing:0.22em !important; margin-bottom:0.62rem !important; }
          .tour-date-list { grid-template-columns: 1fr; gap: 0.26rem; }
          .tour-date-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0.38rem; padding: 0.48rem 0.54rem; min-height: 3.08rem; align-items: center; border-radius: var(--radius-soft); }
          .tour-date-title { font-size: clamp(0.78rem, 4.7vw, 0.9rem); line-height:1.08; margin: 0; }
          .tour-date-detail { display: none; }
          .tour-date-status { font-size: 0.42rem; letter-spacing: 0.07em; padding: 0.2rem 0.34rem; }
          .booking-form { gap: 0.85rem; }
          .form-section { padding: 0.85rem; gap: 0.75rem; }
          .form-section-title { font-size: 0.56rem; letter-spacing: 0.16em; }
          .form-group { gap: 0.28rem; }
          .form-label { font-size: 0.54rem; letter-spacing: 0.11em; line-height: 1.35; }
          .form-input, .form-select, .form-textarea { min-height: 46px; padding: 0.62rem 0.72rem; font-size: 0.94rem; }
          .form-textarea { min-height: 88px; }
          .form-grid { grid-template-columns: 1fr; gap: 0.75rem; }
          .form-grid.compact-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
          .trust { padding: 3.5rem 1.5rem 4rem; }
          .itinerary { padding-bottom: 3rem; }
          .trust-grid { grid-template-columns: 1fr; }
          .testimonial-grid { grid-template-columns: 1fr; }
          .testimonial-photo { height: 280px; }
          .image-button.testimonial-photo { height: 280px; }
          .itinerary-grid { grid-template-columns: 1fr; }
          .itin-tag { font-size: 0.75rem; }
          .itin-title { font-size: 2rem; }
          .itin-desc { font-size: 1rem; }
          .itin-list li { font-size: 0.95rem; }
          .photo-strip { height: 40vw; min-height: 200px; }
          .mosaic { grid-template-columns: 1fr 1fr; grid-template-rows: auto; }
          .mosaic-item.tall { grid-row: span 1; }
          .faq-section { padding: 4rem 1.5rem 3.5rem; }
          footer { padding: 3.25rem 1.5rem calc(3rem + env(safe-area-inset-bottom)); }
          .footer-inner { display: block; text-align: center; }
          .footer-kicker { margin-bottom: 0.8rem; }
          .footer-logo { font-size: clamp(2.15rem, 10vw, 3rem); letter-spacing: 0.12em; }
          .footer-tagline { font-size: 0.68rem; letter-spacing: 0.16em; max-width: 320px; }
          .footer-cta { width: 100%; justify-content: center; margin-top: 1.5rem; }
          .footer-links { margin-top: 2.5rem; gap: 1rem 1.2rem; }
          .main-album { display: block; column-count: 2; column-gap: 3px; }
          .main-album-item { display: block; width: 100%; margin: 0 0 3px; break-inside: avoid; page-break-inside: avoid; transform: translateZ(0); }
          .main-album-item.collage-lead { aspect-ratio: 3 / 4.25; }
          .main-album-item.collage-hero,
          .main-album-item.collage-wide-left,
          .main-album-item.collage-wide-right,
          .main-album-item.collage-bottom-left,
          .main-album-item.collage-bottom-mid { aspect-ratio: 4 / 3; }
          .main-album-item.collage-tall { aspect-ratio: 3 / 4.6; }
          .main-album-item.collage-small-a,
          .main-album-item.collage-small-b { aspect-ratio: 1 / 1; }
          .main-album-item.collage-bottom-right { aspect-ratio: 3 / 4.1; }
          .lightbox-nav { width: 2.7rem; height: 2.7rem; font-size: 1.6rem; }
          .lightbox-close { top: calc(0.8rem + env(safe-area-inset-top)); right: calc(0.8rem + env(safe-area-inset-right)); width: 3.4rem; height: 3.4rem; font-size: 1.5rem; background: rgba(14,12,9,0.9); border-color: rgba(245,240,232,0.5); }
          .lightbox-prev { left: 0.5rem; }
          .lightbox-next { right: 0.5rem; }
          .footer-link { font-size: 0.66rem; letter-spacing: 0.14em; }
          .footer-note { margin-top: 2.5rem; padding-top: 1.2rem; flex-direction: column; font-size: 0.72rem; line-height: 1.6; }
          .gallery-handoff { padding: 1.6rem 1.5rem; grid-template-columns: 1fr; gap: 1rem; text-align: left; }
          .gallery-handoff .btn-ghost { width: 100%; justify-content: center; text-align: center; }
          .divider { padding: 0 2rem; }
          .partnership-text { padding: 4rem 2rem; }
          .partnership-inline-photo { display: block !important; margin: 2.4rem 0 2.8rem; }
          .partnership-inline-photo + .section-body { margin-top: 0.35rem; }
          .partnership-img { display: none; }
          .form-grid { grid-template-columns: 1fr; }
          .group-pricing-card { grid-template-columns:1fr; padding:0.82rem; gap:0.7rem; }
          .group-pricing-card strong { font-size:1.18rem; }
          .packing-grid { grid-template-columns: 1fr; }
          .payment-checkout-card { padding:0.8rem 0.55rem; }
          .checkout-eyebrow { font-size:0.58rem; letter-spacing:0.13em; }
          .checkout-copy { font-size:0.78rem; }
          .checkout-note { font-size:0.68rem; }
          .stripe-embed-wrap { max-width:100%; }
          .stripe-buy-button-frame { min-height:220px; }
          .checkout-lock-overlay { padding-top:0.5rem; }
          .checkout-lock-overlay p { font-size:0.52rem; letter-spacing:0.08em; padding:0.32rem 0.46rem; }
          .intro-img-accent { display: none; }
        }
      `}</style>

      {/* NAV */}
      <nav id="main-nav">
        <a href="#top" className="nav-logo">8 Lakes Tours</a>
        <div className="nav-links">
          <a href="/gallery" className="nav-social">Gallery</a>
          <a href="/about" className="nav-social">About</a>
          <a href="/preparation" className="nav-social">Prep</a>
          <a href="/faq" className="nav-social">FAQ</a>
          <a href="/contact" className="nav-social">Contact</a>
          <a href="#application" className="nav-cta">Reserve</a>
        </div>
        <div className="nav-mobile-actions">
          <MobileNavMenu reserveHref="#application" />
        </div>
      </nav>

      {/* HERO */}
      <div className="hero" id="top">
        <div className="hero-bg">
          <Image
            src="/images/hero-orkhon-valley-drone.jpg"
            alt="Drone view of a golden sunset over the Orkhon Valley and its winding river in Mongolia"
            fill
            preload
            quality={82}
            sizes="100vw"
          />
          <video
            ref={heroVideoRef}
            className="hero-video"
            muted
            loop
            playsInline
            preload="none"
            aria-hidden="true"
            onPlaying={event => event.currentTarget.classList.add('is-playing')}
          >
            <source src="/videos/orkhon-valley-drone-loop-mobile.mp4?v=9" type="video/mp4" media="(max-width: 900px)" />
            <source src="/videos/orkhon-valley-drone-loop.mp4?v=9" type="video/mp4" />
          </video>
        </div>
        <div className="hero-overlay"></div>
        <div className="hero-content">
          <p className="hero-eyebrow">Mongolian Horse Trekking · Orkhon Valley &amp; Eight Lakes</p>
          <h1 className="hero-title">Ride Into the<br /><em>Endless Steppe</em></h1>
          <p className="hero-sub">
            <span className="mobile-line">Nine days on horseback across the vastness of the steppe, living alongside nomadic families. Small groups, beginner and intermediate riders welcome.</span>
            <span className="desktop-line">Nine days on horseback through the vastness of the Orkhon Valley and Eight Lakes, living alongside nomadic families whose way of life is still attuned to the steppe. Small groups, local horsemen, beginner and intermediate riders welcome.</span>
          </p>
          <div className="hero-actions">
            <a href="#application" className="btn-primary">Reserve Online</a>
            <a href="#experience" className="btn-ghost">Explore the Journey</a>
          </div>
        </div>
      </div>

      {lateSeasonDepartures.length > 0 && <section className="offer-strip" aria-label="Late-season 2026 expedition availability and price summary">
        <div>
          <p className="offer-strip-kicker">Still hoping to ride this season?</p>
          <h2 className="offer-strip-title">Book September–November 2026</h2>
          <p className="offer-strip-note">Late-season places are open now — choose your date and reserve online.</p>
        </div>
        <div className="offer-strip-facts">
          <div className="offer-fact"><strong>{pricing.tourPrice}</strong><span>Total per person</span><small className="offer-fact-note">Group rates apply</small></div>
          <div className="offer-fact"><strong>9 days</strong><span>Orkhon & Eight Lakes</span></div>
          <div className="offer-fact"><strong>Beginner friendly</strong><span>Local horsemen guide</span></div>
          <div className="offer-fact"><strong>Max 8</strong><span>Guests per departure</span></div>
        </div>
        <a className="offer-strip-cta" href="#tour-dates" onClick={scrollToTourDates}>See dates &amp; book</a>
      </section>}


      {/* INTRO */}
      <section className="intro" id="experience">
        <div className="intro-img reveal">
          <button
            type="button"
            className="image-button"
            aria-label="View larger image: Suma on horseback in a traditional deel on the Mongolian steppe"
            onClick={() => openLightbox('/images/suma-horseback-deel.jpg')}
          >
            <Image src="/images/suma-horseback-deel.jpg" alt="Suma on horseback in a traditional deel on the Mongolian steppe" fill quality={72} sizes="(max-width: 900px) 100vw, 50vw" />
          </button>
          <span style={{position:'absolute', bottom:'1rem', left:'1rem', fontSize:'0.62rem', letterSpacing:'0.2em', textTransform:'uppercase', color:'rgba(245,240,232,0.75)', background:'rgba(14,12,9,0.55)', padding:'0.35rem 0.7rem', backdropFilter:'blur(4px)', pointerEvents:'none'}}>Suma — Your Guide</span>
        </div>
        <div className="reveal reveal-delay-1">
          <span className="section-eyebrow">What This Is</span>
          <h2 className="section-title">Mongolia<br /><em>Beyond Tourism</em></h2>
          <p className="section-body">This is a chance to step out of everyday life and into the vastness of the steppe. You&apos;ll wake up in a ger, ride open country with local horsemen, and live alongside a family whose way of life has been attuned to this land for generations.</p>
          <p className="section-body" style={{marginTop:'1.2rem'}}>The steppe moves to her own natural rhythms. Ride, eat, rest, laugh, drink tea, look at the sky, and remember what simplicity feels like. For some people that is the whole point.</p>
          <p className="section-body" style={{marginTop:'1.2rem'}}>Plans can change, so come open and flexible. You may be invited outside your comfort zone, but nothing is ever forced. You can always say no, rest, or spend the day closer to nomadic life, and there is always a gracious and helpful hand on the steppe.</p>
          <div className="intro-points">
            <div><span className="intro-point-value">Beginner</span><p className="intro-point-label">Riders Welcome</p></div>
            <div><span className="intro-point-value">Max 8</span><p className="intro-point-label">Guests Per Departure</p></div>
            <div><span className="intro-point-value">16+</span><p className="intro-point-label">With a Parent or Guardian</p></div>
            <div><span className="intro-point-value">Direct</span><p className="intro-point-label">Family Partnership</p></div>
          </div>
        </div>
      </section>

      {/* PHOTO STRIP */}
      <div className="photo-strip">
        {STRIP_IMAGES.map((item) => (
          <div className="strip-item" key={item.src}>
            <button
              type="button"
              className="image-button"
              aria-label={`View larger image: ${item.alt}`}
              onClick={() => openLightbox(item.src)}
            >
              <Image src={item.src} alt={item.alt} fill quality={70} sizes="(max-width: 900px) 20vw, 20vw" />
            </button>
          </div>
        ))}
      </div>

      {/* PARTNERSHIP */}
      <section className="partnership" style={{padding:0}}>
        <div className="partnership-text reveal">
          <span className="section-eyebrow">Our Local Partnership</span>
          <h2 className="section-title">The Family<br /><em>Behind It</em></h2>
          <button
            type="button"
            className="image-button partnership-inline-photo"
            aria-label="View larger image: Robert with the host family and their horses, all in traditional deels on the Mongolian steppe"
            onClick={() => openLightbox('/images/host-family-horses-deels.jpg')}
          >
            <Image src="/images/host-family-horses-deels.jpg" alt="Robert with the host family and their horses, all in traditional deels on the Mongolian steppe" fill quality={72} sizes="100vw" />
          </button>
          <p className="section-body">I met Ganbold while travelling through Mongolia on horseback. I meant to pass through, but his family opened their ger to me, as nomadic families have done for travellers for generations. We didn&apos;t speak the same language, but we shared an appreciation for the steppe and the way of life out there, and it didn&apos;t take long to feel like family. We rode together, cooked, drank tea and laughed a lot.</p>
          <p className="section-body" style={{marginTop:'1.2rem'}}>Suma, Ganbold&apos;s son, loves horses. He has ridden and worked with them his whole life, and he still herds his own horses and yaks across this valley. He likes guiding too, taking people out and showing them the land he grew up in. When the idea of bringing small groups here came up, he was up for it straight away.</p>
          <p className="section-body" style={{marginTop:'1.2rem'}}>This isn&apos;t a company hiring local staff. It&apos;s a collaboration, built on mutual respect and their own wish to share the way they live. Coming here means living alongside them: their gers, their meals, the pace of their days. The local portion of every booking goes directly to the family, and I want this to stay good for the people who make it possible.</p>
          <p style={{marginTop:'1.4rem', fontSize:'0.75rem', letterSpacing:'0.15em', textTransform:'uppercase', color:'var(--gold)', opacity:0.7}}>— Robert, Founder</p>
        </div>
        <div className="partnership-img reveal">
          <button
            type="button"
            className="image-button"
            aria-label="View larger image: Robert with the host family and their horses, all in traditional deels on the Mongolian steppe"
            onClick={() => openLightbox('/images/host-family-horses-deels.jpg')}
          >
            <Image src="/images/host-family-horses-deels.jpg" alt="Robert with the host family and their horses, all in traditional deels on the Mongolian steppe" fill quality={72} sizes="(max-width: 900px) 100vw, 50vw" />
          </button>
        </div>
      </section>

      {/* ITINERARY */}
      <section className="itinerary">
        <div className="reveal">
          <span className="section-eyebrow">The Journey</span>
          <h2 className="section-title">Nine Days,<br /><em>One Lifetime</em></h2>
        </div>
        <div className="itinerary-grid">
          <div className="itin-card reveal">
            <span className="itin-days">1–3</span>
            <span className="itin-tag">Days 1 – 3</span>
            <h3 className="itin-title">Nomadic Life Immersion</h3>
            <p className="itin-desc">Travel from the capital into the countryside and be welcomed by your host family. Settle into traditional gers and begin learning daily nomadic life.</p>
            <ul className="itin-list">
              <li>Traditional ger accommodation</li>
              <li>Yak milking & daily routines</li>
              <li>Horse handling & riding practice</li>
              <li>Optional daily river ice baths</li>
              <li>Cultural exchange & shared meals</li>
              <li style={{opacity:1, color:'var(--gold)'}}>Optional: van day trip to nearby historic sites & waterfalls</li>
            </ul>
          </div>
          <div className="itin-card reveal reveal-delay-1">
            <span className="itin-days">4–7</span>
            <span className="itin-tag">Days 4 – 7</span>
            <h3 className="itin-title">Eight Lakes Horse Trek</h3>
            <p className="itin-desc">Four days on horseback through Mongolia&apos;s stunning Eight Lakes region. Remote camping under open skies, guided by experienced local horsemen.</p>
            <ul className="itin-list">
              <li>Daily multi-hour horseback riding</li>
              <li>Wilderness camping</li>
              <li>Alpine lakes, rivers & cold-water plunges</li>
              <li>Far from mass tourism</li>
            </ul>
          </div>
          <div className="itin-card reveal reveal-delay-2">
            <span className="itin-days">8–9</span>
            <span className="itin-tag">Days 8 – 9</span>
            <h3 className="itin-title">Village Return & Farewell</h3>
            <p className="itin-desc">Return to the village for rest, shared meals, and reflection. Organized transportation back to Bat-Ulzii included.</p>
            <ul className="itin-list">
              <li>Final meals with host family</li>
              <li>Rest & reflection</li>
              <li>Return transport to Bat-Ulzii</li>
            </ul>
          </div>
        </div>
      </section>

      {/* HOMEPAGE PHOTO COLLAGE */}
      <div className="main-album" id="homepage-photos" aria-label="8 Lakes Tours homepage photo collage">
        {MAIN_ALBUM_IMAGES.map((item) => (
          <div
            className={`main-album-item collage-${item.collage}${item.mobileFullWidth ? ' mobile-full-width' : ''}`}
            key={item.src}
          >
            <button
              type="button"
              className="image-button"
              aria-label={`View larger image: ${item.alt}`}
              onClick={() => openLightbox(item.src)}
            >
              <Image
                src={item.src}
                alt={item.alt}
                fill
                quality={70}
                sizes="(max-width: 900px) 50vw, 33vw"
                style={item.objectPosition ? { objectPosition: item.objectPosition } : undefined}
              />
            </button>
          </div>
        ))}
      </div>

      <section className="gallery-handoff">
        <div className="gallery-handoff-copy">
          <p>Want more photos?</p>
        </div>
        <a href="/gallery" className="btn-ghost">View Full Gallery</a>
      </section>
      {/* INCLUDED */}
      <section className="included">
        <div className="reveal">
          <h2 className="section-title">What&apos;s<br /><em>Included</em></h2>
          <p className="section-body" style={{marginBottom:'2rem'}}>Your group rate covers the full experience. No hidden costs.</p>
          <ul className="included-list">
            <li><span className="icon">✦</span> Transportation from Bat-Ulzii to the ger village & return</li>
            <li><span className="icon">✦</span> Host family accommodation (traditional gers)</li>
            <li><span className="icon">✦</span> 3 traditional Mongolian meals per day</li>
            <li><span className="icon">✦</span> Guided 4-day horseback trek</li>
            <li><span className="icon">✦</span> Horses & local expert guides</li>
            <li><span className="icon">✦</span> Cultural immersion activities</li>
          </ul>
        </div>
        <div className="reveal reveal-delay-1">
          <h2 className="section-title" style={{fontSize:'2rem'}}>Before<br /><em>You Arrive</em></h2>
          <p className="section-body" style={{marginBottom:'2rem'}}>A few essentials to arrange and pack before you arrive.</p>
          <ul className="included-list not">
            <li><span className="icon">✦</span> International flights</li>
            <li><span className="icon">✦</span> Travel insurance (required) — <a href="https://www.worldnomads.com" target="_blank" rel="noopener noreferrer" style={{color:'var(--gold)'}}>World Nomads</a></li>
            <li><span className="icon">✦</span> Warm sleeping bag & personal camping comfort items</li>
            <li><span className="icon">✦</span> Riding layers, waterproof shell & sturdy boots</li>
            <li><span className="icon">✦</span> Personal snacks, medication, first-aid kit, painkillers & toiletries</li>
            <li><span className="icon">✦</span> Cash for the local family payment and personal extras</li>
          </ul>
          <details className="packing-details">
            <summary className="packing-summary">Suggested Packing List</summary>
            <ul className="packing-grid">
              {PACKING_LIST.map(item => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </details>
          <details className="packing-details">
            <summary className="packing-summary">Getting There</summary>
            <ol className="getting-there-steps">
              <li><strong>Fly into Ulaanbaatar</strong>Arrive at Chinggis Khaan International Airport.</li>
              <li><strong>Bus to Bat-Ulzii, Uvurkhangai</strong>About 8 hours on a public bus through open countryside.</li>
              <li><strong>Family pickup</strong>Your hosts meet you in Bat-Ulzii and bring you to the ger village.</li>
            </ol>
            <p className="getting-there-note">Once your bus is booked, our team coordinates the timing and pickup with you.</p>
          </details>
          <div style={{marginTop:'2rem', padding:'1.2rem', background:'rgba(200,169,110,0.06)', borderLeft:'2px solid var(--gold)', borderRadius:'var(--radius-soft)'}}>
            <p style={{fontSize:'0.8rem', color:'var(--mist)', opacity:0.8, lineHeight:1.6}}>All participants must sign a liability waiver, provide proof of travel insurance, bring their own personal medical basics, and arrive mentally prepared for simple conditions, changing plans, physical discomfort, and group life in the wild.</p>
          </div>
        </div>
      </section>

      {/* TRUST */}
      <section className="trust" id="trust">
        <div className="trust-header reveal">
          <span className="section-eyebrow">From Past Guests</span>
          <h2 className="section-title">Built on<br /><em>Real Relationships</em></h2>
          <p className="section-body" style={{margin:'0 auto'}}>Real people have already made the journey into this valley. These are early guest impressions from the same world you&apos;ll be stepping into: the vastness and freedom of the steppe, and a nomadic way of life still attuned to it.</p>
        </div>
        <div className="testimonial-grid">
          {TESTIMONIAL_CARDS.map(testimonial => (
            <article className="testimonial-card reveal" key={testimonial.name}>
              <button
                type="button"
                className="image-button testimonial-photo"
                aria-label={`View larger image: ${testimonial.alt}`}
                onClick={() => openLightbox(testimonial.src)}
              >
                <Image src={testimonial.src} alt={testimonial.alt} fill quality={76} sizes="(max-width: 900px) 100vw, 33vw" style={{ objectPosition: testimonial.objectPosition ?? 'center' }} />
              </button>
              <div className="testimonial-body">
                <p className="testimonial-quote">“{testimonial.quote}”</p>
                <p className="testimonial-name">{testimonial.name}</p>
              </div>
            </article>
          ))}
        </div>
      </section>

      <div className="divider"><div className="divider-line"></div><div className="divider-ornament">✦</div><div className="divider-line"></div></div>

      {/* BOOKING */}
      <section className="booking" id="book">
        <div className="reveal">
          <span className="section-eyebrow">Reserve Your Spot</span>
          <h2 className="section-title">Choose 2026<br /><em>or Plan 2027</em></h2>
          <p className="section-body">Remaining 2026 departures stay visible while bookable, and you can select one and pay online straight away. 2027 small-group dates are being planned, and private June–September 2027 departures are open by request. The trip is $1,999 per person, and group rates apply for 3–8 guests. Our team confirms 2027 requests before payment.</p>
          <div className="scarcity-pill">
            <span style={{width:'7px', height:'7px', borderRadius:'50%', background:'var(--rust)', display:'inline-block', flexShrink:0}}></span>
            <span>Small groups only — each departure capped at 8 guests</span>
          </div>
          <div className="price-card" style={{marginTop:'2.5rem'}}>
            <span className="price-badge">2026 Trips &amp; 2027 Requests — Limited Availability</span>
            <div className="price-amount">${BASE_PRICE_USD.toLocaleString('en-US')}</div>
            <div className="price-per">Per Person · 9 Days / 8 Nights · Group rates apply for 3–8 guests</div>
            <div className="price-note">All official prices are in USD. Every currently available fixed 2026 departure can be booked and paid online for 1–8 guests. Groups of 1–8 book together and pay the exact group amount in one secure Stripe checkout. 2027 request options are personally confirmed before payment.</div>
            <div className="payment-split" aria-label="How the 8 Lakes Tours payment is split">
              <div className="payment-split-card">
                <span className="payment-split-label">Pay online</span>
                <span className="payment-split-amount">${BASE_ONLINE_PAYMENT_USD.toLocaleString('en-US')} pp</span>
                <p className="payment-split-copy">Reserves your place with 8 Lakes Tours.</p>
              </div>
              <div className="payment-split-arrow" aria-hidden="true">+</div>
              <div className="payment-split-card">
                <span className="payment-split-label">Pay locally</span>
                <span className="payment-split-amount">${BASE_LOCAL_FAMILY_PAYMENT_USD.toLocaleString('en-US')} pp</span>
                <p className="payment-split-copy">Clean USD cash paid directly to the nomadic host family in Mongolia.</p>
              </div>
            </div>
            <details className="payment-details">
              <summary className="payment-summary">See group rates (3–8 guests)</summary>
              <div className="group-rate-table" aria-label="8 Lakes Tours group rates">
                {GROUP_PRICING_TIERS.map(tier => {
                  const pricing = getGroupPricing(tier.min);
                  return (
                    <div className="group-rate-row" key={tier.label}>
                      <span>{tier.label}</span>
                      <div className="group-rate-price">
                        <strong>${tier.perPersonUsd.toLocaleString('en-US')} pp</strong>
                        <small>${pricing.onlinePerPersonUsd.toLocaleString('en-US')} online + ${pricing.localFamilyPerPersonUsd.toLocaleString('en-US')} locally</small>
                      </div>
                    </div>
                  );
                })}
              </div>
            </details>
            <details className="payment-details">
              <summary className="payment-summary">How payment works</summary>
              <div className="payment-detail-body">
                <p><strong>Online:</strong> reserves your place with 8 Lakes Tours. 2026 departures are paid in one Stripe checkout for your whole group (1–8 guests); our team confirms 2027 requests before payment.</p>
                <p><strong>Locally:</strong> clean USD cash paid directly to your host family, who can&apos;t reliably receive online transfers. Group discounts are split evenly between both payments.</p>
              </div>
            </details>
            <details className="payment-details">
              <summary className="payment-summary">Cancellation policy</summary>
              <div className="payment-detail-body">
                <p><strong>More than 21 days before departure:</strong> the online payment is refunded, minus unrecoverable Stripe/payment processing fees.</p>
                <p><strong>Within 21 days:</strong> you get 50% of the online booking payment back, minus unrecoverable Stripe/payment processing fees.</p>
                <p>Either way, we&apos;ll help with a date transfer or replacement traveller where we can.</p>
              </div>
            </details>
            <div className="price-spec-list">
              {[['Duration','9 Days / 8 Nights'],['Group Size','Max 8 Participants'],['Location','Orkhon Valley, Mongolia'],['Riding Level','Beginner – Intermediate']].map(([k,v]) => (
                <div key={k} className="price-spec-row">
                  <span>{k}</span><span>{v}</span>
                </div>
              ))}
            </div>
            <div className="ask-card">
              <h3>Not sure if this fits?</h3>
              <p>Ask before paying. We&apos;re happy to check riding level, food restrictions, route expectations, dates, or whether this is the right kind of adventure for you.</p>
              <a href="mailto:info@8lakestours.com?subject=Question%20before%20booking%208%20Lakes%20Tours">Ask a question first</a>
              <div className="ask-card-alt">
                <p>Prefer to stay with the host family and ride daily, without the full camping trek to Eight Lakes? We can plan a custom riding stay around your dates.</p>
                <a href="mailto:info@8lakestours.com?subject=Custom%20host-family%20riding%20stay">Ask about a riding-only stay</a>
              </div>
            </div>
          </div>
          <div className="tour-dates-card" id="tour-dates">
            <p className="tour-dates-heading" style={{fontSize:'0.6rem', letterSpacing:'0.3em', textTransform:'uppercase', color:'var(--gold)', marginBottom:'1rem'}}>Available Trips &amp; 2027 Interest</p>
            <div className="tour-date-list">
              {tourDates.map(dateOption => (
                <button
                  type="button"
                  className={`tour-date-row${dateOption.muted ? ' muted' : ''}${selectedTourDate === dateOption.date ? ' selected' : ''}`}
                  key={dateOption.date}
                  aria-pressed={selectedTourDate === dateOption.date}
                  aria-label={`Select ${dateOption.date} and continue to the booking form`}
                  onClick={() => chooseTourDate(dateOption.date)}
                >
                  <div>
                    <p className="tour-date-title">{dateOption.date}</p>
                    <p className="tour-date-detail">{dateOption.detail}</p>
                  </div>
                  <span className="tour-date-status">{dateOption.status}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="reveal reveal-delay-1" id="application">
          <span className="section-eyebrow">Booking Details</span>
          <h2 className="section-title" style={{fontSize:'2rem', marginBottom:'1rem'}}>Secure<br /><em>Your Place</em></h2>
          <p className="section-body" style={{fontSize:'0.9rem', marginBottom:'2rem'}}>Choose a fixed date or a 2027 request option and tell us who&apos;s coming. Bookings of 1–2 guests on a fixed date continue straight to payment after submitting. Scheduled groups of 1–8 pay the exact group amount in one checkout; private, custom, and 2027 requests are confirmed before payment.</p>
          <form ref={bookingFormRef} noValidate className="booking-form" onFocusCapture={markBookingFormStarted} onInput={event => { clearFieldValidation(event.target); scheduleDraftSave(event.currentTarget); }} onSubmit={async e => { e.preventDefault(); await submitBooking(e.currentTarget); }}>
            {validationErrors.length > 0 && <div className="booking-error-summary" role="alert" aria-labelledby="booking-error-summary-title"><strong id="booking-error-summary-title">Check the highlighted fields</strong><ul>{validationErrors.map(error => <li key={`${error.id}-${error.message}`}><button type="button" onClick={() => { const field = document.getElementById(error.id); field?.focus({ preventScroll: true }); field?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' }); }}>{error.message}</button></li>)}</ul></div>}
            <input type="hidden" name="display_currency" value={pricing.currency} />
            <input type="hidden" name="display_tour_price" value={pricing.tourPrice} />
            <input type="hidden" name="display_online_payment" value={pricing.onlinePayment} />
            <input type="hidden" name="display_local_family_payment" value={pricing.localFamilyPayment} />
            <fieldset className="form-fields" disabled={formSubmitted || formSubmitting}>
            <div className="form-section">
              <p className="form-section-title">Personal information</p>
              <div className="form-grid compact-grid">
                <div className="form-group"><label className="form-label" htmlFor="first_name">Passport/Legal First Name</label><input id="first_name" className="form-input" name="first_name" type="text" placeholder="First name" maxLength={100} required /></div>
                <div className="form-group"><label className="form-label" htmlFor="last_name">Passport/Legal Last Name</label><input id="last_name" className="form-input" name="last_name" type="text" placeholder="Last name" maxLength={100} required /></div>
              </div>
              <div className="form-group"><label className="form-label" htmlFor="email">Email Address — Required for Confirmation</label><input id="email" className="form-input" name="email" type="email" placeholder="you@example.com" value={email} onChange={e => setEmail(e.target.value)} maxLength={254} required /></div>
              <div className="form-grid compact-grid">
                <div className="form-group"><label className="form-label" htmlFor="phone">Phone Number</label><input id="phone" className="form-input" name="phone" type="tel" placeholder="+1 (555) 000-0000" maxLength={40} /></div>
                <div className="form-group"><label className="form-label" htmlFor="nationality">Nationality</label><input id="nationality" className="form-input" name="nationality" type="text" placeholder="e.g. American" maxLength={80} required /></div>
              </div>
              <div className="form-grid compact-grid">
                <DateOfBirthFields name="date_of_birth" label="Date of Birth" isLead />
                <div className="form-group"><label className="form-label" htmlFor="gender">Gender</label><input id="gender" className="form-input" name="gender" type="text" placeholder="e.g. Female" maxLength={40} required /></div>
              </div>
              <div className="form-group"><label className="form-label" htmlFor="dietary_restrictions">Dietary Restrictions</label><input id="dietary_restrictions" className="form-input" name="dietary_restrictions" type="text" placeholder="None, vegetarian, allergies, serious dairy/lactose issues, etc." maxLength={1000} /></div>
              <div className="form-group"><label className="form-label" htmlFor="emergency_contact">Emergency Contact (Name & Phone)</label><input id="emergency_contact" className="form-input" name="emergency_contact" type="text" placeholder="Name · Phone number" maxLength={200} /></div>
            </div>

            <div className="form-section">
              <p className="form-section-title">Trip details</p>
              <div className="form-grid compact-grid">
                <div className="form-group">
                  <label className="form-label" htmlFor="riding_experience">Riding Experience</label>
                  <select id="riding_experience" className="form-select" name="riding_experience" required>
                    <option value="">Select level</option>
                    <option>Beginner — little to none</option>
                    <option>Intermediate — comfortable riding</option>
                    <option>Advanced — experienced rider</option>
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="tour_date">Preferred Tour Date</label>
                  <select id="tour_date" className="form-select" name="tour_date" required value={selectedTourDate} onChange={e => { tourDateTouchedRef.current = true; setSelectedTourDate(e.target.value); }}>
                    {!selectedTourDate && <option value="">Select date</option>}
                    {tourDateOptions.map(dateOption => (
                      <option key={dateOption} value={dateOption}>{dateOption}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="guest_count">Guests booking together</label>
                <select id="guest_count" className="form-select" name="guest_count" value={guestCount} onChange={e => { const next = clampGuestCount(e.target.value); setGuestCount(next); setTravellerAnnouncement(`${next} traveller section${next === 1 ? '' : 's'} ready.`); }}>
                  {Array.from({ length: MAX_GROUP_SIZE }, (_, index) => index + 1).map(count => (
                    <option key={count} value={count}>{count} guest{count === 1 ? '' : 's'}</option>
                  ))}
                </select>
              </div>
              <p className="sr-only" aria-live="polite" aria-atomic="true">{travellerAnnouncement}</p>
              <div className="group-pricing-card" aria-live="polite">
                <div>
                  <p className="group-pricing-eyebrow">Private group pricing</p>
                  <strong>{pricing.tourPrice} per person</strong>
                  <small>{groupPricing.tier.label}{groupPricing.perPersonSavingsUsd > 0 ? ` · save $${groupPricing.perPersonSavingsUsd} pp` : ' · standard rate'}</small>
                </div>
                <div>
                  <span>{groupPricing.guestCount} guest{groupPricing.guestCount === 1 ? '' : 's'} total</span>
                  <strong>${groupPricing.totalTripValueUsd.toLocaleString('en-US')}</strong>
                  <small>${groupPricing.onlinePaymentUsd.toLocaleString('en-US')} online · ${groupPricing.localFamilyPaymentUsd.toLocaleString('en-US')} cash to family</small>
                </div>
              </div>
              <input type="hidden" name="price_per_person_usd" value={groupPricing.perPersonUsd} />
              <input type="hidden" name="online_payment_usd" value={groupPricing.onlinePaymentUsd} />
              <input type="hidden" name="local_family_payment_usd" value={groupPricing.localFamilyPaymentUsd} />
              <input type="hidden" name="total_trip_value_usd" value={groupPricing.totalTripValueUsd} />
              {Array.from({ length: guestCount - 1 }, (_, index) => {
                const travellerNumber = index + 2;
                const fieldPrefix = `travellers.${index + 1}`;
                return (
                  <fieldset className="companion-fields form-section" key={fieldPrefix}>
                    <legend className="form-section-title">Traveller {travellerNumber}</legend>
                    <p className="section-body" style={{fontSize:'0.78rem', marginBottom:'1rem'}}>Enter names exactly as shown on this traveller&apos;s passport.</p>
                    <div className="form-grid compact-grid">
                      <div className="form-group"><label className="form-label" htmlFor={`${fieldPrefix}.first_name`}>Passport/Legal First Name</label><input id={`${fieldPrefix}.first_name`} className="form-input" name={`travellers.${index + 1}.first_name`} type="text" maxLength={100} required /></div>
                      <div className="form-group"><label className="form-label" htmlFor={`${fieldPrefix}.last_name`}>Passport/Legal Last Name</label><input id={`${fieldPrefix}.last_name`} className="form-input" name={`travellers.${index + 1}.last_name`} type="text" maxLength={100} required /></div>
                    </div>
                    <div className="form-grid compact-grid">
                      <DateOfBirthFields name={`travellers.${index + 1}.date_of_birth`} label="Date of Birth" />
                      <div className="form-group"><label className="form-label" htmlFor={`${fieldPrefix}.nationality`}>Nationality</label><input id={`${fieldPrefix}.nationality`} className="form-input" name={`travellers.${index + 1}.nationality`} type="text" maxLength={80} required /></div>
                    </div>
                    <div className="form-grid compact-grid">
                      <div className="form-group">
                        <label className="form-label" htmlFor={`${fieldPrefix}.riding_experience`}>Riding Experience</label>
                        <select id={`${fieldPrefix}.riding_experience`} className="form-select" name={`travellers.${index + 1}.riding_experience`} required>
                          <option value="">Select level</option>
                          <option>Beginner — little to none</option>
                          <option>Intermediate — comfortable riding</option>
                          <option>Advanced — experienced rider</option>
                        </select>
                      </div>
                      <div className="form-group"><label className="form-label" htmlFor={`${fieldPrefix}.gender`}>Gender</label><input id={`${fieldPrefix}.gender`} className="form-input" name={`travellers.${index + 1}.gender`} type="text" placeholder="e.g. Male" maxLength={40} required /></div>
                    </div>
                    <div className="form-grid compact-grid">
                      <div className="form-group"><label className="form-label" htmlFor={`${fieldPrefix}.email`}>Email (Optional)</label><input id={`${fieldPrefix}.email`} className="form-input" name={`travellers.${index + 1}.email`} type="email" maxLength={254} /></div>
                      <div className="form-group"><label className="form-label" htmlFor={`${fieldPrefix}.phone`}>Phone (Optional)</label><input id={`${fieldPrefix}.phone`} className="form-input" name={`travellers.${index + 1}.phone`} type="tel" maxLength={40} /></div>
                    </div>
                    <div className="form-group"><label className="form-label" htmlFor={`${fieldPrefix}.dietary_notes`}>Dietary Notes (Optional)</label><input id={`${fieldPrefix}.dietary_notes`} className="form-input" name={`travellers.${index + 1}.dietary_notes`} type="text" maxLength={1000} /></div>
                  </fieldset>
                );
              })}
              {guestCount > 1 && (
                <label style={{display:'flex', gap:'0.7rem', alignItems:'flex-start', color:'var(--mist)', fontSize:'0.76rem', lineHeight:1.55, cursor:'pointer'}}>
                  <input type="checkbox" name="companion_details_permission" value="on" required style={{marginTop:'0.2rem', accentColor:'var(--gold)'}} />
                  <span>I am the lead booker supplying my companions&apos; details for trip operations, and I have their permission to provide these details. My typed waiver below is my agreement only, not a waiver signed for any companion.</span>
                </label>
              )}
              <div className="form-group"><label className="form-label" htmlFor="how_heard">How did you hear about us?</label><input id="how_heard" className="form-input" name="how_heard" type="text" placeholder="Instagram, ChatGPT, friend, Google, retreat group, etc." maxLength={200} /></div>
              <div className="form-group"><label className="form-label" htmlFor="notes">Special Notes or Questions</label><textarea id="notes" className="form-textarea" name="notes" placeholder="Anything else we should know?" maxLength={2000}></textarea></div>
            </div>

            {/* Collapsible Waiver */}
            <div style={{border:'1px solid rgba(200,169,110,0.2)', borderRadius:'var(--radius-soft)', overflow:'hidden'}}>
              <button
                type="button"
                onClick={() => setWaiverExpanded(v => !v)}
                style={{width:'100%', display:'flex', justifyContent:'space-between', alignItems:'center', padding:'0.9rem 1.1rem', background:'rgba(200,169,110,0.05)', border:'none', cursor:'pointer', textAlign:'left'}}
              >
                <span style={{fontSize:'0.65rem', letterSpacing:'0.25em', textTransform:'uppercase', color:'var(--gold)'}}>Read Liability Waiver</span>
                <span style={{fontSize:'0.75rem', color:'var(--gold)', transition:'transform 0.3s', display:'inline-block', transform: waiverExpanded ? 'rotate(180deg)' : 'rotate(0deg)'}}>▼</span>
              </button>
              {waiverExpanded && (
                <div style={{padding:'1.2rem 1.4rem', fontSize:'0.8rem', color:'var(--mist)', lineHeight:1.8, borderTop:'1px solid rgba(200,169,110,0.15)', maxHeight:'320px', overflowY:'auto'}}>
                  <p style={{marginBottom:'0.8rem'}}>Please read this waiver carefully. The typed signature records the lead booker&apos;s agreement only and is not a waiver on behalf of any companion. By signing below, you acknowledge and agree to the following terms for yourself:</p>
                  {[
                    ['1. Nature of Activity', '8 Lakes Tours operates multi-day horseback trekking expeditions in remote wilderness areas of Mongolia. These activities take place in the Orkhon Valley and surrounding steppe, far from medical facilities, emergency services, and modern infrastructure. Participants acknowledge that this is an inherently adventurous and physically demanding experience.'],
                    ['2. Horseback Riding Risks', 'Horseback riding carries inherent risks including, but not limited to: falling from or being thrown by a horse, being kicked or bitten, collision with obstacles, and unpredictable animal behaviour. Horses are living animals and may react in unexpected ways regardless of rider experience. Participants ride at their own risk and must follow all instructions from their guide at all times.'],
                    ['3. Remote Wilderness Travel', 'Travel takes place in remote, off-grid terrain with no road access, no mobile phone coverage, and no nearby emergency services. In the event of injury or illness, evacuation may take many hours or longer. Participants must be in adequate physical health to undertake the journey and must disclose any pre-existing medical conditions to their guide prior to departure.'],
                    ['4. Medical Emergencies', '8 Lakes Tours and its guides carry basic first aid supplies but are not medical professionals. In the event of a serious medical emergency, all costs associated with evacuation, treatment, and repatriation are the sole responsibility of the participant. 8 Lakes Tours accepts no liability for injury, illness, or death arising from participation in this tour.'],
                    ['5. Travel Insurance Requirement', 'Comprehensive travel insurance is mandatory for all participants. Your policy must include coverage for: emergency medical treatment, emergency evacuation and repatriation, horseback riding and adventure activities, and trip cancellation or interruption. 8 Lakes Tours reserves the right to deny participation to anyone without adequate coverage.'],
                    ['6. Release of Liability', 'In consideration of being permitted to participate in this tour, I hereby release, waive, discharge, and covenant not to sue 8 Lakes Tours, its guides, the host family, their agents, employees, and representatives from any and all liability, claims, demands, or causes of action arising out of or related to any loss, damage, injury, or death, whether caused by negligence or otherwise, that may be sustained by me while participating in this tour.'],
                    ['7. Assumption of Risk', 'I expressly acknowledge and assume all risks associated with this tour, including those resulting from the actions, inactions, or negligence of 8 Lakes Tours or any other party. I confirm that I am physically and mentally capable of participating in this activity, that I have not been advised otherwise by a medical professional, and that I undertake this activity entirely at my own risk.'],
                  ].map(([heading, body]) => (
                    <div key={heading} style={{marginTop:'0.9rem'}}>
                      <p style={{fontSize:'0.6rem', letterSpacing:'0.2em', textTransform:'uppercase', color:'var(--gold)', marginBottom:'0.3rem'}}>{heading}</p>
                      <p>{body}</p>
                    </div>
                  ))}
                  <p style={{marginTop:'0.9rem', fontStyle:'italic', opacity:0.7}}>This waiver is binding upon myself, my heirs, executors, administrators, and assigns. I have read this document in full and understand its contents.</p>
                </div>
              )}
            </div>

            <div style={{marginTop:'1rem'}}>
              <label htmlFor="signature" style={{fontSize:'0.65rem', letterSpacing:'0.2em', textTransform:'uppercase', color:'var(--gold)', display:'block', marginBottom:'0.5rem'}}>Digital Signature — Type Your Full Name</label>
              <input
                id="signature"
                className="form-input signature-input"
                type="text"
                name="signature"
                maxLength={150}
                required
                value={signature}
                onChange={e => setSignature(e.target.value)}
                placeholder="Your full name"
                style={{width:'100%', background:'rgba(255,255,255,0.04)', border:'1px solid rgba(200,169,110,0.3)', borderRadius:'var(--radius-soft)', padding:'0.7rem 1rem', color:'var(--cream)', fontSize:'0.95rem', fontFamily:"var(--font-cormorant), 'Cormorant Garamond', serif", fontStyle:'italic', outline:'none', boxSizing:'border-box'}}
              />
              <p style={{fontSize:'0.7rem', color:'var(--mist)', opacity:0.5, marginTop:'0.4rem', lineHeight:1.5}}>By typing your name you confirm that you, as the lead booker, have read and agree to the liability waiver for yourself only. This does not create a companion waiver.</p>
            </div>
            <label style={{display:'flex', gap:'0.7rem', alignItems:'flex-start', marginTop:'1rem', color:'var(--mist)', fontSize:'0.76rem', lineHeight:1.55, cursor:'pointer'}}>
              <input type="checkbox" name="newsletter_opt_in" value="on" style={{marginTop:'0.2rem', accentColor:'var(--gold)'}} />
              <span>Yes, email me occasional 8 Lakes Tours news, new dates, offers, deals, field notes, and business updates. This is optional and I can unsubscribe at any time.</span>
            </label>
            </fieldset>

            {/* Submit booking to ops */}
            {!formSubmitted || formSubmitting ? (
              <button
                type="submit"
                disabled={!hasRequiredContact || formSubmitting}
                className="submit-btn"
                style={{marginTop:'0.5rem', opacity: hasRequiredContact ? 1 : 0.4, transition:'opacity 0.3s', cursor: hasRequiredContact ? 'pointer' : 'not-allowed'}}
              >
                {formSubmitting && <span className="booking-save-spinner" aria-hidden="true" />}
                {formSubmitting ? (requiresHumanConfirmation ? 'Sending your request…' : 'Preparing your secure checkout…') : awaitsGroupInvoice ? 'Request Your Group Invoice' : requiresHumanConfirmation ? 'Submit Availability Request' : `Book & pay $${groupPricing.onlinePaymentUsd.toLocaleString('en-US')} USD`}
              </button>
            ) : (
              <div style={{marginTop:'0.5rem', padding:'0.9rem 1rem', background:'rgba(200,169,110,0.08)', border:'1px solid rgba(200,169,110,0.3)', borderRadius:'var(--radius-soft)', textAlign:'center'}}>
                <p style={{fontSize:'0.7rem', letterSpacing:'0.2em', textTransform:'uppercase', color:'var(--gold)'}}>{awaitsGroupInvoice ? 'Request received — our team will email your invoice' : requiresHumanConfirmation ? 'Request received — our team will confirm availability before payment' : 'Payment pending — your place is not yet confirmed'}</p>
                {bookingReference && <p style={{fontSize:'0.68rem', color:'rgba(245,240,232,0.62)', marginTop:'0.4rem'}}>Reference: {bookingReference}</p>}
              </div>
            )}
            <p role="status" aria-live="polite">{formSubmitting ? (requiresHumanConfirmation ? 'Sending your request…' : 'Preparing your secure checkout…') : formSubmitted && requiresHumanConfirmation ? 'Request received. Awaiting availability confirmation.' : ''}</p>
            {formError && <p className="form-error" role="alert">{formError}</p>}

            <div className="payment-checkout-card">
              <p className="checkout-eyebrow">Online Reservation Payment</p>
              {awaitsGroupInvoice ? (
                <p className="checkout-copy">
                  Groups of 3–8 pay together on one invoice. Submit the form and our team will email one invoice for <strong>{formatApproxUsd(groupPricing.onlinePaymentUsd, pricing.currency)}</strong> covering all {groupPricing.guestCount} guests, so nobody has to pay separately.
                </p>
              ) : requiresHumanConfirmation ? (
                <p className="checkout-copy">
                  Our team will confirm your date, horses, guide and host family, then email your secure payment link.
                </p>
              ) : (
                <p className="checkout-copy">
                  Submit the booking form with a valid email first, then pay <strong>{formatApproxUsd(groupPricing.onlinePaymentUsd, pricing.currency)} online</strong> for {groupPricing.guestCount} guest{groupPricing.guestCount === 1 ? '' : 's'} to reserve your place. The host-family cash portion is handled in Mongolia.
                </p>
              )}
              <p className="checkout-note">
                Prices are in USD. Your card may show a converted amount.
              </p>
              {!requiresHumanConfirmation ? (
                <div
                  className="checkout-button-wrap stripe-embed-wrap"
                  aria-disabled={!canPay}
                  onMouseDown={trackStripePaymentClick}
                  onTouchStart={trackStripePaymentClick}
                >
                  <p className="stripe-preview-amount">${groupPricing.onlinePaymentUsd.toLocaleString('en-US')} USD <span>{groupPricing.guestCount} guest{groupPricing.guestCount === 1 ? '' : 's'}</span></p>
                  <a
                    className="stripe-link-fallback"
                    href={checkoutFallbackHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-disabled={!canPay}
                    tabIndex={canPay ? 0 : -1}
                    onClick={event => {
                      if (!canPay) event.preventDefault();
                      else trackStripePaymentClick();
                    }}
                  >
                    Open Stripe checkout
                  </a>
                  {!canPay && (
                    <div
                      className="checkout-lock-overlay"
                      onClick={e => { e.stopPropagation(); }}
                    >
                      <p>
                        {!emailIsValid ? 'Please enter a valid email address above' : !signatureIsValid ? 'Please type your full name as a signature above' : 'Submit your booking before payment'}
                      </p>
                    </div>
                  )}
                </div>
              ) : (
                <div className="group-request-next-step">
                  <strong>No charge yet.</strong>
                  <span>You only pay once your date is confirmed.</span>
                </div>
              )}
            </div>
            <p style={{fontSize:'0.72rem', color:'var(--mist)', opacity:0.58, textAlign:'center', lineHeight:1.6}}>{requiresHumanConfirmation ? 'We\'ll reply by email with availability.' : 'Your booking is confirmed once the online payment is completed. If anything needs checking, we\'ll contact you directly.'}</p>
            <p style={{fontSize:'0.7rem', color:'var(--mist)', opacity:0.4, textAlign:'center', lineHeight:1.6, marginTop:'0.5rem'}}>
              By submitting this form you agree to our{' '}
              <a href="/terms" style={{color:'var(--gold)', opacity:0.7, textDecoration:'underline', textUnderlineOffset:'3px'}}>Terms &amp; Conditions</a>
              {' '}and{' '}
              <a href="/privacy" style={{color:'var(--gold)', opacity:0.7, textDecoration:'underline', textUnderlineOffset:'3px'}}>Privacy Policy</a>.
              Your data will be used to process your booking enquiry and send relevant transactional trip and preparation updates. Marketing emails are sent only if you select the optional newsletter checkbox above.
            </p>
          </form>
        </div>
      </section>

      {/* FAQ */}
      <section className="faq-section">
        <div style={{maxWidth:'760px', margin:'0 auto'}}>
          <div className="reveal" style={{marginBottom:'2.5rem'}}>
            <span className="section-eyebrow">FAQ</span>
            <h2 className="section-title">Common<br /><em>Questions</em></h2>
          </div>
          {HOME_FAQS.map(({q, a}, i) => {
            const isOpen = openFaqIndex === i;
            const panelId = `home-faq-panel-${i}`;
            return (
              <div key={i} className={`faq-item reveal${isOpen ? ' is-open' : ''}`}>
                <button
                  type="button"
                  className="faq-question"
                  aria-expanded={isOpen}
                  aria-controls={panelId}
                  onClick={() => setOpenFaqIndex(current => current === i ? null : i)}
                >
                  <span>{q}</span>
                  <span className="faq-toggle" aria-hidden="true" />
                </button>
                <div id={panelId} className="faq-panel">
                  <div className="faq-panel-inner">
                    <p className="faq-answer">{a}</p>
                  </div>
                </div>
              </div>
            );
          })}
          <div style={{borderTop:'1px solid rgba(200,169,110,0.15)'}} />
          <a href="/faq" className="faq-see-all">See all questions →</a>
          <div className="faq-practical-link reveal">
            <span>Need the full practical details?</span>
            <p>Read the preparation guide for packing, weather, food, toilets, insurance, and cancellation terms.</p>
            <a href="/preparation">Open preparation guide</a>
          </div>
        </div>
      </section>

      {/* CONTACT */}
      <section className="contact-section">
        <div className="contact-layout">
          <div className="contact-intro reveal">
            <span className="section-eyebrow">Get In Touch</span>
            <h2 className="section-title">Have a<br /><em>Question?</em></h2>
            <p className="section-body">We&apos;re happy to answer anything before you book — whether it&apos;s about the route, the horses, visa requirements, or packing. Reach out and we&apos;ll get back to you promptly.</p>
            <div className="contact-cards">
              <a className="contact-card" href="mailto:info@8lakestours.com">
                <span className="contact-card-icon" aria-hidden="true">✉</span>
                <span className="contact-card-text">
                  <span className="contact-card-label">Email</span>
                  <span className="contact-card-value">info@8lakestours.com</span>
                </span>
              </a>
              <a className="contact-card" href="https://www.instagram.com/8lakestours" target="_blank" rel="noopener noreferrer">
                <span className="contact-card-icon"><svg className="instagram-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><rect x="2.5" y="2.5" width="19" height="19" rx="5.5" /><circle cx="12" cy="12" r="4.2" /><circle cx="17.6" cy="6.4" r="1.15" fill="currentColor" stroke="none" /></svg></span>
                <span className="contact-card-text">
                  <span className="contact-card-label">Instagram</span>
                  <span className="contact-card-value">@8lakestours</span>
                </span>
              </a>
            </div>
          </div>
          <div className="lead-card-public reveal">
            <h3>Join the newsletter</h3>
            <p>Get occasional 8 Lakes Tours news, offers, deals, new dates, blog posts, field notes, and behind-the-scenes updates from the business.</p>
            <form className="lead-form" onSubmit={submitLead}>
              <input
                type="text"
                name="name"
                placeholder="Name — optional"
                value={leadName}
                onChange={event => setLeadName(event.target.value)}
                autoComplete="name"
              />
              <input
                type="email"
                name="email"
                placeholder="Email address"
                value={leadEmail}
                onChange={event => setLeadEmail(event.target.value)}
                autoComplete="email"
                required
              />
              <button type="submit" disabled={leadStatus === 'saving' || leadStatus === 'saved'}>
                {leadStatus === 'saving' ? 'Saving…' : leadStatus === 'saved' ? 'Saved' : 'Join the list'}
              </button>
            </form>
            {leadStatus === 'saved' && <p className="lead-message">✓ You&apos;re on the list. We&apos;ll send only relevant trip notes and updates.</p>}
            {leadStatus === 'error' && <p className="lead-message error">{leadError}</p>}
            <p className="lead-privacy">Booking guests can receive relevant trip preparation notes after booking. Newsletter subscribers receive occasional 8 Lakes Tours updates, offers, deals, blog posts, and field notes. No spam — opt out by replying to any email.</p>
          </div>
        </div>
      </section>



      <footer>
        <div className="footer-inner">
          <div>
            <div className="footer-kicker">Mongolia · Small-group horseback expeditions</div>
            <div className="footer-logo">8 Lakes<br />Tours</div>
            <div className="footer-tagline">A horseback journey through the Orkhon Valley and Eight Lakes region.</div>
            <a className="footer-cta" href="#application">Reserve a Spot</a>
          </div>
          <nav className="footer-links" aria-label="Footer navigation">
            <a className="footer-link" href="https://www.instagram.com/8lakestours" target="_blank" rel="noopener noreferrer">Instagram</a>
            <a className="footer-link" href="/gallery">Gallery</a>
            <a className="footer-link" href="/about">About</a>
            <a className="footer-link" href="/preparation">Preparation</a>
            <a className="footer-link" href="/faq">FAQ</a>
            <a className="footer-link" href="/contact">Contact</a>
            <a className="footer-link" href="/terms">Terms</a>
            <a className="footer-link" href="/privacy">Privacy</a>
            <button className="footer-link privacy-choices-link" type="button" onClick={() => window.dispatchEvent(new Event('eight-lakes:open-privacy-choices'))}>Privacy choices</button>
          </nav>
        </div>
        <div className="footer-note">
          <span>© 2026 8 Lakes Tours. All rights reserved.</span>
          <span>Built for direct local family partnership in Mongolia.</span>
        </div>
      </footer>

      {lightboxImage && (
        <div className="lightbox" role="dialog" aria-modal="true" aria-label={lightboxImage.alt} onClick={() => setLightboxIndex(null)}>
          <button type="button" className="lightbox-close" onClick={event => { event.stopPropagation(); setLightboxIndex(null); }} aria-label="Close expanded image">×</button>
          <button type="button" className="lightbox-nav lightbox-prev" onClick={event => { event.stopPropagation(); showPreviousImage(); }} aria-label="Previous image">‹</button>
          <div className="lightbox-frame" onClick={event => event.stopPropagation()}>
            {/* eslint-disable-next-line @next/next/no-img-element -- Lightbox uses direct local originals so adjacent-photo preloading makes next/prev feel instant. */}
            <img className="lightbox-image" src={lightboxImage.src} alt={lightboxImage.alt} decoding="async" />
          </div>
          <button type="button" className="lightbox-nav lightbox-next" onClick={event => { event.stopPropagation(); showNextImage(); }} aria-label="Next image">›</button>
        </div>
      )}

      {showWaiver && <WaiverModal onClose={() => setShowWaiver(false)} onAgree={() => setShowWaiver(false)} />}

    </>
  );
}
