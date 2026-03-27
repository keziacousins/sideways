FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libharfbuzz0b \
    libffi-dev \
    libgdk-pixbuf-2.0-0 \
    fontconfig \
    wget \
    unzip \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir weasyprint flask

# Download Inter Variable TTF (files are at zip root, no subdirectory)
RUN mkdir -p /usr/share/fonts/inter && \
    wget -q "https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip" -O /tmp/inter.zip && \
    unzip -j /tmp/inter.zip "InterVariable.ttf" "InterVariable-Italic.ttf" -d /usr/share/fonts/inter/ && \
    rm /tmp/inter.zip

# Download JetBrains Mono Variable TTF
RUN mkdir -p /usr/share/fonts/jetbrains-mono && \
    wget -q "https://github.com/JetBrains/JetBrainsMono/releases/download/v2.304/JetBrainsMono-2.304.zip" -O /tmp/jbmono.zip && \
    unzip -j /tmp/jbmono.zip "fonts/variable/*.ttf" -d /usr/share/fonts/jetbrains-mono/ && \
    rm /tmp/jbmono.zip

# Download Newsreader Variable TTF from Google Fonts GitHub
RUN mkdir -p /usr/share/fonts/newsreader && \
    wget -q "https://raw.githubusercontent.com/google/fonts/main/ofl/newsreader/Newsreader%5Bopsz%2Cwght%5D.ttf" \
      -O /usr/share/fonts/newsreader/Newsreader-Variable.ttf && \
    wget -q "https://raw.githubusercontent.com/google/fonts/main/ofl/newsreader/Newsreader-Italic%5Bopsz%2Cwght%5D.ttf" \
      -O /usr/share/fonts/newsreader/Newsreader-Italic-Variable.ttf

# Register fonts with fontconfig
RUN fc-cache -f -v

# Clean up build deps
RUN apt-get purge -y wget unzip && apt-get autoremove -y

WORKDIR /app
COPY server.py /app/server.py

EXPOSE 5001
CMD ["python", "server.py"]
