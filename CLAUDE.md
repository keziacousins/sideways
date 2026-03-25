# Sideways

Documentation sharing platform. See PRD.md for full product requirements.

## Bootstrap

```bash
pnpm install
pnpm --filter @sideways/server dev   # API on :4100
pnpm --filter @sideways/web dev      # Web on :4000
```

## Ports

- 4000: Astro web app (SSR)
- 4100: Hono API server
- Avoid 3000-3002 — other projects use these on this machine.

## Workspace layout

- `shared/` — shared libraries (`@sideways/types`, `@sideways/markdown`)
- `packages/` — apps (`@sideways/server`, `@sideways/web`, plus stubs for `cli`, `mcp`, `pdf`)

## Infrastructure

Backing services (Postgres, SeaweedFS, Ory Hydra) run in a Tart VM called `localhost` on `host-machine`, reachable via Tailscale MagicDNS. See `infra-plan.md` for the general VM pattern.

- VM config: `infra/compose.yml`, `infra/init-db.sql`
- General VM tooling lives on host-machine at `~/vm-infra/`

```bash
# Deploy/update services
scp infra/compose.yml infra/init-db.sql $DEPLOY_HOST:~/
ssh $DEPLOY_HOST "docker compose up -d"
```

Services are at `localhost:<port>` — use this hostname in `.env`.

## Notes

- Astro is v5 with `@astrojs/node@9` — the v10 adapter requires Astro v6.
- Markdown rendering is in `shared/markdown` and shared between web (at build/request time) and API (`/render` endpoint). Changes there affect both.
