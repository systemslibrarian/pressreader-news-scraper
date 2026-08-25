/* ==========================================================================
   api.js — PressReader Discovery API client

   Request and response shapes follow the OpenAPI 3 description published at
   https://api.prod.pressreader.com/ :

     POST /discovery/v1/search?sort=&offset=&limit=
     header  api-key: <key>            (Ocp-Apim-Subscription-Key also works)
     body    { query, countries, itemTypes, author, cids, languages,
               searchIn, startDate, endDate }
     200     { items: SearchResultItem[], meta: { totalCount, offset, limit } }

   `query` and `countries` are the two fields the specification marks required.
   ========================================================================== */

export const DEFAULT_ENDPOINT = 'https://api.prod.pressreader.com/discovery/v1/search';

/** Hosts that must never receive an API key. See rejectUnsafeProxy(). */
const PUBLIC_PROXY_HOSTS = [
  'corsproxy.io', 'allorigins.win', 'thingproxy.freeboard.io', 'herokuapp.com',
  'cors-anywhere.com', 'whateverorigin.org', 'crossorigin.me', 'jsonp.afeld.me',
  'yacdn.org', 'cors.bridged.cc', 'proxy.cors.sh', 'test.cors.workers.dev',
];

export class ApiError extends Error {
  constructor(message, { kind, status, detail, hint } = {}) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind || 'unknown';    // network | auth | rate | request | server | config | parse
    this.status = status ?? null;
    this.detail = detail ?? '';
    this.hint = hint ?? '';
  }
}

/* --------------------------------------------------------------- endpoint -- */

/**
 * Refuses to send a key through a proxy operated by someone else. A shared
 * CORS proxy receives the `api-key` header in readable form, so this fails
 * closed rather than warning.
 */
export function rejectUnsafeProxy(proxyUrl) {
  if (!proxyUrl) return;
  let host;
  try {
    host = new URL(proxyUrl).hostname.toLowerCase();
  } catch {
    throw new ApiError('That proxy address is not a valid URL.', { kind: 'config' });
  }
  const match = PUBLIC_PROXY_HOSTS.find((h) => host === h || host.endsWith('.' + h));
  if (match) {
    throw new ApiError(
      `Refusing to send your API key through ${host}.`,
      {
        kind: 'config',
        detail:
          'This is a shared public proxy. Whoever runs it would receive your key ' +
          'in readable form and could store or reuse it.',
        hint: 'Deploy the Cloudflare Worker in the Setup & Help tab, or run the local proxy script. Both are free and keep the key between you and PressReader.',
      }
    );
  }
}

/**
 * Works out the URL to actually request.
 * @param {{endpoint?: string, proxyUrl?: string, proxyMode?: string}} conn
 * @param {{offset?: number, limit?: number, sort?: string}} page
 */
export function buildRequestUrl(conn, page = {}) {
  const endpoint = (conn.endpoint || DEFAULT_ENDPOINT).trim();
  let target;
  try {
    target = new URL(endpoint);
  } catch {
    throw new ApiError('The API endpoint is not a valid URL.', { kind: 'config' });
  }

  if (page.offset !== undefined) target.searchParams.set('offset', String(page.offset));
  if (page.limit !== undefined) target.searchParams.set('limit', String(page.limit));
  if (page.sort) target.searchParams.set('sort', page.sort);

  const proxy = (conn.proxyUrl || '').trim();
  if (!proxy) return target.toString();

  rejectUnsafeProxy(proxy);

  let base;
  try {
    base = new URL(proxy);
  } catch {
    throw new ApiError('The proxy address is not a valid URL.', { kind: 'config' });
  }

  if (conn.proxyMode === 'query') {
    base.searchParams.set('url', target.toString());
    return base.toString();
  }

  // Path mode: the proxy pins the upstream host itself, so it only needs the
  // path and query. A path already on the proxy URL is kept as a prefix.
  const prefix = base.pathname.replace(/\/+$/, '');
  const merged = new URL(base.origin + prefix + target.pathname);
  target.searchParams.forEach((v, k) => merged.searchParams.set(k, v));
  base.searchParams.forEach((v, k) => { if (k !== 'url') merged.searchParams.set(k, v); });
  return merged.toString();
}

