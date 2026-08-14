// Run: node extension/resolver.test.js
// No framework on purpose — the extension ships with no build step.
import assert from 'node:assert/strict';
import { resolveIdentifier } from './resolver.js';

let failed = 0;
const test = (name, fn) => {
  try {
    fn();
  } catch (e) {
    failed++;
    console.error(`FAIL  ${name}\n      ${e.message.split('\n')[0]}`);
  }
};

/** Every url must resolve to exactly {kind, value}. */
const resolves = (label, kind, cases) =>
  test(label, () => {
    for (const [url, value] of cases) {
      assert.deepEqual(resolveIdentifier(url), { kind, value }, url);
    }
  });

/** Every url must be denied. */
const denies = (label, urls) =>
  test(label, () => {
    for (const url of urls) assert.equal(resolveIdentifier(url), null, url);
  });

// --- ordinary company sites ----------------------------------------------

resolves('subdomains reduce to the registrable domain', 'domain', [
  ['https://stripe.com/', 'stripe.com'],
  ['https://www.stripe.com/', 'stripe.com'],
  ['https://careers.stripe.com/jobs', 'stripe.com'],
  ['https://blog.stripe.com/posts/one', 'stripe.com'],
  ['https://a.b.c.stripe.com/', 'stripe.com'],
  ['http://STRIPE.COM/', 'stripe.com'],
  ['https://stripe.com./', 'stripe.com'],          // trailing root dot
  ['https://stripe.com:8443/pricing', 'stripe.com'], // port ignored
  ['https://wealthsimple.com/', 'wealthsimple.com'],
]);

resolves('multi-part public suffixes are not split naively', 'domain', [
  ['https://example.co.uk/', 'example.co.uk'],
  ['https://www.example.co.uk/', 'example.co.uk'],
  ['https://shop.example.com.au/cart-page', 'example.com.au'],
  ['https://www.bbc.co.uk/', 'bbc.co.uk'],
  ['https://team.example.co.jp/', 'example.co.jp'],
  ['https://example.com.br/', 'example.com.br'],
  ['https://a.b.example.co.za/', 'example.co.za'],
  ['https://example.ac.nz/', 'example.ac.nz'],
]);

// A label is only a public suffix under the TLDs where it genuinely is one:
// co.uk is, web.de is not, so one site never gets two lookup keys.
resolves('a suffix label under another TLD is the registrant, not a suffix', 'domain', [
  ['https://web.de/', 'web.de'],
  ['https://www.web.de/', 'web.de'],
  ['https://blog.web.de/', 'web.de'],
  ['https://www.info.de/', 'info.de'],
  ['https://www.biz.co/', 'biz.co'],
  ['https://www.ltd.ai/', 'ltd.ai'],
]);

// A country's own suffix labels are not somebody's auth subdomain: the .id, .my
// and .email namespaces belong to companies, not to portals named id/my/email.
resolves('a public suffix that collides with an auth label still resolves', 'domain', [
  ['https://www.tokopedia.co.id/', 'tokopedia.co.id'],
  ['https://www.gojek.co.id/', 'gojek.co.id'],
  ['https://www.grab.com.my/', 'grab.com.my'],
  ['https://acme.email/', 'acme.email'],
]);

resolves('lookalike hosts resolve to the real registrant, not the brand', 'domain', [
  ['https://stripe.com.evil.co/', 'evil.co'],
  ['https://www.stripe.com.evil.co/login-page', 'evil.co'],
  ['https://linkedin.com.phish.net/company/stripe', 'phish.net'],
  ['https://crunchbase.com.phish.net/organization/stripe', 'phish.net'],
  ['https://stripe.com.co/', 'stripe.com.co'], // com.co is a real public suffix
]);

resolves('unicode hosts normalise to punycode', 'domain', [
  ['https://münchen.de/', 'xn--mnchen-3ya.de'],
  ['https://www.münchen.de/', 'xn--mnchen-3ya.de'],
  ['https://xn--mnchen-3ya.de/', 'xn--mnchen-3ya.de'],
  ['https://shop.日本.jp/', 'xn--wgv71a.jp'],
]);

// --- LinkedIn -------------------------------------------------------------

