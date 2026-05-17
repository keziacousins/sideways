# Setup

## Installing the CLI

Run this in your terminal to install the Sideways CLI (pass your instance URL as the script argument):

```bash
curl -fsSL https://your-sideways-instance/install.sh | sh -s -- https://your-sideways-instance
```

Or download manually from the Setup page on your Sideways instance.

The CLI requires Node.js 18+.

## Authenticating

Create an API key in the web UI (click your avatar → API Keys), then:

```bash
sideways login
```

Paste your API key when prompted. Your credentials are stored at `~/.sideways/token.json`.

## Initialising a Project

Navigate to a directory containing your markdown files:

```bash
cd ~/my-docs
sideways init "My Project"
```

This creates a `.sideways.yml` config file:

```yaml
space: my-project
api: https://your-sideways-instance
sections:
  default: .
name: My Project
```

`sections:` is a map of **section slug → local directory**. The `default` section maps to `.` (the project root) so any markdown directly in the root, or in subdirectories, syncs to the `default` section by default. Add more entries to map other directories to other sections (see [Section Mappings](#section-mappings) below).

## Adding Files to Track

Before pushing, tell Sideways which files to sync:

```bash
sideways add .                      # track everything in the directory
sideways add docs/                  # track a specific directory
sideways add api-design.md          # track a single file
```

## Pushing Documents

Push tracked files to your Sideways space:

```bash
sideways push
```

Files map to documents based on the `sections:` map in `.sideways.yml`. With the default `sections: { default: . }` config, a project tree like this:

```
my-docs/
  index.md                  → section default, path index.md
                              (the section's home page)
  readme.md                 → section default, path readme.md
  getting-started/
    index.md                → section default, path getting-started/index.md
                              (parent for siblings in this dir)
    quickstart.md           → section default, path getting-started/quickstart.md
  api/
    endpoints.md            → section default, path api/endpoints.md
    auth/
      oauth.md              → section default, path api/auth/oauth.md
      keys.md               → section default, path api/auth/keys.md
```

…syncs every doc into the `default` section, with paths mirroring the on-disk layout.

To split content across sections, add more entries to `sections:`. See [Section Mappings](#section-mappings) below.

**`index.md`** in any directory is that directory's page — other files in the directory become its children. The doc's URL collapses `index.md` to the directory name (so `api/index.md` is reachable at `/s/<space>/<section>/api`). If there's no `index.md`, files appear flat with no parent.

**Deeper directories nest further.** `api/auth/index.md` is a child of `api/index.md`, and `api/auth/oauth.md` is a child of `api/auth/index.md`.

## Pulling Documents

Download all documents from a space to your local directory:

```bash
sideways pull
```

The directory structure is recreated from the server's section and document hierarchy.

## Checking Status

See what's changed:

```bash
sideways status
```

Shows new-local, local-modified, remote-modified, and conflict states.

## Bidirectional Sync

Pull remote changes and push local changes in one step:

```bash
sideways sync
```

Conflicts are skipped with instructions to resolve:

```
sideways push --force <file>    # keep local version
sideways pull --force <file>    # keep remote version
```

## Section Mappings

Map multiple on-disk directories to multiple sections — useful when your docs live alongside code:

```yaml
sections:
  default: docs
  api: src/packages/api/docs
  web: src/packages/web/docs
```

Each entry is `<section-slug>: <local-path>`. With this config:
- `docs/getting-started.md` → section `default`, path `getting-started.md`, URL `/s/<space>/default/getting-started`
- `src/packages/api/docs/architecture/overview.md` → section `api`, path `architecture/overview.md`, URL `/s/<space>/api/architecture/overview`
- `src/packages/web/docs/index.md` → section `web`, path `index.md`, URL `/s/<space>/web` (index.md collapses to the section URL)

Only directories listed under `sections:` are synced. Anything outside a mount is ignored.

When pulling, files are written back into their mapped local paths.

## Ignoring Files

By default, common directories are ignored: `node_modules`, `venv`, `.git`, `dist`, `build`, etc.

Add custom ignores in `.sideways.yml`:

```yaml
ignore:
  - reference-code
  - tmp
```

## Agent Identity

When an AI agent (like Claude) uses the CLI, identify it with `--as`:

```bash
sideways comment docs/api-design.md "Looks good" --as "Claude"
```

Or set `SIDEWAYS_ACTOR` once for a whole session:

```bash
export SIDEWAYS_ACTOR="Claude"
sideways push
```

Comments and notifications will show "Claude via Your Name".