/** Assembles the JSON request body from the search form's values. */
export function buildRequestBody(form) {
  const body = {};
  const query = (form.query || '').trim();
  if (query) body.query = query;

  const list = (value) => String(value || '')
    .split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);

  const countries = list(form.countries).map((c) => c.toUpperCase());
  if (countries.length) body.countries = countries;

  const languages = list(form.languages).map((c) => c.toLowerCase());
  if (languages.length) body.languages = languages;

  const cids = list(form.cids);
  if (cids.length) body.cids = cids;

  if (form.author && form.author.trim()) body.author = form.author.trim();
  if (form.itemTypes) body.itemTypes = form.itemTypes;
  if (form.searchIn) body.searchIn = form.searchIn;
  if (form.startDate) body.startDate = form.startDate;
  if (form.endDate) body.endDate = form.endDate;

  if (form.extra && String(form.extra).trim()) {
    let extra;
    try {
      extra = JSON.parse(form.extra);
    } catch (err) {
      throw new ApiError('The extra JSON is not valid JSON.', {
        kind: 'config', detail: err.message,
      });
    }
    if (!extra || typeof extra !== 'object' || Array.isArray(extra)) {
      throw new ApiError('The extra JSON must be a JSON object, e.g. {"cids": ["0001"]}.', {
        kind: 'config',
      });
    }
    Object.assign(body, extra);
  }

  return body;
}

/* ------------------------------------------------------------ normalising -- */

const str = (v) => (v === null || v === undefined ? null : String(v));
const joinNames = (arr, key = 'name') =>
  Array.isArray(arr) && arr.length
    ? arr.map((x) => (x && typeof x === 'object' ? x[key] : x)).filter(Boolean).join('; ')
    : null;

/** Turns one SearchResultItem into a row for the `articles` table. */
export function normaliseItem(item, { query = '', keepRaw = true } = {}) {
  const article = item?.article || {};
  const publication = item?.publication || {};
  const issue = item?.issue || {};
  const page = item?.page || {};
  const media = Array.isArray(article.media) ? article.media : [];
  // The live API sends typeName: "Image" (capitalised) and a numeric type,
  // which is not what the published schema's lowercase enum suggests.
  const image = media.find((m) => m && String(m.typeName ?? '').toLowerCase() === 'image') || media[0];

  const authors = joinNames(article.authors);
  const date = str(issue.date);

  return {
    id: str(article.id ?? item?.id ?? crypto.randomUUID()),
    title: str(article.title),
    subtitle: str(article.subTitle),
    summary: str(item?.summary),
    publication: str(publication.title),
    publication_cid: str(publication.cid),
    publication_type: str(publication.publicationType),
    publisher: str(publication.publisher?.name ?? publication.publisher),
    issn: str(publication.issn),
    author: str(article.author) || authors,
    section: str(article.section),
    content: str(item?.content ?? article.content),
    date: date ? date.split('T')[0] : null,
    page: Number.isFinite(Number(page.number)) && page.number !== null ? Number(page.number) : null,
    issue_page_count: Number.isFinite(Number(issue.pageCount)) && issue.pageCount !== null
      ? Number(issue.pageCount) : null,
    language: str(publication.language),
    countries: Array.isArray(publication.countries) ? publication.countries.join(', ') : str(publication.countries),
    categories: joinNames(item?.categories),
    entities: joinNames(item?.entities),
    sentiment: str(item?.sentiment),
    copyright: str(article.copyright),
    url: str(article.url),
    issue_url: str(issue.url),
    publication_url: str(publication.url),
    page_url: str(page.url),
    image_url: str(image?.url || image?.thumbnailUrl),
    media_count: media.length || null,
    first_query: query || null,
    raw: keepRaw ? JSON.stringify(item) : null,
  };
}

/* ----------------------------------------------------------------- errors -- */

