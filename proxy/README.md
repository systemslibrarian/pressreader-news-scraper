# Why this folder exists

PressReader's Discovery API **does not send CORS headers**. Verified on 2026-08-25 against
`api.prod.pressreader.com`: it answers no `OPTIONS` preflight and returns no
`Access-Control-Allow-Origin` on any response.

That means a web page — including the one in this repository — **cannot call it directly**.
Your browser blocks the request before it is sent, no matter how valid your API key is. This
is a browser security rule; no client-side trick works around it, and none should.

The fix is a **proxy you deploy yourself**: a few lines of code, running on a free host, that
receives the request from your page, forwards it to PressReader, and adds the missing header
to the reply.

> **This does not apply to the Colab notebook.** The same-origin policy is a browser rule, and
> Python is not a browser. `pressreader_api_to_sqlite.ipynb` calls the API directly with no
> proxy involved.

---

## What the proxy must *not* be

**Never use a shared public CORS proxy** — `corsproxy.io`, `api.allorigins.win`,
`cors-anywhere.herokuapp.com`, `thingproxy` and friends.

A CORS proxy is a deliberate man-in-the-middle. Whoever operates it receives your `api-key`
header **in readable form** on their server; TLS protects the wire, not the endpoint. They can
log it, keep it, or have it breached or subpoenaed. You cannot audit that, and you cannot
un-leak a key — you can only rotate it. An intermediary can also alter the response on its way
back, which would quietly corrupt a research dataset.

As it happens, none of them work for this anyway. Probed on 2026-08-25 with the exact preflight
this app sends:

| Service | Result |
| --- | --- |
| `corsproxy.io` | `403` on preflight from a `github.io` origin |
| `api.allorigins.win` | no `OPTIONS` handler at all — a custom header is impossible |
| `thingproxy.freeboard.io` | connection failure; the service is dead |
| `cors-anywhere.herokuapp.com` | `403` → requires a manual per-browser opt-in at `/corsdemo` |

The app refuses to send your key to any of these hosts. That is deliberate: a warning label
loses to a working button at 4:55 pm, so it fails closed instead.

---

## Option 1 — Cloudflare Worker (recommended)

Free, no credit card, ~100,000 requests a day, and the most likely of these to still work
unchanged in five years.

1. Sign in at [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages** →
   **Create** → **Worker**.
2. Give it a name, click **Deploy**, then **Edit code**.
3. Replace everything in the editor with [`cloudflare-worker.js`](cloudflare-worker.js) and
   **Deploy** again.
4. **Edit `ALLOWED_ORIGINS`** in the code so only your own page can use it. If you host this
   app at `https://yourname.github.io`, that exact string is what belongs there — scheme and
   host, no trailing slash, no path.
5. Copy the `https://….workers.dev` address into the app's **Proxy URL** box on the
   *Setup & Help* tab, leave the mode as **Append the path**, and click **Test connection**.

Deploying with `wrangler` instead? Put the file at `src/index.js` and use:

```toml
name = "pressreader-cors-proxy"
main = "src/index.js"
compatibility_date = "2026-08-25"

[observability]
enabled = false          # keep request logs off; they are not needed here
```

### What the Worker does and does not do

- The upstream host is **hard-coded**, and only the `/discovery/` path prefix is forwarded, so
  it cannot be turned into an open proxy for anything else.
- Only `api-key`, `content-type` and `accept` go upstream. No cookies, no `Authorization`, no
  `Referer`.
- Only `content-type` comes back. `set-cookie` and everything else is dropped.
- Bodies are capped at 64 KB and upstream requests time out after 20 seconds.
- Your key is never logged, stored, cached, or put in a query string.
- Failures return a fixed message rather than echoing the exception, which could contain
  request data.

---

## Option 2 — run it on your own machine

[`local-proxy.py`](local-proxy.py) needs nothing but a standard Python 3 install:

```bash
python3 local-proxy.py
# Local PressReader proxy on http://127.0.0.1:8787  (Ctrl-C to stop)
```

Then set **Proxy URL** to `http://127.0.0.1:8787`.

This is the strongest privacy position available: no account, no third party, and the key never
leaves your computer. It binds to `127.0.0.1` only — nothing else on your network can reach it —
and it does not log requests.

It works even with the app served from GitHub Pages, because browsers treat `localhost` as a
secure origin and allow an HTTPS page to reach it. Edit `ALLOWED_ORIGINS` in the file to include
the address you load the app from.

The trade-off: it has to be running each time, it is per-machine, and you cannot share it with a
colleague.

---

## Option 3 — other hosts

The same handler runs anywhere with a `Request` → `Response` API. Take the `fetch` function out
of `cloudflare-worker.js` and wrap it:

**Deno Deploy** — [console.deno.com](https://console.deno.com) → Playground → paste → Deploy.
Free tier is generous (1M requests/month).

```js
// Deploy Classic (dash.deno.com) was shut down on 2026-07-20 — use console.deno.com.
Deno.serve(handler);
```

**Val Town** — the fastest of all, roughly two minutes: sign in, New → HTTP val, paste, done.
Note that free vals have **public source** — fine here, since the code holds no secret.

```js
export default async function (req) { return handler(req); }
```

**Vercel** — needs a repo or the CLI, plus a `vercel.json` rewrite.

```js
export default { fetch: handler };
```

**Netlify** — needs a repo, the CLI, or a drag-and-drop deploy; put the file at
`netlify/functions/proxy.mjs`.

```js
export default async (req) => handler(req);
export const config = { path: '/discovery/*' };
```

**Google Apps Script is the one to avoid**, even though librarians know it best. It cannot read
or set HTTP headers and cannot answer a preflight, so it cannot pass an `api-key` header at all.
Only reach for it if institutional policy forbids every other account.

---

## Ranked, for someone who has never deployed anything

1. **Cloudflare Worker** — ~5 minutes, no card, biggest free tier, most durable. *Use this.*
2. **Val Town** — ~2 minutes if you want it working right now. Small company; treat it as
   convenient rather than permanent.
3. **Local Python script** — no account at all, best privacy, but only on your own machine.
4. **Deno Deploy** — nearly as easy as Val Town; most tutorials still show the retired UI.
5. **Netlify / Vercel** — fine platforms, three or four times the steps.
6. **Apps Script** — cannot do the job.

---

## Troubleshooting

**"Could not reach the API" with a proxy configured.** Check the address character for character,
that the Worker is deployed (open it in a browser — it should answer, not 404), and that
`ALLOWED_ORIGINS` contains the origin the app reports on the *Setup & Help* tab.

**403 from your own Worker.** The `Origin` your browser sends is not in `ALLOWED_ORIGINS`. It must
match exactly — `https://name.github.io`, not `https://name.github.io/repo/`.

**404 from your own Worker.** The path did not begin with `/discovery/`. Check the API endpoint
setting, and that the proxy mode is **Append the path**.

**It works from `curl` but not from the browser.** `curl` sends no `Origin` header, so CORS never
applies. That is expected, and it confirms the upstream side is fine — the problem is the origin
allowlist.

**`python -m http.server` does not fix CORS.** Serving the page locally changes *your page's*
address; it has nothing to do with the request to PressReader, which is still cross-origin and
still blocked. You do need it to run the app from your own machine at all — ES modules will not
load over `file://` — but it does nothing for the API call.
