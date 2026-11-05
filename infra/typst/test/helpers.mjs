/**
 * Start a real sidecar (server.mjs) on a free port for a test file, and wait
 * until its workers are ready. Each test file gets its own.
 */

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export async function startServer(env = {}) {
  const server = spawn(process.execPath, [join(here, "..", "server.mjs")], {
    env: { ...process.env, PORT: "0", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const base = await new Promise((resolve, reject) => {
    server.stdout.on("data", (chunk) => {
      const match = String(chunk).match(/listening on (\d+)/);
      if (match) resolve(`http://127.0.0.1:${match[1]}`);
    });
    server.on("exit", (code) => reject(new Error(`server exited ${code}`)));
  });
  // Wait for a worker, not just the HTTP listener.
  for (let i = 0; i < 100; i++) {
    const res = await fetch(`${base}/health`).catch(() => undefined);
    if (res?.ok) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  async function render(body) {
    const res = await fetch(`${base}/render`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }

  return { base, render, stop: () => server.kill("SIGTERM") };
}
