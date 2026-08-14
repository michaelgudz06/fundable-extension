/**
 * URL -> lookup identifier for the Fundable pill.
 *
 *   resolveIdentifier(url)
 *     -> { kind: 'domain' | 'linkedin' | 'crunchbase', value: string }
 *     -> null   // do not show the pill here
 *
 * `null` is the deny answer AND the default answer. A missing pill is a
 * non-event; a pill on someone's bank login is a bug.
 *
 * Canonical `value` per kind:
 *   domain      registrable domain, lowercase, punycode      "stripe.com"
 *   linkedin    "https://www.linkedin.com/company/<slug>"
 *   crunchbase  "https://www.crunchbase.com/organization/<slug>"
 */

// --- deny list: data, not code. Add a row, don't read the logic below. -----
// Matched against the host and every parent domain, so `slack.com` also denies
// `app.slack.com`, while `checkout.stripe.com` leaves `stripe.com` resolvable.
const DENY_HOSTS = {
  banking: [
    'chase.com', 'bankofamerica.com', 'wellsfargo.com', 'citi.com', 'citibank.com',
    'capitalone.com', 'usbank.com', 'pnc.com', 'truist.com', 'ally.com', 'discover.com',
    'amex.com', 'americanexpress.com', 'td.com', 'tdbank.com', 'rbc.com', 'rbcroyalbank.com',
    'scotiabank.com', 'bmo.com', 'cibc.com', 'hsbc.com', 'hsbc.co.uk', 'barclays.co.uk',
    'lloydsbank.com', 'natwest.com', 'halifax.co.uk', 'santander.com', 'ing.com',
    'schwab.com', 'fidelity.com', 'vanguard.com', 'etrade.com', 'robinhood.com',
    'tdameritrade.com', 'interactivebrokers.com', 'coinbase.com', 'binance.com',
    'kraken.com', 'blockchain.com', 'metamask.io',
  ],
  payments: [
    'paypal.com', 'venmo.com', 'cash.app', 'zellepay.com', 'checkout.stripe.com',
    'connect.stripe.com', 'billing.stripe.com', 'dashboard.stripe.com', 'pay.google.com',
    'payments.google.com', 'buy.stripe.com',
  ],
  healthcare: [
    'mychart.com', 'myuhc.com', 'uhc.com', 'anthem.com', 'cigna.com', 'aetna.com',
    'bcbs.com', 'kaiserpermanente.org', 'teladoc.com', 'goodrx.com', 'webmd.com',
    'mayoclinic.org', 'plannedparenthood.org', 'healthline.com', 'psychologytoday.com',
    'betterhelp.com', 'nhs.uk',
  ],
  // Most government is caught by the .gov/.mil/.gouv/.gob label rule below.
  government: ['irs.gov', 'ssa.gov', 'usa.gov', 'gov.uk', 'canada.ca', 'service-public.fr'],
  webmail_messaging: [
    'gmail.com', 'googlemail.com', 'outlook.com', 'office.com', 'office365.com',
    'microsoftonline.com', 'hotmail.com', 'live.com', 'proton.me', 'protonmail.com',
    'tutanota.com', 'fastmail.com', 'hey.com', 'zoho.com', 'aol.com', 'gmx.com',
    'mail.com', 'mail.ru', 'whatsapp.com', 'slack.com', 'discord.com', 'discordapp.com',
    'messenger.com', 'telegram.org', 'signal.org', 'teams.microsoft.com', 'zoom.us',
    'webex.com',
  ],
  identity_sso: [
    'okta.com', 'oktapreview.com', 'auth0.com', 'onelogin.com', 'duosecurity.com',
    'pingidentity.com', 'jumpcloud.com', 'appleid.apple.com', 'icloud.com',
    '1password.com', 'lastpass.com', 'bitwarden.com', 'dashlane.com', 'authy.com',
  ],
  general_purpose: [
    'x.com', 'twitter.com', 't.co', 'reddit.com', 'wikipedia.org', 'wikimedia.org',
    'instagram.com', 'tiktok.com', 'pinterest.com', 'snapchat.com', 'twitch.tv',
    'netflix.com', 'quora.com', 'threads.net', 'tumblr.com', 'imgur.com', 'ask.com',
    'ecosia.org', 'duckduckgo.com', 'archive.org', 'craigslist.org',
  ],
  dating: [
    'tinder.com', 'bumble.com', 'hinge.co', 'grindr.com', 'match.com', 'okcupid.com',
    'ashleymadison.com', 'plentyoffish.com',
  ],
  adult: [
    'pornhub.com', 'xvideos.com', 'xhamster.com', 'xnxx.com', 'redtube.com',
    'youporn.com', 'onlyfans.com', 'fansly.com', 'chaturbate.com', 'stripchat.com',
    'spankbang.com', 'eporner.com', 'brazzers.com', 'adultfriendfinder.com',
    'nhentai.net', 'rule34.xxx',
  ],
};