function describeHttpError(status, text) {
  let detail = (text || '').slice(0, 600);
  try {
    const parsed = JSON.parse(text);
    detail = parsed.message || parsed.error || parsed.title || detail;
  } catch { /* not JSON — keep the raw text */ }

  if (status === 400) {
    return new ApiError('The API rejected the request as invalid (400).', {
      kind: 'request', status, detail,
      hint: 'The message above comes from PressReader. Common causes: an unsupported country or language code, a malformed date, or invalid extra JSON.',
    });
  }
  if (status === 401 || status === 403) {
    return new ApiError(`Your API key was rejected (${status}).`, {
      kind: 'auth', status, detail,
      hint: 'Check for a stray space or a partial paste, and confirm the key is active and covers the Discovery search endpoint.',
    });
  }
  if (status === 404) {
    return new ApiError('The endpoint was not found (404).', {
      kind: 'request', status, detail,
      hint: 'Check the API endpoint on the Setup & Help tab. If you use a proxy, confirm it forwards the /discovery/ path.',
    });
  }
  if (status === 429) {
    return new ApiError('Rate limit reached (429).', {
      kind: 'rate', status, detail,
      hint: 'Wait a few minutes, then fetch fewer articles per run.',
    });
  }
  if (status >= 500) {
    return new ApiError(`PressReader returned a server error (${status}).`, {
      kind: 'server', status, detail,
      hint: 'This is upstream, not your key. Try again shortly.',
    });
  }
  return new ApiError(`The request failed (${status}).`, { kind: 'request', status, detail });
}

function describeNetworkError(err, usingProxy) {
  if (err?.name === 'AbortError') {
    return new ApiError('The request was cancelled.', { kind: 'network' });
  }
  return new ApiError('The browser could not reach the API.', {
    kind: 'network',
    detail: err?.message || String(err),
    hint: usingProxy
      ? 'Check the proxy address, that the proxy is deployed and running, and that its allowed-origins list includes this page.'
      : 'PressReader does not send the CORS headers a browser requires, so a direct call from a web page is blocked before it is sent. Set up the proxy described on the Setup & Help tab.',
  });
}

/* ----------------------------------------------------------------- search -- */

/**
 * Runs one request.
 * @returns {Promise<{items: object[], meta: object, raw: object}>}
 */
export async function fetchPage({ apiKey, conn, body, offset, limit, sort, signal }) {
  const url = buildRequestUrl(conn, { offset, limit, sort });

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['api-key'] = apiKey;

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
  } catch (err) {
    throw describeNetworkError(err, Boolean(conn.proxyUrl));
  }

  if (!response.ok) {
    let text = '';
    try { text = await response.text(); } catch { /* body may be unreadable */ }
    throw describeHttpError(response.status, text);
  }

  let payload;
  try {
    payload = await response.json();
  } catch (err) {
    throw new ApiError('The API replied with something that is not JSON.', {
      kind: 'parse', detail: err.message,
      hint: 'If you use a proxy, it may be returning an error page rather than forwarding the API response.',
    });
  }

  const items = Array.isArray(payload?.items) ? payload.items
    : Array.isArray(payload) ? payload
    : [];
  return { items, meta: payload?.meta || {}, raw: payload };
}

/**
 * Fetches up to `wantTotal` articles, paging as needed.
 * @param {object} options
 * @param {(p: {fetched: number, target: number, page: number, totalCount: number|null}) => void} [options.onProgress]
 * @returns {Promise<{articles: object[], totalCount: number|null, pages: number, truncated: boolean}>}
 */
export async function search({
  apiKey, conn, form, wantTotal = 25, pageSize = 25, startOffset = 0,
  sort = '', keepRaw = true, signal, onProgress, pauseMs = 350,
}) {
  const body = buildRequestBody(form);
  if (!body.query && !body.author) {
    throw new ApiError('Enter something to search for.', { kind: 'config' });
  }

  const target = Math.max(1, Math.min(Number(wantTotal) || 25, 5000));
  const size = Math.max(1, Math.min(Number(pageSize) || 25, 200));

  const articles = [];
  const seen = new Set();
  let offset = Math.max(0, Number(startOffset) || 0);
  let totalCount = null;
  let pages = 0;

  while (articles.length < target) {
    if (signal?.aborted) throw new ApiError('The search was cancelled.', { kind: 'network' });

    const limit = Math.min(size, target - articles.length);
    const { items, meta } = await fetchPage({
      apiKey, conn, body, offset, limit, sort, signal,
    });
    pages += 1;

    if (Number.isFinite(Number(meta?.totalCount))) totalCount = Number(meta.totalCount);

    for (const item of items) {
      const row = normaliseItem(item, { query: body.query || body.author || '', keepRaw });
      if (seen.has(row.id)) continue;      // the API can repeat an item across pages
      seen.add(row.id);
      articles.push(row);
    }

    onProgress?.({ fetched: articles.length, target, page: pages, totalCount });

    if (!items.length) break;                                  // nothing more to give
    if (items.length < limit) break;                           // last partial page
    if (totalCount !== null && offset + items.length >= totalCount) break;
    offset += items.length;

    if (articles.length < target && pauseMs) {
      await new Promise((resolve) => setTimeout(resolve, pauseMs));
    }
  }

  return {
    articles,
    totalCount,
    pages,
    truncated: totalCount !== null && totalCount > articles.length,
  };
}