resolves('linkedin company pages', 'linkedin', [
  ['https://www.linkedin.com/company/stripe', 'https://www.linkedin.com/company/stripe'],
  ['https://www.linkedin.com/company/stripe/', 'https://www.linkedin.com/company/stripe'],
  ['https://linkedin.com/company/stripe', 'https://www.linkedin.com/company/stripe'],
  ['https://ca.linkedin.com/company/stripe', 'https://www.linkedin.com/company/stripe'],
  ['https://de.linkedin.com/company/stripe/about', 'https://www.linkedin.com/company/stripe'],
  ['https://www.linkedin.com/company/stripe/people/', 'https://www.linkedin.com/company/stripe'],
  ['https://www.linkedin.com/company/stripe/jobs?trk=nav', 'https://www.linkedin.com/company/stripe'],
  ['https://www.linkedin.com/company/Stripe?originalSubdomain=ca', 'https://www.linkedin.com/company/stripe'],
  ['https://www.linkedin.com/company/some-co-2024/', 'https://www.linkedin.com/company/some-co-2024'],
  // Locale subdomains that collide with auth host labels: Malaysia, Indonesia.
  ['https://my.linkedin.com/company/stripe', 'https://www.linkedin.com/company/stripe'],
  ['https://id.linkedin.com/company/stripe', 'https://www.linkedin.com/company/stripe'],
]);

denies('linkedin non-company pages', [
  'https://www.linkedin.com/',
  'https://www.linkedin.com/feed/',
  'https://www.linkedin.com/in/someperson',
  'https://www.linkedin.com/jobs/search',
  'https://www.linkedin.com/company/',
  'https://www.linkedin.com/company',
  'https://www.linkedin.com/school/some-university/',
  'https://www.linkedin.com/uas/login',
  'https://www.linkedin.com/company/%2e%2e/evil',
]);

// --- Crunchbase -----------------------------------------------------------

resolves('crunchbase organization pages', 'crunchbase', [
  ['https://www.crunchbase.com/organization/stripe', 'https://www.crunchbase.com/organization/stripe'],
  ['https://crunchbase.com/organization/stripe/', 'https://www.crunchbase.com/organization/stripe'],
  ['https://www.crunchbase.com/organization/stripe/company_financials', 'https://www.crunchbase.com/organization/stripe'],
  ['https://www.crunchbase.com/organization/stripe?utm_source=x', 'https://www.crunchbase.com/organization/stripe'],
]);

denies('crunchbase non-organization pages', [
  'https://www.crunchbase.com/',
  'https://www.crunchbase.com/person/patrick-collison',
  'https://www.crunchbase.com/discover/organization.companies',
  'https://www.crunchbase.com/organization/',
]);

// --- deny list, one concrete URL per category -----------------------------

denies('non-web schemes and browser-internal pages', [
  'chrome://extensions',
  'chrome-extension://abcdefghijklmnop/panel.html',
  'about:blank',
  'about:config',
  'file:///Users/someone/taxes.pdf',
  'data:text/html,<h1>hi</h1>',
  'view-source:https://stripe.com/',
  'edge://settings',
  'devtools://devtools/bundled/inspector.html',
  'javascript:alert(1)',
  'ftp://files.stripe.com/',
]);

denies('localhost, IP literals, private ranges and internal names', [
  'http://localhost/',
  'http://localhost:3000/app',
  'http://foo.localhost/',
  'http://127.0.0.1:8080/',
  'http://192.168.1.1/',
  'http://10.0.0.7/admin-panel',
  'http://172.16.4.2/',
  'http://169.254.169.254/latest/meta-data/',
  'http://8.8.8.8/',
  'http://[::1]:9229/',
  'http://[fe80::1]/',
  'http://[2001:4860:4860::8888]/',
  'http://printer.local/',
  'http://wiki.corp/',
  'http://build.internal/',
  'http://intranet/',
  'http://someco.test/',
]);