// Any registrable domain whose first label is one of these, on any TLD:
// google.co.uk, amazon.de, youtube.com ...
const DENY_BRANDS = new Set([
  'google', 'youtube', 'facebook', 'fb', 'amazon', 'yahoo', 'bing', 'baidu',
  'yandex', 'ebay', 'naver', 'aliexpress', 'taobao',
]);

// Whole TLDs nobody should get a pill on.
const DENY_TLDS = new Set([
  'gov', 'mil', 'bank', 'insurance', 'xxx', 'adult', 'porn', 'sex', 'onion',
  'local', 'localhost', 'internal', 'intranet', 'lan', 'home', 'corp',
  'test', 'invalid', 'example', 'arpa',
]);

// Government-ish labels in the public-suffix position: gov.uk, gob.mx, gouv.fr,
// govt.nz, nhs.uk, mil.br.
const DENY_SUFFIX_LABELS = new Set(['gov', 'gob', 'gouv', 'govt', 'mil', 'nhs', 'police']);

// Auth surfaces. Matched against a whole host label or a whole path segment,
// with `-` and `_` stripped first, so one entry covers sign-in / sign_in / signin
// but a compound segment does not match: /blog/oauth-explained is "oauthexplained",
// so it resolves normally, while /login and /sign_in deny.
const AUTH_WORDS = new Set([
  'login', 'logon', 'signin', 'signon', 'logout', 'signout', 'signup', 'register',
  'registration', 'auth', 'auth0', 'oauth', 'oauth2', 'openid', 'connect', 'sso',
  'saml', 'adfs', 'idp', 'authorize', 'authorization', 'authentication', 'session',
  'sessions', 'password', 'passwords', 'passwd', 'forgot', 'forgotpassword',
  'reset', 'resetpassword', 'recover', 'recovery', 'mfa', '2fa', 'otp', 'verify',
  'verification', 'confirm', 'consent', 'token', 'account', 'accounts',
  'myaccount', 'profile', 'settings', 'admin', 'dashboard', 'billing', 'invoice',
  'invoices', 'payment', 'payments', 'checkout', 'cart', 'wallet', 'secure',
  'onboarding',
]);

// Extra host-only labels ("my.acme.com" is a customer portal, not a homepage;
// "mail.acme.com" is somebody's open inbox). Checked after LinkedIn/Crunchbase,
// so locale hosts like my.linkedin.com and id.linkedin.com still resolve.
const AUTH_HOST_LABELS = new Set(['my', 'portal', 'identity', 'passport', 'id',
  'signin', 'login', 'mail', 'webmail', 'inbox', 'email', 'owa']);

// OAuth / OIDC / SAML / WS-Federation in flight, whatever the host says. Matched
// against query AND fragment parameter NAMES, lowercased with `-` and `_`
// stripped, so one entry covers SAMLRequest, saml_request and #access_token.
const AUTH_PARAMS = new Set(['clientid', 'redirecturi', 'responsetype',
  'codechallenge', 'idtoken', 'accesstoken', 'samlrequest', 'samlresponse',
  'relaystate', 'statetoken', 'wa', 'wtrealm', 'wreply', 'wctx']);

