<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Testing interactive controls

A browser fires `input` and `change` as separate tasks, so a render can land
between them. Scripted `dispatchEvent` calls in one task get batched by React
and never expose that window — a bug that broke every dropdown on the booking
form shipped while hand-written DOM checks kept reporting success.

Never conclude a control works from scripted events alone. Drive it with
Playwright (`npm run test:browser:forms`, after `npm run build && PORT=3319 npm
run start`), which produces real event timing, and assert the value the form
kept *after* the render rather than the value that was set. `tests/controlled-
field-stability.test.mjs` guards the render shape on every `npm test`.
