# Sideways

Documentation sharing platform. See PRD.md for full product requirements.

## Bootstrap (local dev)

```bash
pnpm install
./scripts/start-server.sh          # both API + web
./scripts/start-server.sh --api-only   # just API on :4100
./scripts/start-server.sh --web-only   # just web on :4000
```

## Tests

```bash
pnpm test              # unit + integration tests (vitest)
pnpm test:watch        # vitest watch mode
pnpm test:e2e          # browser tests (playwright, needs servers running)
pnpm test:e2e:ui       # playwright with UI
```

Integration tests require Postgres on localhost. E2e tests require API (:4100), web (:4000), Kratos, and Hydra all running.

## Ports

- 4000: Astro web app (SSR)
- 4100: Hono API server
- Avoid 3000-3002 — other projects use these on this machine.

## Workspace layout

- `shared/` — shared libraries (`@sideways/types`, `@sideways/markdown`, `@sideways/db`, `@sideways/storage`)
- `packages/` — apps (`@sideways/server`, `@sideways/web`, `@sideways/cli`, `@sideways/mcp`)
- `infra/` — Docker compose, nginx, Kratos/Hydra/WeasyPrint configs
- `scripts/` — deployment and dev scripts

Shared packages export raw `.ts` — no build step. The API server runs via `tsx` (both locally and on the VM).

## Infrastructure

Backing services run in a Tart VM called `localhost` on `host-machine`, reachable via Tailscale MagicDNS.

Docker services (`infra/compose.yml`):
- Postgres (5432), SeaweedFS (8888/9333), Ory Kratos (4433/4434), Ory Hydra (4444/4445), WeasyPrint (5001), Mailhog (1025/8025)

## Deployment

The full stack runs on `localhost` behind nginx on port 80.

```bash
# One-time VM setup (installs Node, pnpm, tsx, nginx, systemd services)
./scripts/setup-vm.sh

# Full deploy (sync code, install deps, build web, restart services)
./scripts/deploy.sh

# Quick deploy (sync + restart, no build — for API/backend-only changes)
./scripts/deploy.sh --quick

# Infra only (sync and rebuild Docker containers)
./scripts/deploy.sh --infra
```

- **`--quick`** skips `pnpm install` and `astro build`. Use for API server or CSS-only changes (the API runs via `tsx` from source). Does NOT work for web frontend changes — those need a full deploy.
- **`--infra`** only syncs `infra/` and runs `docker compose up -d --build`.

Services are managed via systemd:
```bash
ssh $DEPLOY_HOST "sudo systemctl status sideways-api sideways-web"
ssh $DEPLOY_HOST "sudo journalctl -u sideways-api -n 50"   # API logs
ssh $DEPLOY_HOST "sudo journalctl -u sideways-web -n 50"   # Web logs
```

App code lives at `/opt/sideways` on the VM. Env vars in `/opt/sideways/.env`.

## Notes

- Astro is v5 with `@astrojs/node@9` — the v10 adapter requires Astro v6.
- Markdown rendering is in `shared/markdown` and shared between web (at build/request time) and API (`/render` endpoint). Changes there affect both.
