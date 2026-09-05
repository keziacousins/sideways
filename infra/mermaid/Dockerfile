FROM node:22-bookworm-slim

# Where `playwright install` puts the browser. Set explicitly so the download
# lands outside the app dir and stays readable by the non-root runtime user.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app
COPY package.json /app/package.json

# mermaid is pinned at the top level as well as being a dependency of
# mermaid-isomorphic: npm hoists the one copy, which is the copy
# mermaid-isomorphic injects into the render page. The pin is what keeps the
# sidecar and the browser bundle on the same mermaid version.
RUN npm install --omit=dev --no-audit --no-fund

# Chromium only — firefox and webkit would roughly triple the image and this
# service never uses them. --with-deps installs just the system libraries
# Chromium needs (fonts, nss, libdrm, …) via apt.
RUN npx playwright install --with-deps chromium && \
    chmod -R a+rX /ms-playwright && \
    rm -rf /var/lib/apt/lists/*

COPY server.js /app/server.js

# Untrusted diagram text goes to a real browser, so nothing here runs as root.
USER node

EXPOSE 5002
CMD ["node", "server.js"]
