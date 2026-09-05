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

RUN pip install --no-cache-dir weasyprint flask

# Download Inter Variable TTF (files are at zip root, no subdirectory)
RUN mkdir -p /usr/share/fonts/inter && \
    wget -q "https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip" -O /tmp/inter.zip && \
    unzip -j /tmp/inter.zip "InterVariable.ttf" "InterVariable-Italic.ttf" -d /usr/share/fonts/inter/ && \
    rm /tmp/inter.zip

# Download Fira Code Variable TTF
RUN mkdir -p /usr/share/fonts/fira-code && \
    wget -q "https://github.com/tonsky/FiraCode/releases/download/6.2/Fira_Code_v6.2.zip" -O /tmp/firacode.zip && \
    unzip -j /tmp/firacode.zip "variable_ttf/FiraCode-VF.ttf" -d /usr/share/fonts/fira-code/ && \
    rm /tmp/firacode.zip

# Download Newsreader Variable TTF from Google Fonts GitHub
RUN mkdir -p /usr/share/fonts/newsreader && \
    wget -q "https://raw.githubusercontent.com/google/fonts/main/ofl/newsreader/Newsreader%5Bopsz%2Cwght%5D.ttf" \
      -O /usr/share/fonts/newsreader/Newsreader-Variable.ttf && \
    wget -q "https://raw.githubusercontent.com/google/fonts/main/ofl/newsreader/Newsreader-Italic%5Bopsz%2Cwght%5D.ttf" \
      -O /usr/share/fonts/newsreader/Newsreader-Italic-Variable.ttf

# Download Oswald Variable TTF from Google Fonts GitHub
RUN mkdir -p /usr/share/fonts/oswald && \
    wget -q "https://raw.githubusercontent.com/google/fonts/main/ofl/oswald/Oswald%5Bwght%5D.ttf" \
      -O /usr/share/fonts/oswald/Oswald-Variable.ttf

# Download EB Garamond Variable TTF from Google Fonts GitHub
RUN mkdir -p /usr/share/fonts/eb-garamond && \
    wget -q "https://raw.githubusercontent.com/google/fonts/main/ofl/ebgaramond/EBGaramond%5Bwght%5D.ttf" \
      -O /usr/share/fonts/eb-garamond/EBGaramond-Variable.ttf && \
    wget -q "https://raw.githubusercontent.com/google/fonts/main/ofl/ebgaramond/EBGaramond-Italic%5Bwght%5D.ttf" \
      -O /usr/share/fonts/eb-garamond/EBGaramond-Italic-Variable.ttf

# Brand fonts for themed PDF export, one subdirectory per client. The tree is
# mirrored here by scripts/sync-brand-assets.sh from the gitignored brand/
# directory, so licensed binaries never enter the repo — it ships with only a
# .gitkeep, and this COPY is a no-op until the sync script has run.
# fc-cache below recurses, so the per-client nesting costs nothing.
COPY fonts/ /usr/share/fonts/custom/

# Register all fonts with fontconfig
RUN fc-cache -f -v

# Clean up build deps
RUN apt-get purge -y wget unzip && apt-get autoremove -y

WORKDIR /app
COPY server.py /app/server.py

EXPOSE 5001
CMD ["python", "server.py"]