denies('banking, payments, healthcare, government', [
  'https://www.chase.com/',
  'https://secure.bankofamerica.com/',
  'https://www.hsbc.co.uk/',
  'https://www.paypal.com/us/home',
  'https://checkout.stripe.com/c/pay/cs_live_abc',
  'https://cash.app/',
  'https://www.coinbase.com/',
  'https://mychart.com/',
  'https://www.cigna.com/plans',
  'https://www.nhs.uk/conditions/',
  'https://www.irs.gov/refunds',
  'https://www.dmv.ca.gov/',
  'https://www.gov.uk/vehicle-tax',
  'https://www.defense.mil/',
  'https://www.gob.mx/tramites',
  // A government label denies wherever it sits, however the host reduces:
  // gob.es and mil.pt reduce to two labels, gouv.qc.ca hides behind qc.ca.
  'https://gob.mx/',
  'https://www.gob.es/',
  'https://www.gob.pe/',
  'https://www.gouv.qc.ca/',
  'https://www.exercito.mil.pt/',
  'https://www.police.uk/',
  'https://www.govt.nz/',
  'https://sede.administracion.gob.es/',
]);

denies('webmail and messaging', [
  'https://mail.google.com/mail/u/0/#inbox',
  'https://outlook.office.com/mail/',
  'https://mail.proton.me/u/0/inbox',
  'https://web.whatsapp.com/',
  'https://app.slack.com/client/T0/C0',
  'https://discord.com/channels/@me',
  'https://teams.microsoft.com/',
  'https://mail.yahoo.com/',
  // A company running its own webmail is still an open inbox.
  'https://mail.acme.com/',
  'https://webmail.acme.com/',
  'https://inbox.acme.com/',
  'https://email.acme.com/',
  'https://owa.acme.com/',
]);

denies('auth, SSO, OAuth and password-reset flows', [
  'https://accounts.google.com/o/oauth2/v2/auth',
  'https://login.microsoftonline.com/common/oauth2/authorize',
  'https://acme.okta.com/app/UserHome',
  'https://auth.stripe.com/',
  'https://sso.acme.com/',
  'https://id.atlassian.com/login',
  'https://id.acme.com/',   // bare host: only the host-label rule can deny this
  'https://my.acme.com/',
  'https://acme.com/login',
  'https://acme.com/users/sign_in',
  'https://acme.com/account/settings',
  'https://acme.com/password/reset',
  'https://acme.com/forgot-password',
  'https://acme.com/oauth/authorize',
  'https://acme.com/sso/saml',
  'https://acme.com/checkout/step-2',
  'https://acme.com/billing',
  // OAuth in flight on an otherwise ordinary host
  'https://acme.com/consent-screen?client_id=123&redirect_uri=https://x.co/cb',
  'https://acme.com/x?response_type=code&client_id=abc',
  // Parameter names are matched case-insensitively...
  'https://fs.contoso.com/adfs/ls/?SAMLRequest=abc',
  'https://acme.com/x?SAMLResponse=abc&RelayState=y&samlrequest=z',
  'https://acme.com/x?stateToken=abc',
  'https://acme.com/x?Client-Id=abc',
  // ...and implicit-flow tokens land in the fragment, not the query.
  'https://acme.com/cb#access_token=abc&token_type=bearer',
  'https://acme.com/cb#id_token=abc',
  // AD FS WS-Federation: denied by the path, by the parameters, or by both.
  'https://sts.example-corp.com/adfs/ls/?wa=wsignin1.0&wtrealm=urn:acme',
  'https://sts.example-corp.com/adfs/ls/',
  'https://sts.example-corp.com/ls/?wa=wsignin1.0&wtrealm=urn:acme',
  'https://sts.example-corp.com/ls/?wreply=https://acme.com/&wctx=abc',
]);

denies('hash-routed auth screens', [
  'https://acme.com/#/login',
  'https://acme.com/#/signin',
  'https://acme.com/#!/signin',
  'https://acme.com/#/oauth/authorize',
  'https://acme.com/#/reset-password',
  'https://acme.com/#/oauth/authorize?client_id=abc',
]);

// An anchor is a place on the page, not a route — including when it is named
// after an auth word, which is ordinary on a marketing page.
resolves('ordinary anchors are not routes', 'domain', [
  ['https://acme.com/#pricing', 'acme.com'],
  ['https://acme.com/about#our-team', 'acme.com'],
  ['https://stripe.com/pricing#signup', 'stripe.com'],
  ['https://acme.com/pricing#billing', 'acme.com'],
  ['https://acme.com/about#connect', 'acme.com'],
  ['https://acme.com/product#dashboard', 'acme.com'],
]);

