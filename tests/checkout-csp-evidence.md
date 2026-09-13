# Private checkout redirect regression

Baseline staged site tree: `46765d87bfc5eba0a721371dc2c4d60c38a794da`.

## Executed RED → GREEN

Environment: Node `v26.8.1`, real headless Google Chrome `152.0.7977.84` on macOS.

Before production edits, `node --test tests/checkout-csp.browser.mjs` failed:

```text
Chrome did not satisfy: location.origin === 'https://checkout.stripe.com'
state={"url":"http://127.0.0.1:49372/pay?reference=8L-TEST234&token=private-fixture","violations":[{"directive":"form-action","blockedURI":"http://127.0.0.1:49372/api/checkout"}]}
tests 1; pass 0; fail 1
```

Before the redirect guard, `node --test tests/checkout-redirect.test.mjs` returned 8 failures (`303 !== 409`) for untrusted absolute URLs, including arbitrary hosts, lookalike/subdomain hosts, HTTP, nonstandard ports, credentials and JavaScript URLs.

After the narrowly scoped policy and redirect guard changes, `npm run test:browser` passed:

```text
Browser: Chrome/152.0.7977.84
PASS: actual /pay → POST /api/checkout → 303 → https://checkout.stripe.com; no Referer; remote response locally intercepted
PASS: /untrusted-redirect blocked: [{"directive":"form-action","blockedURI":"http://127.0.0.1:49431/untrusted-redirect"}]
PASS: https://example.invalid/direct blocked: [{"directive":"form-action","blockedURI":"https://example.invalid/direct"}]
PASS: inline script still blocked
tests 1; pass 1; fail 0
```

Final verification: `npm test` passed 148/148; `npm run lint` passed; `npm run build` passed (including TypeScript and production route generation). All 13 redirect URL tests passed. Whitespace checks passed.

## Scope and reproduction

- Run `npm test` for route URL validation; run `npm run test:browser` for Chrome CSP enforcement.
- Browser regression requires Node with global WebSocket support (Node 22+), plus Google Chrome. On macOS the default executable is `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`; elsewhere it is `google-chrome`. Override with `CHROME_PATH` if needed. Missing Chrome fails rather than silently skipping.
- The harness transpiles and executes the actual `/pay` and `/api/checkout` handlers using real `NextResponse`. Only booking/provider boundaries are substituted. It does not exercise Next.js server routing or a real provider session.
- An isolated ephemeral Chrome profile clicks the native form button and follows the real local HTTP POST/303. CDP intercepts and locally fulfills non-loopback requests: no Stripe navigation reaches the network, no session is created, and no live DB/email/card operation occurs.
- The arbitrary-redirect negative control deliberately bypasses the application URL guard through a test-only local endpoint so it independently proves CSP still blocks arbitrary destinations. A separate direct-form negative control and script-injection control also remain blocked.
- Tests assert exact CSP, no-store, no-referrer, noindex/nofollow, no script elements, blocked inline execution and absent destination Referer/document.referrer.
- Only `https://checkout.stripe.com` is added to `form-action`; all other CSP directives remain unchanged. Redirect validation requires that exact HTTPS origin and rejects credentials before returning Location.

This is local code/browser evidence, not a deployment or live-payment verification. No commit, deploy or live mutation was performed.
