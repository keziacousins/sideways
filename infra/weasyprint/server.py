"""
Minimal WeasyPrint PDF rendering service.
Accepts HTML via POST, returns PDF bytes.
"""

from flask import Flask, request, Response
from weasyprint import HTML
from weasyprint.text.fonts import FontConfiguration
import io
import os

app = Flask(__name__)
font_config = FontConfiguration()


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
        html = HTML(string=html_content)
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
