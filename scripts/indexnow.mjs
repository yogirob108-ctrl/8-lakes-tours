// Tells Bing (and other IndexNow engines) that the site's pages changed, so
// ChatGPT search and Copilot pick up new copy quickly. Run after a deploy:
//   npm run indexnow
// The key file at public/<key>.txt proves we own the domain.
const HOST = 'www.8lakestours.com';
const KEY = 'd2ca2bc510bc00c6035ffa86d8bf1bb0';

const sitemap = await fetch(`https://${HOST}/sitemap.xml`).then(r => r.text());
const urlList = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);

const res = await fetch('https://api.indexnow.org/indexnow', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ host: HOST, key: KEY, keyLocation: `https://${HOST}/${KEY}.txt`, urlList }),
});
console.log(`IndexNow: ${res.status} ${res.statusText} for ${urlList.length} URLs`);
if (!res.ok && res.status !== 202) process.exitCode = 1;
