# PressReader Worker architecture and self-hosting

PressReader's Discovery API does not return the CORS headers required by a browser. The published
web app therefore sends live API requests through one narrowly restricted Cloudflare Worker:

```text
https://pressreader-proxy.systemslibrarian.workers.dev
```

Each visitor supplies their own PressReader API key. Visitors to the published app do **not** need
to deploy anything or create a Cloudflare account.

The Colab notebook does not use the Worker. Python is not subject to browser CORS rules and calls
PressReader directly.

## Trust boundary

A proxy necessarily receives the API key in readable form before forwarding it. TLS protects the
connections, not the endpoint itself. The checked-in Worker code contains no logging, analytics,
storage, cache writes, KV, Durable Objects or cookies. It sends the key only in the upstream request
to PressReader and never places it in a URL.

The Worker is designed to minimise both exposure and quota abuse:

| Control | Behaviour |
| --- | --- |
| Browser origin | Only `https://systemslibrarian.github.io` is accepted |
| Missing/wrong origin | Rejected with `403` before any upstream request |
| Upstream host | Hard-coded to `api.prod.pressreader.com` |
| Allowed path | `/discovery/` only; malformed and traversal paths are rejected |
| Allowed methods | `GET`, `POST`, `OPTIONS` |
| Request headers | Only `api-key`, `content-type`, `accept` |
| Response headers | Only `content-type` plus the Worker's CORS headers |
| Request body | Maximum 64 KB |
| Upstream timeout | 20 seconds |
| Redirects | Rejected rather than exposing a `Location` target |
| Caching | Disabled with `cache-control: no-store` |

An origin check is not cryptographic authentication: non-browser software can forge an `Origin`
header. It blocks other browser sites and casual direct/script use. The pinned host and path still
prevent the Worker from becoming a general-purpose proxy.

GitHub Pages origins contain only the scheme and host. They do not contain the repository path, so
`https://systemslibrarian.github.io/pressreader-news-scraper/` sends this origin:

```text
https://systemslibrarian.github.io
```

## Expected production behaviour

- Opening the bare Worker URL directly returns `403` and `{"error":"Origin not allowed"}`.
- An `OPTIONS` preflight from the allowed GitHub Pages origin returns `204`.
- A live request from the app is forwarded only when its path begins with `/discovery/`.
- The app's **Test connection** action confirms both Worker reachability and API-key acceptance.

Do not diagnose a direct `403` as a failure. Direct browser navigation does not carry the app's
origin and is intentionally refused.

## Deploying a Worker for a fork

The production Worker will not serve a fork under another GitHub account. Fork maintainers should:

1. Sign in to [Cloudflare](https://dash.cloudflare.com), open **Workers & Pages**, and create a
   Worker.
2. Replace the sample code with [`cloudflare-worker.js`](cloudflare-worker.js).
3. Change `ALLOWED_ORIGIN` to the fork's GitHub Pages origin, for example:

   ```js
   const ALLOWED_ORIGIN = "https://yourname.github.io";
   ```

   Do not add a repository path or trailing slash.
4. Deploy the Worker.
5. Change `DEFAULT_PROXY_URL` in `../assets/app.js` to the new `*.workers.dev` address.
6. Leave the app's proxy mode as **Append the path**, then use **Test connection**.

For a Wrangler deployment, use the Worker file as `src/index.js` with a configuration such as:

```toml
name = "pressreader-proxy"
main = "src/index.js"
compatibility_date = "2026-09-17"

[observability]
enabled = false
```

## Local development

The production Worker deliberately rejects localhost. To develop locally, run the included local
proxy and point the app to it:

```bash
python3 proxy/local-proxy.py
python3 -m http.server 8000
```

Then open `http://localhost:8000` and set **Proxy URL** to `http://127.0.0.1:8787`. Modern browser
private-network protections can block a public HTTPS page from reaching a loopback service, so run
both the app and the proxy locally for this configuration.

## Never use an unrelated public CORS proxy

Do not send a PressReader key through services such as `corsproxy.io`, `allorigins`,
`cors-anywhere`, or similar open proxies. Their operators receive the key in readable form and may
log, retain or replay it. The app blocks known public proxy hosts.

## Troubleshooting

| Symptom | Meaning or fix |
| --- | --- |
| Bare Worker URL returns `403` | Expected; direct visits have no allowed origin |
| App's preflight returns `403` | `ALLOWED_ORIGIN` does not exactly match the page origin |
| Worker returns `404` | Requested path did not begin with `/discovery/` |
| Worker returns `413` | Request body exceeded 64 KB |
| Worker returns `502` | PressReader failed, timed out or redirected |
| App reports `401`/`403` from PressReader | The supplied API key was rejected or lacks Discovery access |
| App reports a network error | Check the Worker URL, proxy mode, deployment and local content blockers |

The Worker source in this repository is authoritative. If the Cloudflare editor and the repository
differ, replace the deployed code with [`cloudflare-worker.js`](cloudflare-worker.js) and deploy it
again.
