# Setup

## Installing the CLI

Run this in your terminal to install the Sideways CLI:

```bash
curl -fsSL https://your-sideways-instance/install.sh | sh
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
root: .
name: My Project
```

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

The directory structure maps to sections and document nesting:

```
my-docs/
  readme.md                 → top-level document
  getting-started/          → section: "getting-started"
    index.md                → section landing page
    installation.md         → child of getting-started
    installation/
      linux.md              → child of installation
      macos.md              → child of installation
  api/                      → section: "api"
    overview.md             → document in api section
```

First-level directories become **sections**. Deeper nesting creates **parent/child document relationships**. An `index.md` in a directory becomes the parent page.

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
SIDEWAYS_ACTOR="Claude" sideways push
```

Or per-command:

```bash
sideways comment api-design.md "Looks good" --as "Claude"
```

Comments and notifications will show "Claude via Your Name".
