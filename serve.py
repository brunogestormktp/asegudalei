#!/usr/bin/env python3
"""
Servidor local para o projeto segundalei_app.
Execute: python3 serve.py
"""

import http.server
import socketserver
import webbrowser
import os
import sys

PORT = 8000
DIRECTORY = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def log_message(self, format, *args):
        print(f"  {self.address_string()} - {format % args}")

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


if __name__ == "__main__":
    # Allow reuse of port if previous server didn't close cleanly
    socketserver.TCPServer.allow_reuse_address = True

    try:
        with socketserver.TCPServer(("", PORT), Handler) as httpd:
            url = f"http://localhost:{PORT}"
            print("=" * 45)
            print("  🚀 Servidor local iniciado!")
            print(f"  📂 Diretório: {DIRECTORY}")
            print(f"  🌐 URL: {url}")
            print("  ⛔  Para parar: Ctrl+C")
            print("=" * 45)
            webbrowser.open(url)
            try:
                httpd.serve_forever()
            except KeyboardInterrupt:
                print("\n  Servidor encerrado.")
    except OSError as e:
        if "Address already in use" in str(e):
            print(f"\n  ❌ Porta {PORT} já está em uso!")
            print(f"  💡 Tente: lsof -ti:{PORT} | xargs kill -9")
            sys.exit(1)
        raise
