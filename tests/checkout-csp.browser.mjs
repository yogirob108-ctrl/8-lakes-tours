import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { checkoutRoutes } from './checkout-route-harness.mjs';

// Real Chrome enforces CSP. All non-loopback traffic is intercepted locally;
// Stripe is a destination fixture, never contacted and no session is created.
test('Chrome permits Stripe 303 but blocks arbitrary form/redirect origins', { timeout: 30000 }, async t => {
  const routes = checkoutRoutes();
  const posts = [];
  const server = createServer(async (req, res) => {
    try {
      let response;
      if (req.method === 'POST') {
        let body = ''; for await (const chunk of req) body += chunk;
        posts.push({ url: req.url, body });
        // Negative control bypasses the URL guard to test CSP independently.
        response = req.url === '/untrusted-redirect'
          ? new Response(null, { status: 303, headers: { Location: 'https://example.invalid/checkout' } })
          : await routes.POST(new Request(`${origin}${req.url}`, { method: 'POST', body }));
      } else response = await routes.GET(new Request(`${origin}${req.url}`));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text());
    } catch (error) { res.writeHead(500); res.end(String(error)); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise(resolve => server.close(resolve)));
  const profile = await mkdtemp(join(tmpdir(), 'checkout-csp-chrome-'));
  const executable = process.env.CHROME_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome');
  const chrome = spawn(executable, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', 'about:blank'], { stdio: 'ignore' });
  let launchError;
  chrome.on('error', error => { launchError = error; });
  t.after(async () => {
    if (chrome.exitCode === null && !launchError) {
      const exited = new Promise(resolve => chrome.once('exit', resolve));
      chrome.kill(); await exited;
    }
    await rm(profile, { recursive: true, force: true, maxRetries: 3 });
  });
  let port;
  for (let i = 0; i < 100; i++) {
    if (launchError) throw launchError;
    try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break; } catch { await delay(50); }
  }
  assert.ok(port, 'Chrome remote debugging started');
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  t.diagnostic(`Browser: ${version.Browser}`);
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const ws = new WebSocket(tabs.find(tab => tab.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  t.after(() => ws.close());
  let id = 0;
  const pending = new Map();
  const remote = [];
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const next = ++id; pending.set(next, { resolve, reject });
      ws.send(JSON.stringify({ id: next, method, params }));
    });
  }
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const waiter = pending.get(message.id); pending.delete(message.id);
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error))); else waiter.resolve(message.result);
    } else if (message.method === 'Fetch.requestPaused') {
      const { requestId, request } = message.params;
      if (request.url.startsWith(`${origin}/`)) void send('Fetch.continueRequest', { requestId });
      else {
        remote.push(request);
        void send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html' }], body: Buffer.from('<h1>LOCAL CHECKOUT DESTINATION</h1>').toString('base64') });
      }
    }
  };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: "window.violations=[];document.addEventListener('securitypolicyviolation',e=>window.violations.push({directive:e.effectiveDirective,blockedURI:e.blockedURI}));" });
  const evaluate = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true })).result.value;
  async function waitFor(expression) {
    for (let i = 0; i < 60; i++) { if (await evaluate(expression)) return; await delay(50); }
    assert.fail(`Chrome did not satisfy: ${expression}; state=${JSON.stringify(await evaluate('({url:location.href,violations:window.violations})'))}`);
  }
  const payUrl = `${origin}/pay?reference=8L-TEST234&token=private-fixture`;
  async function load() {
    await send('Page.navigate', { url: payUrl });
    await waitFor(`location.href === ${JSON.stringify(payUrl)} && !!document.querySelector('button')`);
  }
  await load();
  const response = await routes.GET(new Request(payUrl));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.equal(await evaluate("document.querySelectorAll('script').length"), 0);
  // Native button click initiates a POST and the real checkout route's 303.
  await evaluate("document.querySelector('button').click()");
  await waitFor("location.origin === 'https://checkout.stripe.com'");
  assert.equal(posts.length, 1);
  assert.match(posts[0].body, /token=private-fixture/);
  const stripeRequest = remote.find(request => request.url.startsWith('https://checkout.stripe.com/'));
  assert.ok(stripeRequest);
  assert.equal(stripeRequest.method, 'GET');
  assert.ok(!Object.keys(stripeRequest.headers).some(key => key.toLowerCase() === 'referer'));
  assert.equal(await evaluate('document.referrer'), '');
  t.diagnostic('PASS: actual /pay → POST /api/checkout → 303 → https://checkout.stripe.com; no Referer; remote response locally intercepted');
  for (const action of ['/untrusted-redirect', 'https://example.invalid/direct']) {
    await load();
    await evaluate(`document.querySelector('form').action=${JSON.stringify(action)};document.querySelector('button').click()`);
    await waitFor("window.violations?.some(v=>v.directive==='form-action')");
    assert.equal(await evaluate('location.href'), payUrl);
    assert.ok(!remote.some(request => request.url.startsWith('https://example.invalid/')));
    t.diagnostic(`PASS: ${action} blocked: ${JSON.stringify(await evaluate('window.violations'))}`);
  }
  await load();
  await evaluate("window.inlineRan=false;const s=document.createElement('script');s.textContent='window.inlineRan=true';document.body.append(s)");
  await waitFor("window.violations?.some(v=>v.directive==='script-src-elem')");
  assert.equal(await evaluate('window.inlineRan'), false);
  t.diagnostic('PASS: inline script still blocked');
  assert.equal(response.headers.get('content-security-policy'), "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://checkout.stripe.com; base-uri 'none'; frame-ancestors 'none'");
});
