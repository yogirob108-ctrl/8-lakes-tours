# Review: pricing copy and solo-booking policy (2026-10-22 commits)

Commits 209c186..c3480f5, all by Robert Zaher. Copy-only; no Stripe, env, or booking-gating code touched.

- Pricing text: "1–2 guests" -> "solo or as a pair" (HomePageClient, FAQ). Amounts unchanged ($1,999/$1,949/$1,899/$1,799; $999 deposit).
- New FAQ "Can I come on my own?" states $1,999 solo rate, no single supplement.
- Terms section 9: removed the right to cancel a date for unmet minimum participants; states no minimum group size. Policy change - confirm intended.
- FAQ removals/rewording and sitemap lastModified bump.

Please confirm the terms change and that pricing figures match Stripe config.
