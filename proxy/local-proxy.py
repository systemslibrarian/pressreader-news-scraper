#!/usr/bin/env python3
"""Local-only CORS proxy for the PressReader Discovery API.

Run it on your own machine, point the app's "Proxy URL" at http://127.0.0.1:8787,
and your API key never leaves your computer.

    python3 local-proxy.py         # then open the app and use http://127.0.0.1:8787

IMPORTANT: serve the app itself locally too --

    python3 -m http.server 8000    # then open http://localhost:8000

Chrome blocks a page loaded over public HTTPS (a github.io address) from
reaching a loopback address such as this proxy: "Permission was denied for
this request to access the `loopback` address space". Serving the page from
localhost puts both sides in the same address space, so the block does not
apply. If you would rather use the hosted copy of the app, deploy the
Cloudflare Worker instead -- it has a public HTTPS address.

Requires nothing but a standard Python 3 install. Ctrl-C to stop.
"""
import http.server
import urllib.request
import urllib.error

UPSTREAM = "https://api.prod.pressreader.com"
ALLOWED_PREFIX = "/discovery/"
PORT = 8787
# The page origins allowed to use this proxy.
ALLOWED_ORIGINS = {
    "http://localhost:8000",
    "http://127.0.0.1:8000",
    # Kept for completeness, but see the note above: current Chrome blocks a
    # public HTTPS page from reaching loopback regardless of these headers.
    "https://systemslibrarian.github.io",
}
FORWARD = ("api-key", "content-type", "accept")


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):          # keep the key out of the console
        pass

    def _cors(self, origin):
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "api-key, content-type, accept")
        self.send_header("Access-Control-Max-Age", "86400")
        # Chrome's Private Network Access check, for a page that is allowed to
        # reach loopback at all. Newer Chrome also asks the user's permission.
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Vary", "Origin")

    def _origin(self):
        o = self.headers.get("Origin")
        return o if o in ALLOWED_ORIGINS else None

    def do_OPTIONS(self):
        origin = self._origin()
        if origin is None:
            self.send_response(403); self.send_header("Content-Length", "0"); self.end_headers(); return
        self.send_response(204)
        self._cors(origin)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        self._proxy("GET")

    def do_POST(self):
        self._proxy("POST")

    def _proxy(self, method):
        origin = self._origin()
        if self.headers.get("Origin") is not None and origin is None:
            self._short(403, b'{"error":"Origin not allowed"}', None); return
        if not self.path.startswith(ALLOWED_PREFIX):
            self._short(404, b'{"error":"Path not proxied"}', origin); return

        length = int(self.headers.get("Content-Length") or 0)
        if length > 64 * 1024:
            self._short(413, b'{"error":"Body too large"}', origin); return
        body = self.rfile.read(length) if length else None

        req = urllib.request.Request(UPSTREAM + self.path, data=body, method=method)
        for name in FORWARD:
            value = self.headers.get(name)
            if value is not None:
                req.add_header(name, value)
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                status, payload, ctype = r.status, r.read(), r.headers.get("Content-Type", "application/json")
        except urllib.error.HTTPError as e:                    # pass 4xx/5xx through
            status, payload, ctype = e.code, e.read(), e.headers.get("Content-Type", "application/json")
        except Exception:
            status, payload, ctype = 502, b'{"error":"Upstream request failed"}', "application/json"
        self._short(status, payload, origin, ctype)

    def _short(self, status, payload, origin, ctype="application/json"):
        self.send_response(status)
        if origin:
            self._cors(origin)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


if __name__ == "__main__":
    print(f"Local PressReader proxy on http://127.0.0.1:{PORT}  (Ctrl-C to stop)")
    http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
