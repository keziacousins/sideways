"""
Minimal WeasyPrint PDF rendering service.
Accepts HTML via POST, returns PDF bytes.
"""

import io
import ipaddress
import os
import socket
from urllib.parse import urlparse

from flask import Flask, request, Response
from weasyprint import HTML, default_url_fetcher
from weasyprint.text.fonts import FontConfiguration

app = Flask(__name__)
font_config = FontConfiguration()


def safe_url_fetcher(url, timeout=10, ssl_context=None):
    """
    Restricted URL fetcher for WeasyPrint.

    Document HTML contains user-controlled <img>/<link>/CSS @import URLs.
    Without a custom fetcher, WeasyPrint would happily fetch
    http://169.254.169.254/ (cloud metadata), http://localhost:4445/
    (Hydra admin), or any other internal address from the container's
    network — turning every PDF export into an SSRF primitive.

    Policy:
      - data: URLs are always allowed (embedded logos, inline images).
      - http/https URLs are allowed only when the host resolves to a
        non-private, non-loopback, non-link-local public address.
      - All other schemes (file://, gopher://, ftp://, …) are rejected.

    Note: this checks addresses at the call site; a DNS rebind attack could
    in principle resolve to a different IP at fetch time. Mitigated by the
    container not having direct access to the host network unless the
    operator wires it that way.
    """
    parsed = urlparse(url)
    scheme = parsed.scheme.lower()

    if scheme == "data":
        return default_url_fetcher(url, timeout=timeout, ssl_context=ssl_context)

    if scheme not in ("http", "https"):
        raise ValueError(f"Refusing URL with disallowed scheme: {scheme!r}")

    host = parsed.hostname
    if not host:
        raise ValueError("URL has no host component")

    try:
        addr_info = socket.getaddrinfo(host, None)
    except socket.gaierror as e:
        raise ValueError(f"Cannot resolve host {host!r}: {e}")

    for entry in addr_info:
        addr = entry[4][0]
        # Strip IPv6 zone if present
        if "%" in addr:
            addr = addr.split("%", 1)[0]
        try:
            ip = ipaddress.ip_address(addr)
        except ValueError:
            raise ValueError(f"Could not parse resolved address: {addr!r}")
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_multicast
            or ip.is_reserved
            or ip.is_unspecified
        ):
            raise ValueError(
                f"Refusing URL {url!r}: resolves to non-public address {addr}"
            )

    return default_url_fetcher(url, timeout=timeout, ssl_context=ssl_context)


@app.route("/health", methods=["GET"])
def health():
    return {"status": "ok"}


@app.route("/render", methods=["POST"])
def render():
    """
    Render HTML to PDF.

    Accepts:
      - Content-Type: text/html — raw HTML body
      - Content-Type: application/json — { "html": "..." }

    Returns: application/pdf
    """
    content_type = request.content_type or ""

    if "application/json" in content_type:
        data = request.get_json()
        html_content = data.get("html", "")
    else:
        html_content = request.get_data(as_text=True)

    if not html_content:
        return {"error": "No HTML content provided"}, 400

    try:
        html = HTML(string=html_content, url_fetcher=safe_url_fetcher)
        pdf_bytes = html.write_pdf(font_config=font_config)

        return Response(
            pdf_bytes,
            mimetype="application/pdf",
            headers={"Content-Disposition": "inline; filename=document.pdf"},
        )
    except Exception as e:
        return {"error": str(e)}, 500


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5001))
    app.run(host="0.0.0.0", port=port)
