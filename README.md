# 📰 PressReader News Scraper

Search the [PressReader Discovery API](https://www.pressreader.com/), store what you find in a
**SQLite database**, and export it to **Excel, CSV, JSON, Markdown, RIS, BibTeX** or a `.db` file.

Two ways to use it, sharing one database format:

| | [**Web app**](#-the-web-app) | [**Colab notebook**](#-the-colab-notebook) |
| --- | --- | --- |
| Runs in | Your browser | Google Colab (Python) |
| Install anything? | No | No |
| Needs a proxy? | **Yes** — [CORS](#why-a-proxy-is-needed) | No |
| Browse, filter, run SQL | Yes | Not really |
| Export formats | 10 | Markdown + the `.db` |
| Best for | Collecting, exploring and exporting | Getting data with zero setup |

Databases move freely between them: run the notebook, then drag its `.db` onto the web app's
**Database** tab to browse and export it.

---

## 🌐 The web app

**→ [Open it](https://systemslibrarian.github.io/pressreader-news-scraper/)** *(once GitHub Pages
is enabled — see [Publishing](#publishing-your-own-copy))*

No account, no server, no upload. Everything happens in your browser tab.

- 🔑 **Your key stays yours.** Held in the tab; written to browser storage only if you tick
  *Remember this key*. It goes to PressReader (or your own proxy) and nowhere else, and is never
  written into an export.
- 🗄️ **A real SQLite database**, built by SQLite compiled to WebAssembly and saved to your browser's
  IndexedDB after every change. Download the `.db` any time and open it in DB Browser for SQLite,
  Python, R — or the notebook.
- 🔍 **Full search form** — boolean queries, phrases, wildcards, `NEAR/n` proximity,
  `category:` / `entity:` / `sentiment:` filters, date ranges, countries, languages, publication
  CIDs, headline-vs-body scope, and automatic paging up to the number of articles you ask for.
- 📄 **Browse what you collected** — filter, sort, page, tick rows, inspect every field including the
  raw JSON.
- ⌨️ **A read-only SQL console** with worked examples, and the query result is exportable too.
- 📤 **Ten export formats**, with a live preview of exactly what will be written.
- 🌓 Light and dark themes; works on a phone.
- 🧪 **Sample data** so you can try the whole workflow before you have a key.

### Try it without a key

Open the app and click **Load sample data**. Twelve realistic articles are inserted through the same
code path a live search uses, so every tab — including all ten exports — behaves exactly as it will
with real data. Nothing is sent to PressReader.

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

## Why a proxy is needed

**PressReader's API does not send CORS headers.** Verified on 2026-08-25: `api.prod.pressreader.com`
answers no preflight and returns no `Access-Control-Allow-Origin`. Your browser therefore blocks the
request **before it is sent**, no matter how valid your key is. That is a browser security rule, and
nothing in a web page can override it.

The published web app is preconfigured to use its own Cloudflare Worker. Each visitor enters their
own PressReader API key; the Worker forwards it only to PressReader and does not log, store, cache,
or place it in a URL. [`proxy/README.md`](proxy/README.md) explains the design and how publishers of
forks can deploy their own copy.

- **[`proxy/cloudflare-worker.js`](proxy/cloudflare-worker.js)** — recommended. Free, no credit card.
  The upstream host and path prefix are hard-coded so it can never become an open proxy; only
  `api-key`, `content-type` and `accept` are forwarded; your key is never logged or cached.
- **[`proxy/local-proxy.py`](proxy/local-proxy.py)** — no account at all. Plain Python 3 standard
  library, binds to `127.0.0.1` only, logs nothing. Your key never leaves your computer.

**Never use a shared public CORS proxy** (`corsproxy.io`, `allorigins`, `cors-anywhere`…). Whoever
runs one receives your API key in readable form. The app **refuses** to send your key to the known
ones — it fails closed rather than warning. As it happens, none of them work for this anyway.

**Don't want to deploy anything?** Use the notebook. Python is not a browser, so CORS never applies.

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
4. Deploy a proxy ([`proxy/README.md`](proxy/README.md)) and add **your** Pages address to its
   `ALLOWED_ORIGIN` setting. Change `DEFAULT_PROXY_URL` in `assets/app.js` to your Worker URL.

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
| “Failed to fetch” the moment you search | No proxy configured — see [above](#why-a-proxy-is-needed) |
| `403` from *your own* proxy | Your page's address does not match its `ALLOWED_ORIGIN` setting |
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
