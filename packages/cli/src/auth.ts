import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes, createHash } from "node:crypto";

const TOKEN_DIR = join(homedir(), ".sideways");
const TOKEN_FILE = join(TOKEN_DIR, "token.json");

interface StoredCredentials {
  api_key: string;
  api_url: string;
}

export function getStoredCredentials(): StoredCredentials | null {
  if (!existsSync(TOKEN_FILE)) return null;
  try {
    return JSON.parse(readFileSync(TOKEN_FILE, "utf-8"));
  } catch {
    return null;
  }
}

export function storeCredentials(creds: StoredCredentials): void {
  mkdirSync(TOKEN_DIR, { recursive: true });
  writeFileSync(TOKEN_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

export function clearCredentials(): void {
  if (existsSync(TOKEN_FILE)) {
    writeFileSync(TOKEN_FILE, "");
  }
}

/**
 * OAuth2 authorization code flow with PKCE.
 * After getting a JWT, immediately creates an API key and stores it.
 */
export async function login(
  hydraPublicUrl: string,
  apiUrl: string,
): Promise<void> {
  const clientId = "sideways-cli";
  const redirectPort = 19876;
  const redirectUri = `http://localhost:${redirectPort}/callback`;

  // Generate PKCE challenge
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256")
    .update(verifier)
    .digest("base64url");

  const state = randomBytes(16).toString("hex");

  const authUrl = new URL(`${hydraPublicUrl}/oauth2/auth`);
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "openid offline_access");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  console.log("\nOpen this URL to sign in:\n");
  console.log(`  ${authUrl.toString()}\n`);
  console.log("Waiting for callback...\n");

  // Wait for the callback
  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url!, `http://localhost:${redirectPort}`);

      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end();
        return;
      }

      const error = url.searchParams.get("error");
      if (error) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<h1>Login failed</h1><p>You can close this tab.</p>");
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      const returnedState = url.searchParams.get("state");
      if (returnedState !== state) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<h1>Login failed</h1><p>State mismatch.</p>");
        server.close();
        reject(new Error("State mismatch"));
        return;
      }

      const code = url.searchParams.get("code");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        "<h1>Signed in to Sideways</h1><p>You can close this tab.</p>",
      );
      server.close();
      resolve(code!);
    });

    server.listen(redirectPort);
  });

  // Exchange code for tokens
  const tokenRes = await fetch(`${hydraPublicUrl}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
    }),
  });

  if (!tokenRes.ok) {
    throw new Error(`Token exchange failed: ${await tokenRes.text()}`);
  }

  const tokens = await tokenRes.json();

  // Use the JWT to create an API key
  const keyRes = await fetch(`${apiUrl}/api/keys`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${tokens.access_token}`,
    },
    body: JSON.stringify({ name: `CLI (${new Date().toISOString()})` }),
  });

  if (!keyRes.ok) {
    throw new Error(`Failed to create API key: ${await keyRes.text()}`);
  }

  const { key } = await keyRes.json();

  storeCredentials({ api_key: key, api_url: apiUrl });
  console.log("API key created and stored in ~/.sideways/token.json");
}
