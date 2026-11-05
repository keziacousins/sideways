FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libharfbuzz0b \
    libffi-dev \
    libgdk-pixbuf-2.0-0 \
    fontconfig \
    fonts-noto-color-emoji \
    fonts-dejavu-core \
    wget \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Pinned: server.py subclasses weasyprint.URLFetcher, an API that arrived in 70
# and replaced default_url_fetcher. An unpinned rebuild is how that change took
# PDF export down, so bump these deliberately.
RUN pip install --no-cache-dir weasyprint==70.0 flask==3.1.3

# Fonts. The build context is infra/ (see infra/compose.yml), so the shared
# font tree is in reach:
#
#   - Redistributable families come from infra/fonts/fonts.lock, pinned and
#     checked against their SHA-256 by fetch-fonts.sh. The "print" entries are
#     the variable fonts print.css has always asked for.
#   - Brand fonts for themed export, one subdirectory per client, mirrored into
#     infra/fonts/brand/ by scripts/sync-brand-assets.sh from the gitignored
#     brand/ tree, so licensed binaries never enter the repo. It ships with
#     only a .gitkeep, and this COPY is a no-op until the sync script has run.
#     fc-cache below recurses, so the per-client nesting costs nothing.
COPY fonts/fonts.lock fonts/fetch-fonts.sh /tmp/fonts/
RUN sh /tmp/fonts/fetch-fonts.sh print /usr/share/fonts/sideways && rm -rf /tmp/fonts
COPY fonts/brand/ /usr/share/fonts/custom/

# Register all fonts with fontconfig
RUN fc-cache -f -v

# Clean up build deps
RUN apt-get purge -y wget unzip && apt-get autoremove -y

WORKDIR /app
COPY weasyprint/server.py /app/server.py

EXPOSE 5001
CMD ["python", "server.py"]
