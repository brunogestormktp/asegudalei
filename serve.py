#!/usr/bin/env python3
"""
Servidor local para o projeto segundalei_app.
Execute: python3 serve.py
"""

import http.server
import socketserver
import webbrowser
import os

PORT = 8000
DIRECTORY = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def log_message(self, format, *args):
        print(f"  {self.address_string()} - {format % args}")


if __name__ == "__main__":
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
