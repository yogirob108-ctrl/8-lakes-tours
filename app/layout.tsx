import type { Metadata, Viewport } from "next";
import { Cormorant_Garamond, Jost } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import Script from "next/script";
import "./globals.css";
import GoogleConsentBanner from "./components/GoogleConsentBanner";
import { GOOGLE_CONSENT_DEFAULTS } from "@/lib/google-consent.mjs";

const cormorant = Cormorant_Garamond({
  variable: "--font-cormorant",
  subsets: ["latin"],
  weight: ["300", "400"],
  style: ["normal", "italic"],
  display: "swap",
});

const jost = Jost({
  variable: "--font-jost",
  subsets: ["latin"],
  weight: ["300", "400", "500"],
  display: "swap",
});

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export const metadata: Metadata = {
  metadataBase: new URL("https://www.8lakestours.com"),
  applicationName: "8 Lakes Tours",
  title: {
    default: "Mongolia Horse Trekking & Horseback Riding | 8 Lakes Tours",
    template: "%s | 8 Lakes Tours",
  },
  description: "Horseback riding in Mongolia: a 9-day horse trek through the Orkhon Valley to the Eight Lakes with a nomadic family. Ger stays, small groups, beginners welcome.",
  authors: [{ name: "8 Lakes Tours", url: "https://www.8lakestours.com" }],
  creator: "8 Lakes Tours",
  publisher: "8 Lakes Tours",
  category: "Adventure Travel",
  keywords: [
    "Mongolian horse trekking",
    "Mongolian horse trekking tour",
    "horse trekking Mongolia",
    "Mongolia horse trekking",
    "Naiman Nuur tour",
    "Eight Lakes Mongolia",
    "Orkhon Valley travel",
    "nomadic experience Mongolia",
    "horse riding Mongolia",
    "Mongolia adventure travel",
    "ethical tourism Mongolia",
    "Mongolian nomad homestay",
    "Mongolia cultural tour",
    "horseback riding Mongolia",
    "Mongolia wilderness trek",
    "Uvurkhangai Mongolia tour",
    "Mongolia sustainable travel",
    "authentic Mongolia travel",
    "Mongolia steppe expedition",
    "nomadic horse trek",
    "Mongolia family tour",
  ],
  alternates: {
    canonical: "https://www.8lakestours.com",
    languages: {
      "en": "https://www.8lakestours.com",
      "x-default": "https://www.8lakestours.com",
    },
  },
  openGraph: {
    title: "Mongolia Horse Trekking & Horseback Riding | 8 Lakes Tours",
    description: "Mongolian horse trekking through the Naiman Nuur region and Orkhon Valley on a 9-day immersive journey hosted by a Mongolian nomadic family. Ethical, authentic, unforgettable.",
    type: "website",
    locale: "en_US",
    url: "https://www.8lakestours.com",
    siteName: "8 Lakes Tours",
    images: [
      {
        url: "/images/og-8-lakes-horseback-2026.jpg",
        width: 1200,
        height: 630,
        alt: "Mongolian rider on horseback above the Eight Lakes region — 8 Lakes Tours",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Mongolia Horse Trekking & Horseback Riding | 8 Lakes Tours",
    description: "A 9-day Mongolian horse trekking expedition through Mongolia's Eight Lakes region. Stay with a nomadic family, ride the steppe, experience real Mongolian life.",
    images: ["/images/og-8-lakes-horseback-2026.jpg"],
  },
  icons: {
    icon: [
      { url: '/favicon.ico' },
      { url: '/favicon-16x16.png', sizes: '16x16', type: 'image/png' },
      { url: '/favicon-32x32.png', sizes: '32x32', type: 'image/png' },
    ],
    apple: [{ url: '/apple-touch-icon.png' }],
    other: [
      { rel: 'manifest', url: '/site.webmanifest' },
    ],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
  formatDetection: {
    email: false,
    address: false,
    telephone: false,
  },
  verification: {
    google: "k5qDX-okMY6hJL4MNVs5Pv0ZkTIPI-uWg9bl-TigS4o",
    other: {
      "p:domain_verify": "ca65fe08ef13a1c45a4935cc5d46c33a",
      "msvalidate.01": "1111709448E6DDB53AF95F5F5509D579",
    },
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${cormorant.variable} ${jost.variable} h-full antialiased`}
    >
      <head>
        <link rel="alternate" type="text/plain" href="/llms.txt" title="8 Lakes Tours AI reference" />
        <link rel="alternate" type="text/plain" href="/llms-full.txt" title="8 Lakes Tours full AI reference" />
      </head>
      <body className="min-h-full flex flex-col">
        <Script id="google-consent-defaults" strategy="beforeInteractive">{`
          window.dataLayer = window.dataLayer || [];
          function gtag(){dataLayer.push(arguments);}
          window.gtag = window.gtag || gtag;
          gtag('consent', 'default', ${JSON.stringify(GOOGLE_CONSENT_DEFAULTS)});
          gtag('set', 'ads_data_redaction', true);
          gtag('set', 'url_passthrough', true);
        `}</Script>
        {children}
        <Analytics />
        <SpeedInsights />
        <GoogleConsentBanner />
        <Script src="https://www.googletagmanager.com/gtag/js?id=G-E9PW7T08LZ" strategy="lazyOnload" />
        <Script id="google-analytics" strategy="lazyOnload">{`
          gtag('js', new Date());
          gtag('config', 'G-E9PW7T08LZ', { allow_google_signals: false });
        `}</Script>
      </body>
    </html>
  );
}
