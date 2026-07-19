#!/usr/bin/env python3
"""Static file server for HBGBs HQ that disables caching.

Python's stock http.server sends no cache headers, so browsers cache CSS/JS
aggressively and show stale dashboards after an update. This sends no-store on
every response so a plain reload always gets the latest files.

Usage: python scripts/serve.py [port]   (default 8642, serves project root)
"""
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8642


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Expires", "0")
        super().end_headers()


if __name__ == "__main__":
    print(f"HBGBs HQ (no-cache) on http://localhost:{PORT}/site/")
    ThreadingHTTPServer(("", PORT), NoCacheHandler).serve_forever()