// ...but a bare auth word on a bare path is how hash routers older than the
// "#/" convention address a login screen, and when in doubt the answer is null.
denies('a bare auth-word fragment on a root path', [
  'https://acme.com/#login',
  'https://acme.com/#signin',
  'https://acme.com#sign-in',
  'https://acme.com/#reset_password',
]);

resolves('a linkedin company page keeps its anchor', 'linkedin', [
  ['https://www.linkedin.com/company/stripe#about', 'https://www.linkedin.com/company/stripe'],
  ['https://www.linkedin.com/company/stripe#profile', 'https://www.linkedin.com/company/stripe'],
]);

// Whole host labels and whole path segments only, after `-`/`_` are stripped —
// so ordinary marketing paths that merely contain an auth word still resolve.
resolves('auth words match whole segments, not substrings', 'domain', [
  ['https://acme.com/blog/oauth-explained', 'acme.com'],
  ['https://acme.com/design/campaign', 'acme.com'],
  ['https://acme.com/blog/how-we-do-login-security', 'acme.com'],
]);

denies('search engines, social feeds and general-purpose sites', [
  'https://www.google.com/search?q=stripe',
  'https://www.google.co.uk/',
  'https://google.de/maps',
  'https://www.youtube.com/watch?v=abc',
  'https://www.facebook.com/somecompany',
  'https://x.com/stripe',
  'https://twitter.com/stripe',
  'https://www.reddit.com/r/startups/',
  'https://www.amazon.com/dp/B000',
  'https://www.amazon.co.uk/',
  'https://en.wikipedia.org/wiki/Stripe,_Inc.',
  'https://www.bing.com/search?q=x',
  'https://duckduckgo.com/?q=x',
  'https://www.tiktok.com/@someone',
]);

denies('adult and other hosts nobody wants a pill on', [
  'https://www.pornhub.com/',
  'https://onlyfans.com/someone',
  'https://something.xxx/',
  'https://anything.porn/',
  'https://tinder.com/app/recs',
  'https://www.grindr.com/',
]);

// --- input hygiene --------------------------------------------------------

denies('malformed, empty and non-URL input', [
  '',
  ' ',
  'stripe.com',              // no scheme — not a URL
  'www.stripe.com/pricing',
  'not a url at all',
  'https://',
  'http:///path',
  'https://.com/',
  'https://foo..com/',
  '//stripe.com/',
  'https:// stripe.com/',
]);

test('non-string input', () => {
  for (const v of [null, undefined, 0, 42, {}, [], true, new URL('https://stripe.com/')]) {
    assert.equal(resolveIdentifier(v), null, String(v));
  }
});

denies('URLs with embedded credentials', [
  'https://user:pass@stripe.com/',
  'https://user@stripe.com/',
  'https://admin:hunter2@www.linkedin.com/company/stripe',
  'https://user:pass@192.168.0.1/',
]);

test('extremely long hosts and URLs', () => {
  const longLabel = 'a'.repeat(300);
  assert.equal(resolveIdentifier(`https://${longLabel}.com/`), null);
  assert.equal(resolveIdentifier(`https://${'sub.'.repeat(80)}stripe.com/`), null);
  // A long path on a sane host is still fine.
  assert.deepEqual(
    resolveIdentifier(`https://stripe.com/${'a'.repeat(500)}`),
    { kind: 'domain', value: 'stripe.com' },
  );
  // ...until the whole URL is absurd.
  assert.equal(resolveIdentifier(`https://stripe.com/${'a'.repeat(3000)}`), null);
});

test('the same page always resolves to the same value', () => {
  const a = resolveIdentifier('https://CAREERS.Stripe.com/jobs?x=1#top');
  const b = resolveIdentifier('http://stripe.com/');
  assert.deepEqual(a, b);
});

console.log(failed === 0 ? 'resolver: all tests passed' : `resolver: ${failed} failing test group(s)`);
process.exit(failed === 0 ? 0 : 1);
