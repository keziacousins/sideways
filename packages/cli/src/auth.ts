import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";

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

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Login by pasting an API key.
 * The user creates the key in the web UI, then pastes it here.
 */
export async function login(apiUrl: string): Promise<void> {
  const baseUrl = apiUrl.replace(/\/api$/, "").replace(/:\d+$/, "");
  console.log("\nTo authenticate, create an API key in the Sideways web UI:");
  console.log(`  ${baseUrl}/settings/keys\n`);

  const key = await prompt("Paste your API key (sk-...): ");

  if (!key.startsWith("sk-")) {
    console.error("Invalid API key. Keys start with 'sk-'.");
    process.exit(1);
  }

  // Verify the key works
  try {
    const res = await fetch(`${apiUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${key}` },
    });

    if (!res.ok) {
      console.error("API key is invalid or expired.");
      process.exit(1);
    }

    const user = await res.json();
    storeCredentials({ api_key: key, api_url: apiUrl });
    console.log(`\nAuthenticated as ${user.name} (${user.email})`);
  } catch {
    console.error("Could not connect to the API server.");
    process.exit(1);
  }
}
