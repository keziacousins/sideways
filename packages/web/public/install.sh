#!/bin/sh
# Install the Sideways CLI
# Usage: curl -fsSL https://your-instance/install.sh | sh -s -- https://your-instance
set -e

BASE_URL="${1:-${SIDEWAYS_URL:-}}"

if [ -z "$BASE_URL" ]; then
  echo "Error: No server URL provided."
  echo "Usage: curl -fsSL https://your-instance/install.sh | sh -s -- https://your-instance"
  exit 1
fi

# Strip trailing slash
BASE_URL="${BASE_URL%/}"

INSTALL_DIR="${SIDEWAYS_INSTALL_DIR:-$HOME/.local/bin}"

echo "Installing Sideways CLI from $BASE_URL..."

# Check for Node.js
if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js is required. Install from https://nodejs.org"
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo "Error: Node.js 18+ required (found v$(node -v))"
  exit 1
fi

mkdir -p "$INSTALL_DIR"

# Download CLI bundle
curl -fsSL "$BASE_URL/downloads/sideways.cjs" -o "$INSTALL_DIR/sideways.cjs"

# Create wrapper
cat > "$INSTALL_DIR/sideways" <<WRAPPER
#!/bin/sh
exec node "\$(dirname "\$0")/sideways.cjs" "\$@"
WRAPPER
chmod +x "$INSTALL_DIR/sideways"

echo ""
echo "Installed to $INSTALL_DIR/sideways"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    echo ""
    echo "Add to your PATH:"
    echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
    ;;
esac

echo ""
echo "Get started:"
echo "  sideways init <space> --api $BASE_URL"
