# Sideways

Documentation sharing platform. See `README.md` for the project overview.

## Bootstrap (local dev)

```bash
pnpm install
./scripts/start-server.sh              # both API + web
./scripts/start-server.sh --api-only   # just API on :4100
./scripts/start-server.sh --web-only   # just web on :4000
```

Local dev expects the Docker infra (Postgres, SeaweedFS, Kratos, Hydra, WeasyPrint, Mermaid, Mailhog) to be running locally:

```bash
docker context show    # must be 'default' — see below
cd infra && cp .env.example .env && docker compose up -d
```

**Check the docker context first.** `docker compose up` talks to whichever daemon
the active context points at. If that is a remote daemon, the whole stack starts
*on that host* instead: the containers come up healthy, `docker ps` reports
`127.0.0.1:5432->5432/tcp`, and nothing is reachable locally, because those
published ports are on the remote host's loopback. `docker exec` keeps working
over the SSH transport, which makes it look less like a connection problem than
it is. Three distinct targets worth keeping apart:

| Target | How you reach it |
|---|---|
| Local workstation | `docker context use default` |
| The `sideways-dev` VM, where the dev stack actually runs | `DEPLOY_HOST=admin@sideways-dev ./scripts/deploy.sh --infra` |
| The `minimax` host's own daemon, which hosts that VM but runs no Sideways containers | `docker context use minimax` |

## Tests

```bash
pnpm test              # unit + integration tests (vitest)
pnpm test:watch        # vitest watch mode
pnpm test:e2e          # browser tests (playwright, needs servers running)
pnpm test:e2e:ui       # playwright with UI
```

Integration tests require a running Postgres (the infra `docker compose` brings one up). E2e tests require API (:4100), web (:4000), Kratos, and Hydra all running.

## Ports

- 4000: Astro web app (SSR)
- 4100: Hono API server
- 5432: Postgres (via Docker)
- 4433/4434: Kratos public/admin
- 4444/4445: Hydra public/admin
- 5001: WeasyPrint
- 5002: Mermaid diagram sidecar
- 8888: SeaweedFS filer
- 1025/8025: Mailhog SMTP/UI

## Workspace layout

- `shared/` — shared libraries (`@sideways/types`, `@sideways/markdown`, `@sideways/db`, `@sideways/storage`)
- `packages/` — apps (`@sideways/server`, `@sideways/web`, `@sideways/cli`, `@sideways/mcp`)
- `infra/` — Docker compose, nginx, Kratos/Hydra/WeasyPrint/Mermaid configs
- `scripts/` — deployment and dev scripts

Shared packages export raw `.ts` — no build step. The API server runs via `tsx` (both locally and in production).

## Infrastructure

Backing services run via Docker Compose (`infra/compose.yml`):

- Postgres (5432), SeaweedFS (8888/9333), Ory Kratos (4433/4434), Ory Hydra (4444/4445), WeasyPrint (5001), Mermaid (5002), Mailhog (1025/8025)

The same compose file is used locally and on the deploy host.

## Deployment

**Host requirement: more than 2GB of RAM, or swap.** `astro build` needs more
memory than a 2GB host has once Mermaid is in the bundle. Short of it, the build
is OOM-killed partway — and the failure is worse than it sounds, because the kill
lands between the server and client build steps, leaving `packages/web/dist` with
a `server/` directory and no `client/`. `deploy.sh` then restarts `sideways-web`
onto that half-built output and the service crash-loops with `ERR_INVALID_URL …
deserializeManifest`. So a build failure becomes a downed site rather than an
aborted deploy.

`sideways-dev` runs on 1.9GB and carries a 1G swapfile for this (`/swapfile`, in
`/etc/fstab`); peak usage during the build is around 580MB of swap. To recover a
host that has already done this, build locally and rsync `packages/web/dist/` —
but note `PUBLIC_URL` and `PUBLIC_API_URL` are baked in at build time via
`import.meta.env`, so an off-host build must set both to the target's values or
the bundle points at localhost.

