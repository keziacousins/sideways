FROM node:22-bookworm-slim

# Built from infra/ (see infra/compose.yml) so the shared font tree is in reach.

# DejaVu stays as the last-resort fallback. wget and unzip are for fetching
# fonts below and are removed again afterwards; ca-certificates is what lets
# wget verify TLS at all (the slim base image ships without it).
RUN apt-get update && apt-get install -y --no-install-recommends fonts-dejavu-core ca-certificates wget unzip && \
    rm -rf /var/lib/apt/lists/*

# Fonts. Typst draws text as glyph outlines, so a diagram's fonts only have to
# exist here, not in WeasyPrint or the reader's browser.
#
#   - Defaults (Inter, Fira Code, Newsreader — the families the web app and
#     print use) come from infra/fonts/fonts.lock, pinned and checked by
#     fetch-fonts.sh. The "typst" entries are static instances: Typst does not
#     support variable fonts. They go under /usr/share/fonts, which every
#     diagram sees.
#   - Brand fonts go to /fonts/brand/<client>/, deliberately OUTSIDE
#     /usr/share/fonts. The compiler also loads system fonts, and an author
#     can name any family in a diagram, so a licensed face installed with the
#     system fonts would be usable from every space. Instead a worker loads a
#     client's directory only when the API asks for that font set, which it
#     derives from the space's theme (see worker.mjs).
COPY fonts/fonts.lock fonts/fetch-fonts.sh /tmp/fonts/
RUN sh /tmp/fonts/fetch-fonts.sh typst /usr/share/fonts/sideways && rm -rf /tmp/fonts && \
    apt-get purge -y wget unzip && apt-get autoremove -y
COPY fonts/brand/ /fonts/brand/
ENV TYPST_FONT_PATHS=/usr/share/fonts TYPST_BRAND_FONT_DIR=/fonts/brand

WORKDIR /app
COPY typst/package.json typst/package-lock.json typst/packages.json typst/fetch-packages.mjs /app/

# npm ci runs fetch-packages.mjs (postinstall), which downloads the pinned
# Typst packages and checks each against its SHA-256. This and the font fetch
# above are the only points at which anything here touches the network: the
# render workers can't.
RUN npm ci --omit=dev --no-audit --no-fund && chmod -R a+rX /app/vendor

COPY typst/server.mjs typst/worker.mjs typst/prelude.typ /app/

# Diagram source is a program written by a document author; nothing here runs
# as root.
USER node

EXPOSE 5003
CMD ["node", "server.mjs"]
