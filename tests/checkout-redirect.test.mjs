import test from 'node:test';
import assert from 'node:assert/strict';
import { checkoutRoutes } from './checkout-route-harness.mjs';

const request = () => new Request('http://localhost/api/checkout', { method: 'POST', body: 'reference=8L-TEST234&token=fixture' });
test('checkout redirects only to trusted HTTPS Stripe Checkout', async () => {
  const url = 'https://checkout.stripe.com/c/pay/cs_test_fixture#fixture';
  const response = await checkoutRoutes(url).POST(request());
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), url);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
});
for (const url of ['https://example.invalid/pay', 'https://checkout.stripe.com.evil.invalid/pay', 'https://evil.checkout.stripe.com/pay', 'http://checkout.stripe.com/pay', 'https://checkout.stripe.com:444/pay', 'https://user:password@checkout.stripe.com/pay', 'https://checkout.stripe.com@evil.invalid/pay', '//checkout.stripe.com/pay', '/pay', 'javascript:alert(1)', null, 'not a URL']) {
  test(`untrusted provider URL fails closed: ${url}`, async () => {
    const response = await checkoutRoutes(url).POST(request());
    assert.equal(response.status, 409);
    assert.equal(response.headers.get('location'), null);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.doesNotMatch(await response.text(), /password|evil|javascript/);
  });
}