The deploy scripts target a remote host over SSH. Set `DEPLOY_HOST` to your SSH destination:

```bash
export DEPLOY_HOST=user@your-server.example.com

# One-time host setup (installs Node, pnpm, tsx, nginx, systemd services)
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

Services are managed via systemd on the deploy host:
```bash
ssh "$DEPLOY_HOST" "sudo systemctl status sideways-api sideways-web"
ssh "$DEPLOY_HOST" "sudo journalctl -u sideways-api -n 50"
ssh "$DEPLOY_HOST" "sudo journalctl -u sideways-web -n 50"
```

App code lives at `/opt/sideways` on the host. Env vars in `/opt/sideways/.env`.

### Database backup

Take a `pg_dump` before any destructive schema change (column drops, table drops, constraint changes that could fail). Cheap insurance:

```bash
DEPLOY_HOST=admin@your-server.example.com ./scripts/backup-db.sh
```

Output: `backups/sideways-YYYYMMDD-HHMMSS.sql` (gitignored). Restore with `psql ... < backups/<file>.sql` against a target database.

## Releasing

Versioning is **manual** — not bumped on every commit. The number in `package.json` is a signal to CLI users, not a commit counter. Bump when you intend to publish a new CLI bundle or surface a noticeable change to users.

```bash
./scripts/bump-version.sh patch        # bugfix: 1.0.3 → 1.0.4
./scripts/bump-version.sh minor        # feature: 1.0.3 → 1.1.0
./scripts/bump-version.sh major        # breaking: 1.0.3 → 2.0.0
./scripts/bump-version.sh set 2.0.0-rc.1   # explicit override
```

The script updates the root and every workspace package.json. Releases go through a PR so that linked GitHub issues auto-close on merge:

```bash
# 1. On a feature/release branch, after ./scripts/bump-version.sh:
git add package.json packages/*/package.json
git commit -m "Release X.Y.Z — <short summary>"
git push -u origin <branch>

# 2. Open the PR. Body references every issue this release closes:
#    Closes #15
#    Closes #16
gh pr create --title "Release X.Y.Z — <summary>" --body "Closes #N..."

# 3. Merge the PR (web UI or gh pr merge). GitHub auto-closes referenced issues.

# 4. Tag the merge commit on main, then deploy:
git checkout main && git pull
git tag vX.Y.Z
git push origin vX.Y.Z
./scripts/deploy.sh
```

Conventions:
- **Commit messages reference issues** — inline like `(#15)` for partial mentions, or `Closes #15` / `Fixes #15` in the PR body for auto-close. The PR body is what triggers the close; commit references are for git history.
- **Tag after merge, not on the PR branch.** Squash-merge changes the commit SHA, so a pre-merge tag would dangle. Tag the main HEAD after pulling.
- **Deploy from main after tagging** for prod-like environments. For the dev VM (`admin@sideways-dev`) it's fine to deploy from the PR branch before merge — the deploy script rsyncs the working tree.
- **`setup-vm.sh` changes don't propagate via `deploy.sh`.** If a release modifies the systemd units in `setup-vm.sh`, you have to manually `daemon-reload` + restart the relevant service on each host (or re-run the unit-writing portion of setup-vm.sh).

Internal commits between releases should not touch `package.json` versions. If you find a per-commit auto-bump hook in `.git/hooks/pre-commit`, delete it — it predates the manual workflow.

## Notes

- Astro is v6 with `@astrojs/node@10`. The two are coupled — the v10 adapter
  requires Astro v6 — so neither moves without the other. Astro v7 pairs with
  adapter v11; that upgrade is unstarted, and `sharp` is pinned through a root
  override until it happens (see the overrides block in the root `package.json`).
- Markdown rendering is in `shared/markdown` and shared between web (at build/request time) and API (`/render` endpoint). Changes there affect both.
