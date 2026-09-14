import type { MetadataRoute } from 'next'

const siteUrl = 'https://www.8lakestours.com'
const lastModified = new Date('2026-06-18')

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: siteUrl,
      lastModified,
      changeFrequency: 'monthly',
      priority: 1,
      images: [
        `${siteUrl}/images/hero-horseback.jpg`,
        `${siteUrl}/images/og-8-lakes-horseback-2026.jpg`,
        `${siteUrl}/images/rob-family.jpg`,
        `${siteUrl}/images/rob-zaher.jpg`,
        `${siteUrl}/images/lake.jpg`,
        `${siteUrl}/images/gallery-extra/horseback-storm-valley-pov.jpg`,
      ],
    },
    {
      url: `${siteUrl}/about`,
      lastModified,
      changeFrequency: 'monthly',
      priority: 0.8,
      images: [
        `${siteUrl}/images/og-8-lakes-about-family-2026.jpg`,
        `${siteUrl}/videos/eagle-soaring-poster.jpg`,
        `${siteUrl}/images/rob-zaher-host-deel.jpg`,
      ],
    },
    {
      url: `${siteUrl}/faq`,
      lastModified,
      changeFrequency: 'monthly',
      priority: 0.8,
    },
    {
      url: `${siteUrl}/preparation`,
      lastModified,
      changeFrequency: 'monthly',
      priority: 0.78,
      images: [
        `${siteUrl}/images/og-8-lakes-horseback-2026.jpg`,
        `${siteUrl}/images/hero-horseback.jpg`,
      ],
    },
    {
      url: `${siteUrl}/gallery`,
      lastModified,
      changeFrequency: 'monthly',
      priority: 0.75,
      images: [
        `${siteUrl}/images/og-8-lakes-gallery-2026.jpg`,
        `${siteUrl}/images/gallery-extra/packed-horses-rain-camp.jpg`,
        `${siteUrl}/images/gallery-extra/horseback-storm-valley-pov.jpg`,
      ],
    },
    {
      url: `${siteUrl}/contact`,
      lastModified,
      changeFrequency: 'monthly',
      priority: 0.7,
    },
    {
      url: `${siteUrl}/terms`,
      lastModified,
      changeFrequency: 'yearly',
      priority: 0.2,
    },
    {
      url: `${siteUrl}/privacy`,
      lastModified,
      changeFrequency: 'yearly',
      priority: 0.2,
    },
  ]
}