/**
 * Sends one deliberately tiny request to find out whether this browser can
 * reach the API at all. A 401 is a *success* for this purpose: the request
 * arrived and came back, which is exactly what is being tested.
 */
export async function testConnection({ apiKey, conn, signal }) {
  const started = performance.now();
  try {
    await fetchPage({
      apiKey,
      conn,
      body: { query: 'test' },
      offset: 0,
      limit: 1,
      signal,
    });
    return { ok: true, reachable: true, authed: true, ms: Math.round(performance.now() - started) };
  } catch (err) {
    const ms = Math.round(performance.now() - started);
    if (err instanceof ApiError && err.kind === 'network') {
      return { ok: false, reachable: false, authed: false, ms, error: err };
    }
    // Anything with a status code means the request completed a round trip.
    return {
      ok: false,
      reachable: err instanceof ApiError && err.status !== null,
      authed: false,
      ms,
      error: err,
    };
  }
}

/* ------------------------------------------------------------ sample data -- */

/** Items in the API's own shape, so the demo exercises the real normaliser. */
export function sampleItems() {
  const make = (id, title, subTitle, summary, pub, cid, lang, countries, date, page, author, cats, ents, sentiment) => ({
    publication: {
      cid, title: pub, countries, language: lang, publicationType: 'Newspaper',
      url: `https://www.pressreader.com/${countries[0].toLowerCase()}/${cid}`,
    },
    issue: { date, url: `https://www.pressreader.com/${cid}/${date.replace(/-/g, '')}` },
    page: { number: page, url: `https://www.pressreader.com/${cid}/${date.replace(/-/g, '')}/${page}` },
    article: {
      id, title, subTitle, author,
      authors: author ? [{ id: id * 7, name: author }] : [],
      copyright: `© ${date.slice(0, 4)} ${pub}`,
      media: [{
        type: 'image', typeName: 'image', title: `${title} — photo`, author,
        height: 720, width: 1280,
        url: `https://example.com/media/${id}.jpg`,
        thumbnailUrl: `https://example.com/media/${id}-thumb.jpg`,
      }],
      url: `https://www.pressreader.com/article/${id}`,
    },
    summary,
    categories: cats.map((name, i) => ({ id: 100 + i, name })),
    entities: ents.map((name, i) => ({ id: 200 + i, weight: 90 - i * 7, name, sentiment })),
    sentiment,
  });

  return [
    make(2810001, 'Coffee and culture: the daily ritual that binds us',
      'How a single cup shapes mornings on four continents',
      'Exploring how coffee influences social rituals across continents, from Ethiopian ceremonies to Neapolitan espresso bars.',
      'Global Coffee Times', '0001', 'en', ['US'], '2025-07-28', 4, 'Marta Reyes',
      ['Lifestyle', 'Food & Drink'], ['Ethiopia', 'Italy', 'Starbucks'], 'POSITIVE'),

    make(2810002, 'Sustainable coffee farming takes root in Colombia',
      'Regenerative practices spread through the Eje Cafetero',
      'A closer look at regenerative agriculture in coffee production, and what it means for smallholder incomes.',
      'Eco Agri News', '0002', 'en', ['CO'], '2025-07-25', 12, 'Daniel Okonkwo',
      ['Agriculture', 'Environment'], ['Colombia', 'Fairtrade'], 'POSITIVE'),

    make(2810003, 'Arabica prices hit a four-year high',
      'Drought and freight costs squeeze roasters',
      'Futures climbed for a sixth straight session as traders weighed a poor Brazilian harvest against weakening demand.',
      'The Market Ledger', '0003', 'en', ['GB'], '2025-07-22', 1, 'Priya Raman',
      ['Business', 'Commodities'], ['Brazil', 'ICE Futures'], 'NEGATIVE'),

    make(2810004, 'Le café de spécialité conquiert les villes moyennes',
      'Au-delà de Paris et Lyon',
      'Les torréfacteurs indépendants ouvrent désormais hors des grandes métropoles, portés par une clientèle plus jeune.',
      'Le Quotidien du Café', '0004', 'fr', ['FR'], '2025-07-19', 8, 'Camille Dubois',
      ['Société'], ['Paris', 'Lyon'], 'NEUTRAL'),

    make(2810005, 'Cold brew overtakes iced latte in summer sales',
      null,
      'Retail data shows a decisive shift in what customers order once temperatures pass thirty degrees.',
      'Retail Weekly', '0005', 'en', ['US'], '2025-07-15', 22, 'Jordan Fields',
      ['Business', 'Retail'], ['Dunkin', 'Starbucks'], 'NEUTRAL'),

    make(2810006, 'Caffeine and the ageing brain: what the evidence says',
      'A review of forty years of cohort studies',
      'Researchers caution that observational findings on coffee and cognition remain difficult to separate from lifestyle.',
      'Science Digest', '0006', 'en', ['CA'], '2025-07-11', 30, 'Dr Aisha Bello',
      ['Science', 'Health'], ['University of Toronto'], 'NEUTRAL'),

    make(2810007, 'Kaffeehauskultur unter Druck',
      'Wiener Institution kämpft mit Kosten',
      'Steigende Energiepreise und Personalmangel setzen den traditionellen Kaffeehäusern zu.',
      'Wiener Tagblatt', '0007', 'de', ['AT'], '2025-07-08', 5, 'Lukas Berger',
      ['Kultur', 'Wirtschaft'], ['Wien', 'UNESCO'], 'NEGATIVE'),

    make(2810008, 'Libraries brew community with campus coffee carts',
      'Circulation is up where the espresso is',
      'Several academic libraries report higher gate counts after adding cafés, though staff note new noise-management work.',
      'Library Journal Weekly', '0008', 'en', ['US'], '2025-07-04', 16, 'Paul Nakamura',
      ['Education', 'Libraries'], ['ALA', 'University of Michigan'], 'POSITIVE'),

    make(2810009, 'Vietnam robusta exports rebound after typhoon season',
      null,
      'Shipments from Ho Chi Minh City recovered in June, easing fears of a prolonged supply gap for instant-coffee makers.',
      'Asia Trade Monitor', '0009', 'en', ['VN'], '2025-06-30', 3, 'Linh Tran',
      ['Business', 'Trade'], ['Vietnam', 'Nestlé'], 'POSITIVE'),

    make(2810010, 'The disappearing diner coffee refill',
      'A small American ritual fades',
      'Bottomless cups are quietly vanishing from menus as margins tighten and staffing stays thin.',
      'Heartland Herald', '0010', 'en', ['US'], '2025-06-27', 9, 'Ruth Vance',
      ['Society'], ['Ohio'], 'NEGATIVE'),

    make(2810011, 'Decaf, reconsidered',
      'Better processing is changing the reputation of decaffeinated coffee',
      'Swiss Water and sugarcane processes have narrowed the quality gap enough that specialty roasters now compete on decaf.',
      'Roast & Grind', '0011', 'en', ['AU'], '2025-06-24', 14, 'Ben Whitlock',
      ['Food & Drink'], ['Swiss Water'], 'POSITIVE'),

    make(2810012, 'City council debates café pavement licences',
      'Traders welcome extension; residents object to noise',
      'A consultation closes next month on whether outdoor seating permits granted during the pandemic should be made permanent.',
      'The Riverside Gazette', '0012', 'en', ['GB'], '2025-06-20', 2, null,
      ['Local news', 'Politics'], ['Riverside Council'], 'NEUTRAL'),
  ];
}
