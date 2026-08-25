/**
 * PressReader CORS proxy — Cloudflare Worker
 * ------------------------------------------
 * Forwards browser requests to ONE pinned upstream host and adds the CORS
 * headers the upstream does not send. It is NOT an open proxy: the target
 * host and path prefix are hard-coded, so it cannot be pointed anywhere else.
 *
 * The caller's `api-key` header is passed straight through to PressReader and
 * is never logged, stored, cached, or written to a query string.
 *
 * Usage from the browser:
 *   POST https://<your-worker>.workers.dev/discovery/v1/search?limit=5
 *   headers: { "content-type": "application/json", "api-key": "<your key>" }
 * The path and query string are appended to the upstream host unchanged.
 */

// ---------------------------------------------------------------- settings --
const UPSTREAM_HOST = "api.prod.pressreader.com";
const ALLOWED_PATH_PREFIXES = ["/discovery/"];
const ALLOWED_METHODS = ["GET", "POST", "OPTIONS"];

// Only these page origins may use the proxy from a browser.
// Add your GitHub Pages origin. "http://localhost:8000" is for local testing.
const ALLOWED_ORIGINS = [
  "https://systemslibrarian.github.io",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
];

// Request headers forwarded upstream. Everything else is dropped, so no
// cookies, no Authorization, no Referer, no client IP.
const FORWARD_REQUEST_HEADERS = ["api-key", "content-type", "accept"];

// Response headers copied back. Everything else (incl. set-cookie) is dropped.
const FORWARD_RESPONSE_HEADERS = ["content-type"];

const MAX_BODY_BYTES = 64 * 1024;
const UPSTREAM_TIMEOUT_MS = 20_000;

// ------------------------------------------------------------------- logic --
function corsHeaders(origin) {
  const h = new Headers();
  h.set("Access-Control-Allow-Origin", origin);
  h.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  h.set("Access-Control-Allow-Headers", "api-key, content-type, accept");
  h.set("Access-Control-Max-Age", "86400");
  h.set("Vary", "Origin");
  return h;
}

function deny(status, message, origin) {
  const h = origin ? corsHeaders(origin) : new Headers();
  h.set("content-type", "application/json; charset=utf-8");
  h.set("cache-control", "no-store");
  return new Response(JSON.stringify({ error: message }), { status, headers: h });
}

export default {
  async fetch(request) {
    const origin = request.headers.get("Origin");
    const allowed = origin !== null && ALLOWED_ORIGINS.includes(origin);

    // 1. Preflight. Answer before doing anything else, and never call upstream.
    if (request.method === "OPTIONS") {
      if (!allowed) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // 2. Reject browser callers from origins we do not serve.
    //    (A request with no Origin header — curl, a script — is allowed
    //    through but gets no CORS headers, which is all a browser cares about.)
    if (origin !== null && !allowed) return deny(403, "Origin not allowed", null);

    if (!ALLOWED_METHODS.includes(request.method)) {
      return deny(405, "Method not allowed", allowed ? origin : null);
    }

    // 3. Pin the target. The path and query come from the caller; the host
    //    never does, so this cannot be turned into an open proxy.
    const incoming = new URL(request.url);
    if (!ALLOWED_PATH_PREFIXES.some((p) => incoming.pathname.startsWith(p))) {
      return deny(404, "Path not proxied by this Worker", allowed ? origin : null);
    }
    const target = new URL(incoming.pathname + incoming.search, `https://${UPSTREAM_HOST}`);

    // 4. Copy only the headers we explicitly allow.
    const headers = new Headers();
    for (const name of FORWARD_REQUEST_HEADERS) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }

    // 5. Read and size-cap the body.
    let body = null;
    if (request.method !== "GET" && request.method !== "HEAD") {
      const buf = await request.arrayBuffer();
      if (buf.byteLength > MAX_BODY_BYTES) {
        return deny(413, "Request body too large", allowed ? origin : null);
      }
      body = buf;
    }

    // 6. Forward.
    let upstream;
    try {
      upstream = await fetch(target, {
        method: request.method,
        headers,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch {
      // Deliberately does not include the exception: it can echo request data.
      return deny(502, "Upstream request failed", allowed ? origin : null);
    }

    // 7. Return the upstream reply with CORS headers attached.
    const out = allowed ? corsHeaders(origin) : new Headers();
    for (const name of FORWARD_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value !== null) out.set(name, value);
    }
    out.set("cache-control", "no-store");
    return new Response(upstream.body, { status: upstream.status, headers: out });
  },
};
