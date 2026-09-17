# 📰 PressReader News Scraper

Search the [PressReader Discovery API](https://www.pressreader.com/), store what you find in a
**SQLite database**, and export it to **Excel, CSV, JSON, Markdown, RIS, BibTeX** or a `.db` file.

Two ways to use it, sharing one database format:

| | [**Web app**](#-the-web-app) | [**Colab notebook**](#-the-colab-notebook) |
| --- | --- | --- |
| Runs in | Your browser | Google Colab (Python) |
| Install anything? | No | No |
| Live API transport | Restricted Worker included | Direct from Python |
| Browse, filter, run SQL | Yes | Not really |
| Export formats | 10 | Markdown + the `.db` |
| Best for | Collecting, exploring and exporting | Getting data with zero setup |

Databases move freely between them: run the notebook, then drag its `.db` onto the web app's
**Database** tab to browse and export it.

---

## 🌐 The web app

**→ [Open the live app](https://systemslibrarian.github.io/pressreader-news-scraper/)**

No application account, installation or article upload. Search results and the SQLite database stay
in your browser. For live searches, the app sends your request and your own PressReader API key
through the site's restricted Cloudflare Worker to PressReader.

- 🔑 **Bring your own PressReader key.** It is held in the tab and written to browser storage only
  if you select *Remember this key*. The Worker code does not log, store, cache or put it in a URL,
  and the key is never written into an export.
- 🛡️ **The proxy is already configured.** Visitors do not need a Cloudflare account or their own
  Worker. The supplied Worker accepts browser requests only from `https://systemslibrarian.github.io`,
  pins the destination to PressReader and rejects direct/script access.
- 🗄️ **A real SQLite database**, built by SQLite compiled to WebAssembly and saved to your browser's
  IndexedDB after every change. Download the `.db` any time and open it in DB Browser for SQLite,
  Python, R — or the notebook.
- 🔍 **Full search form** — boolean queries, phrases, wildcards, `NEAR/n` proximity,
  `category:` / `entity:` / `sentiment:` filters, date ranges, countries, languages, publication
  CIDs, headline-vs-body scope, automatic paging, and optional title-based de-duplication that
  reports how many syndicated copies it skipped.
- 🧹 **Two layers of de-duplication** — article-ID protection is always active; optional title
  matching skips syndicated copies and reports the number skipped. The Results table can also hide
  title duplicates already present without deleting the underlying records.
- 📄 **Browse what you collected** — filter, clear all filters in one click, sort, page, tick rows and
  inspect every field including the raw JSON. The API-key panel collapses after a key is entered to
  keep the search controls compact.
- ⌨️ **A read-only SQL console** with worked examples, and the query result is exportable too.
- 📤 **Ten export formats**, with a live preview of exactly what will be written.
- 🌓 Light and dark themes; works on a phone.
- 🧪 **Sample data** so you can try the whole workflow before you have a key.

### Try it without a key

Open the app and click **Load sample data**. Twelve realistic articles are inserted through the same
code path a live search uses, so every tab — including all ten exports — behaves exactly as it will
with real data. Nothing is sent to PressReader.

### Title de-duplication

**De-duplicate matching titles before saving** is enabled by default. Comparison is case-insensitive,
normalises Unicode, trims the title and collapses repeated whitespace; punctuation remains significant.
The first match in the selected PressReader sort order is kept. The app continues paging until it has
the requested number of unique titles or the API has no more results, and reports how many copies it
skipped.

On the **Results** tab, **Hide repeated titles in this table** collapses duplicates that were already
stored before this feature existed. It changes only the view—it does not delete database rows.

### Export formats

| Format | Notes |
| --- | --- |
| **Excel** `.xlsx` | Bold frozen header, auto-filter, sized columns, **real** date and number cells, plus *By publication*, *By month*, *By language* and *Searches* summary sheets |
| **CSV** / **TSV** | RFC 4180 quoting, CRLF line endings, optional UTF-8 BOM so Excel on Windows keeps your accents |
| **JSON** | With export metadata; the stored raw API response is re-nested as a real object |
| **JSON Lines** `.ndjson` | One article per line, for streaming tools |
| **Markdown** | The readable article-per-section layout the notebook produces |
| **HTML** | A standalone, styled, dark-mode-aware table |
| **RIS** / **BibTeX** | For Zotero, Mendeley, EndNote, LaTeX |
| **SQLite** `.db` | The whole database, articles and search history together |

Choose which columns to include, which rows (everything / current filters / ticked rows / last
search), and the sort order.

> **Formula injection is neutralised by default.** A cell whose text begins with `=`, `+`, `-` or
> `@` is treated as a formula by every spreadsheet program — so a hostile headline could execute
> when you open the file. The app prefixes such cells with an apostrophe. You can turn this off
> under *Format options*.

The Excel writer is this project's own code — no spreadsheet library is downloaded, so exports work
offline and no third party ever touches your data. Its output is validated against `openpyxl`.

---

## The included Worker

**PressReader's API does not send CORS headers.** Verified on 2026-08-25: `api.prod.pressreader.com`
answers no preflight and returns no `Access-Control-Allow-Origin`. Your browser therefore blocks the
request **before it is sent**, no matter how valid your key is. That is a browser security rule, and
nothing in a web page can override it.

The live app is preconfigured with:

```text
https://pressreader-proxy.systemslibrarian.workers.dev
```

Visitors only enter their own PressReader key—there is no proxy setup step. The request path is:

```text
browser → restricted Cloudflare Worker → PressReader Discovery API
```

The Worker in [`proxy/cloudflare-worker.js`](proxy/cloudflare-worker.js):

- accepts the exact browser origin `https://systemslibrarian.github.io` and rejects missing or other
  origins with `403`;
- pins the upstream host to `api.prod.pressreader.com` and the path to `/discovery/`;
- forwards only `api-key`, `content-type` and `accept`;
- returns only `content-type`, never cookies or redirect locations;
- caps request bodies at 64 KB, times out upstream calls after 20 seconds, and disables caching;
- contains no logging, storage, analytics, cookies, KV, Durable Objects or other persistence.

Opening the Worker URL directly returns `{"error":"Origin not allowed"}`. That is the expected
result: a direct visit has no allowed GitHub Pages origin.

[`proxy/README.md`](proxy/README.md) documents the trust boundary and explains how maintainers of
forks can deploy their own Worker. The production Worker intentionally will not serve a fork hosted
under another GitHub account.

**Never use a shared public CORS proxy** (`corsproxy.io`, `allorigins`, `cors-anywhere`…). Whoever
runs one receives your API key in readable form. The app **refuses** to send your key to the known
ones — it fails closed rather than warning. As it happens, none of them work for this anyway.

The included Worker is not a cryptographic authentication mechanism: non-browser software can forge
an `Origin` header. It is a browser-origin and casual quota-abuse control. The pinned upstream and
path ensure that even such a caller cannot turn it into a general-purpose proxy.

---

## 📓 The Colab notebook

[![Open in Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/systemslibrarian/pressreader-news-scraper/blob/main/pressreader_api_to_sqlite.ipynb)

[`pressreader_api_to_sqlite.ipynb`](pressreader_api_to_sqlite.ipynb) searches for a keyword
(`coffee` by default), stores results in `pressreader_coffee_results.db`, and prints them as
Markdown. Duplicates are skipped via a primary key on the article ID.

```bash
pip install requests python-dotenv
```

Set your key as `PRESSREADER_API_KEY` — in Colab Secrets, an environment variable, or a `.env` file.
Then run all cells.

---

## 🔌 About the API

`POST https://api.prod.pressreader.com/discovery/v1/search`, with your key in an **`api-key`**
header (`Ocp-Apim-Subscription-Key` also works).

| Where | Field | Notes |
| --- | --- | --- |
| Query string | `sort` | `relevance` (default) or `date` |
| Query string | `offset`, `limit` | Paging; the app handles this for you |
| Body | `query` | **Required.** `AND` `OR` `NOT`, brackets, `"exact phrase"`, `Colo?r`, `Bro*`, `Trump NEAR/5 Biden`, `category:123`, `entity:345`, `sentiment:POSITIVE` |
| Body | `countries` | **Required.** ISO 3166-1 alpha-2 codes of the publication's country |
| Body | `languages`, `cids`, `author` | ISO 639-1 codes; 4-character publication IDs; author filter |
| Body | `searchIn` | `everywhere` (default), `header`, `body` |
| Body | `startDate`, `endDate` | `YYYY-MM-DD`; start is inclusive, end exclusive |
| Body | `itemTypes` | `article` (default) or `page` |

The response is `{ items: [...], meta: { totalCount, offset, limit } }`. Each item carries
`publication`, `issue`, `page`, `article`, `summary`, `categories`, `entities` and `sentiment` — all
of which the web app stores.

Getting a key is a manual process through PressReader: an
[API access registration](https://pressreader.atlassian.net/wiki/spaces/PD/pages/68091914/Subscription+Key)
ticket, or your account manager.

---

## 🗄️ Database schema

```sql
articles(id PK, title, subtitle, summary, publication, publication_cid, publication_type,
         author, date, page, language, countries, categories, entities, sentiment,
         copyright, url, issue_url, publication_url, page_url, image_url, media_count,
         first_query, first_run_id, fetched_at, raw)

searches(id PK, query, params, endpoint, started_at, finished_at,
         returned, inserted, duplicates, status, message)

article_searches(article_id, search_id, position)   -- which run found what, and where it ranked
```

`raw` holds the untouched API response for each article, so you can reach fields the app does not
model — `SELECT json_extract(raw, '$.entities[0].name') FROM articles;` works, since sql.js ships
with SQLite's JSON functions.

---

## Publishing your own copy

1. Fork or clone this repository.
2. **Settings → Pages → Source: Deploy from a branch → `main` / `/ (root)`.**
3. Wait a minute; your copy appears at `https://<your-username>.github.io/<repo>/`.
4. Deploy your own Worker using [`proxy/cloudflare-worker.js`](proxy/cloudflare-worker.js).
5. Change `ALLOWED_ORIGIN` in the Worker to `https://<your-username>.github.io`—scheme and host
   only, with no repository path or trailing slash.
6. Change `DEFAULT_PROXY_URL` in `assets/app.js` to your Worker URL and deploy the Worker.

Running it locally needs a web server — ES modules and WebAssembly do not load over `file://`:

```bash
python3 -m http.server 8000     # then open http://localhost:8000
```

That does **not** solve CORS. A local server changes your page's address; it has nothing to do with
the request to PressReader, which is still cross-origin and still blocked.

---

## 🗂️ Layout

```
index.html                      the web app
assets/app.js                   UI wiring
assets/db.js                    SQLite (sql.js) + IndexedDB persistence
assets/api.js                   Discovery API client, proxy handling, sample data
assets/title.js                 shared title normalisation for de-duplication
assets/export.js                CSV / JSON / Markdown / HTML / RIS / BibTeX writers
assets/xlsx.js                  dependency-free .xlsx + ZIP writer
assets/styles.css               design system, light and dark
proxy/cloudflare-worker.js      the recommended proxy
proxy/local-proxy.py            a no-account alternative
proxy/README.md                 setup for six hosting options
pressreader_api_to_sqlite.ipynb the Colab notebook
```

One third-party dependency in total: [sql.js](https://sql.js.org) 1.14.2 (SQLite 3.49.1 compiled to
WebAssembly), loaded from jsDelivr with an unpkg fallback. No analytics, no cookies, no tracking.

---

## 🛠 Troubleshooting

| Symptom | Cause |
| --- | --- |
| Worker URL shows `Origin not allowed` | Expected for a direct visit; test it from the app |
| “Failed to fetch” during search | Worker unavailable, wrong Proxy URL/mode, or a network/content blocker |
| App receives `403` from a Worker | The page origin does not exactly match the Worker's `ALLOWED_ORIGIN` |
| `400` from the API | `countries` is required; check the date range and any extra JSON |
| `401` / `403` from the API | Key rejected — check for a stray space, and that your plan covers Discovery search |
| `429` | Rate limited; fetch fewer articles and wait |
| Excel mangles accents in a CSV | Keep the UTF-8 BOM ticked, or export `.xlsx` instead |
| The database vanished | Browser storage is per-profile and private windows discard it. Download the `.db` for anything you want to keep |

The *Setup & Help* tab has a connection test and an environment report for anything else.

---

## ⚠️ Disclaimer

For educational and research use. Respect [PressReader's terms of service](https://www.pressreader.com/)
and your own licence agreement, and mind their rate limits.

## ✨ License

[MIT](LICENSE)

---

**Created by [Paul Clark](https://github.com/systemslibrarian)** — Empowering libraries through data
and innovation 📚⚙️
