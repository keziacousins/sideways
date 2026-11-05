FROM node:22-bookworm-slim

# Typst draws text as glyph outlines, so the fonts only have to exist here, not
# in WeasyPrint or the reader's browser. DejaVu Sans is the prelude's default
# (see prelude.typ) and the family the rest of the print pipeline already pins.
RUN apt-get update && apt-get install -y --no-install-recommends fonts-dejavu-core && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json packages.json fetch-packages.mjs /app/

# npm ci runs fetch-packages.mjs (postinstall), which downloads the pinned
# Typst packages and checks each against its SHA-256. This is the only point
# at which anything here touches the network: the render workers can't.
RUN npm ci --omit=dev --no-audit --no-fund && chmod -R a+rX /app/vendor

COPY server.mjs worker.mjs prelude.typ /app/

# Diagram source is a program written by a document author; nothing here runs
# as root.
USER node

EXPOSE 5003
CMD ["node", "server.mjs"]