// Second-level labels that act as a public suffix under a 2-letter ccTLD:
// example.co.uk, example.com.au, example.ac.nz. A naive last-two split gets "co.uk".
// Keyed by TLD, because a label is only a suffix under the TLDs that say so —
// `web` is one under .za but not under .de, so www.web.de stays web.de.
// The '*' row holds under any 2-letter ccTLD; add a label to its TLD's row.
const PUBLIC_SLDS = new Map(Object.entries({
  '*': 'co com net org edu gov ac',
  uk: 'me ltd plc sch mod nhs police',
  au: 'asn id',
  nz: 'govt school geek gen',
  za: 'web nom',
  jp: 'ne or go gr ed lg',
  kr: 'ne or re pe go',
  cn: 'mil',
  in: 'firm gen ind res nic',
  id: 'or go sch web biz my',
  br: 'mil',
  mx: 'gob',
  ar: 'gob mil',
  co: 'mil nom',
  il: 'muni',
  tr: 'bel pol k12',
  ru: 'int mil',
  pl: 'biz waw',
  fr: 'gouv asso tm nom prd',
  hk: 'idv',
  sg: 'per',
  th: 'or go in mi',
}));

const DENIED = new Set(Object.values(DENY_HOSTS).flat());
const MAX_URL = 2048;
const MAX_HOST = 253;
const SLUG = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const TLD = /^(xn--[a-z0-9-]+|[a-z]{2,63})$/;

/** Registrable domain of a host, or null if the host isn't a public name. */
function registrable(host) {
  const labels = host.split('.');
  if (labels.length < 2 || labels.some((l) => l === '')) return null;
  const tld = labels[labels.length - 1];
  if (!TLD.test(tld)) return null; // IP literals, hex hosts
  const slds = `${PUBLIC_SLDS.get('*')} ${PUBLIC_SLDS.get(tld) ?? ''}`.split(' ');
  const take = labels.length > 2 && tld.length === 2 &&
    slds.includes(labels[labels.length - 2]) ? 3 : 2;
  return labels.slice(-take).join('.');
}

export function resolveIdentifier(url) {
  if (typeof url !== 'string' || url.length === 0 || url.length > MAX_URL) return null;

  let u;
  try {
    u = new URL(url);
  } catch {
    return null; // malformed, or a scheme-less string like "stripe.com"
  }

  // Non-web schemes: chrome://, chrome-extension://, about:, file:, data:,
  // view-source:, edge://, devtools:// all fail this one check.
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null; // https://user:pass@host/

  const host = u.hostname.replace(/\.$/, '').toLowerCase();
  if (!host || host.length > MAX_HOST) return null;
  if (host.startsWith('[')) return null;      // IPv6 literal
  if (host === 'localhost') return null;

  const labels = host.split('.');
  const segments = u.pathname.split('/').filter(Boolean).map((s) => s.toLowerCase());
  // Hash routes: "#/login", "#!/login", "#/oauth/authorize?client_id=..." are
  // paths, not anchors, and "#access_token=..." is a parameter list.
  const [hashPath, hashQuery] = u.hash.slice(1).split('?');
  const routes = hashPath.replace(/^!/, '').split('/').filter(Boolean);

  const word = (s) => s.toLowerCase().replace(/[-_]/g, '');
  if ([...segments, ...routes].some((s) => AUTH_WORDS.has(word(s)))) return null;
  const params = [...u.searchParams.keys(),
    ...new URLSearchParams(hashQuery ?? hashPath).keys()];
  if (params.some((p) => AUTH_PARAMS.has(word(p)))) return null;

  const domain = registrable(host);
  if (!domain) return null; // IPs, single-label hosts, junk

  const parts = domain.split('.');
  if (DENY_TLDS.has(parts[parts.length - 1])) return null;
  if (parts.length === 3 && DENY_SUFFIX_LABELS.has(parts[1])) return null;
  if (DENY_BRANDS.has(parts[0])) return null;

  // Deny the host and every parent: app.slack.com dies on "slack.com".
  for (let i = 0; i < labels.length - 1; i++) {
    if (DENIED.has(labels.slice(i).join('.'))) return null;
  }

  if (domain === 'linkedin.com') {
    const slug = segments[0] === 'company' ? segments[1] : null;
    return slug && SLUG.test(slug)
      ? { kind: 'linkedin', value: `https://www.linkedin.com/company/${slug}` }
      : null; // /in/<person>, /feed, /jobs — not a company
  }

  if (domain === 'crunchbase.com') {
    const slug = segments[0] === 'organization' ? segments[1] : null;
    return slug && SLUG.test(slug)
      ? { kind: 'crunchbase', value: `https://www.crunchbase.com/organization/${slug}` }
      : null;
  }

  if (labels.some((l) => AUTH_WORDS.has(word(l)) || AUTH_HOST_LABELS.has(word(l)))) return null;

  return { kind: 'domain', value: domain };
}
