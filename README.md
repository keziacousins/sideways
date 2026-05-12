# Sideways

> A documentation sharing platform for teams and AI agents.

Sideways turns a directory of markdown into a searchable, commentable documentation site. Edit on disk with your preferred editor and sync via CLI, or write through the web UI. Comments thread under anchored text. AI agents read and write through a built-in MCP server.

This repository is the v1 implementation: a Node/Astro/Hono stack backed by Postgres, SeaweedFS, and Ory Kratos/Hydra for auth. A v2 is being planned as a single-binary Rust rewrite.

## Features

- **Spaces, sections, and documents** — hierarchical organisation with public/private/shared/org visibility, role-based members (viewer/editor/admin), and share-link invites.
- **Versioned markdown** — every save creates a new version; content-hash deduped.
- **Threaded, anchored comments** — comments attach to specific passages of text and survive document edits via fuzzy anchor recovery.
- **CLI** — `sideways push`, `pull`, `status`; sync a directory tree of markdown files with a remote space.
- **MCP server** — Claude Code / Cursor / other LLM clients can list, read, write, comment, and search via the Model Context Protocol.
- **Search** — full-text search across spaces with title-prioritised ranking.
- **PDF export** — themed PDF rendering via WeasyPrint, including cover pages and printable CV themes.
- **Themes** — custom fonts, colours, and cover layouts per space, with per-document print theme overrides.
- **Auth** — Kratos for identity, Hydra for OAuth2/JWT, plus `sk-…` API keys for programmatic access.

## Quick start (local dev)

Requires Node 24+, pnpm 10+, and Docker.

```bash
# 1. Bring up infra (Postgres, Kratos, Hydra, SeaweedFS, WeasyPrint, Mailhog)
cd infra && cp .env.example .env && docker compose up -d && cd ..

# 2. Install JS deps and copy the app env
pnpm install
cp .env.example .env

# 3. Push the database schema
pnpm --filter @sideways/db exec drizzle-kit push

# 4. Start API (:4100) and web (:4000)
./scripts/start-server.sh
```

Then open <http://localhost:4000>.

To start just one half: `./scripts/start-server.sh --api-only` or `--web-only`.

## Tests

```bash
pnpm test          # unit + integration tests (vitest) — needs Postgres running
pnpm test:e2e      # playwright browser tests — needs API + web + Kratos + Hydra running
```

## Workspace layout

```
shared/        @sideways/types, @sideways/markdown, @sideways/db, @sideways/storage
packages/      @sideways/server (Hono API)
               @sideways/web    (Astro SSR frontend)
               @sideways/cli    (file-sync CLI)
               @sideways/mcp    (MCP server bundle)
infra/         docker-compose, nginx, Kratos/Hydra/WeasyPrint configs
scripts/       deployment, server start, admin reports
user-docs/     end-user documentation (rendered as a Sideways space)
e2e/           Playwright test specs
```

Shared packages export raw TypeScript — no build step. The API server runs via `tsx` in both dev and production.

## Deployment

The deploy scripts target a remote host over SSH. Set `DEPLOY_HOST=user@host`:

```bash
export DEPLOY_HOST=admin@your-server.example.com

./scripts/setup-vm.sh          # one-time: install Node/pnpm/nginx, register systemd services
./scripts/deploy.sh             # full deploy
./scripts/deploy.sh --quick     # sync + restart only (no build)
./scripts/deploy.sh --infra     # rebuild Docker infra only
```

The full stack runs on the host behind nginx. App code lives at `/opt/sideways`; env vars at `/opt/sideways/.env`.

See [`CLAUDE.md`](./CLAUDE.md) for additional development notes and the project's working conventions.

## License

[MIT](./LICENSE)
