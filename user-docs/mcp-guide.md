# MCP & AI Agents

Sideways includes a built-in MCP (Model Context Protocol) server that lets AI agents like Claude read, write, search, and comment on documentation.

The server is at `https://your-sideways-instance/api/mcp` and uses the Streamable HTTP transport. It accepts two kinds of credential:

- **OAuth sign-in**, for Claude connectors. You sign in with your Sideways account and approve a consent screen. No API key is involved.
- **An API key**, for Claude Code and any other client that can send an `Authorization` header.

## Setting Up Claude (claude.ai, Desktop and Mobile)

Add Sideways as a custom connector:

1. In Claude, open **Settings → Connectors** and choose **Add custom connector**.
2. Name it `Sideways` and paste `https://your-sideways-instance/api/mcp` as the URL. Leave the advanced OAuth settings empty.
3. Choose **Connect**. Claude sends you to Sideways to sign in, then to a consent screen. Approve it.

A connector added on claude.ai is also available in Claude Desktop and the Claude mobile apps. Claude reaches the server from Anthropic's cloud, so the instance must be reachable from the public internet.

The consent screen labels Claude as an **unverified third-party connector**. That is expected: Claude registers itself with Sideways automatically, and Sideways flags every client that registers this way. Tokens issued to a connector work only against the MCP endpoint, not the rest of the API.

To disconnect, remove the connector in Claude's settings.

Don't add Sideways to `claude_desktop_config.json`. That file runs local servers only. Remote servers go through **Connectors**.

## Setting Up Claude Code

If you've added the Sideways connector on claude.ai and Claude Code is signed in with the same claude.ai account, there's nothing to set up. Claude Code picks up your claude.ai connectors automatically, and Sideways appears in `/mcp` as **claude.ai Sideways**.

Use an API key instead when:

- Claude Code is signed in with an Anthropic API key, or runs through Bedrock or Vertex. claude.ai connectors aren't available there.
- The Sideways instance isn't reachable from the public internet, such as a local or private-network server. Connectors are called from Anthropic's cloud. An API key connection goes straight from your machine.
- You want changes attributed to a named agent such as "Claude" rather than "Connector" (see [Agent Identity](#agent-identity)).

Create a key in the web UI under **Settings → API Keys**, and give it an agent name. Then run in your project:

```bash
claude mcp add --transport http sideways https://your-sideways-instance/api/mcp \
  --header "Authorization: Bearer sk-your-api-key"
```

Claude Code's own OAuth sign-in doesn't work with Sideways. It asks to be redirected to a `http://localhost` address after sign-in, and Sideways only accepts HTTPS redirect addresses on public hosts.

The API key must be passed in the `Authorization` header. Sideways does not accept keys in a `?key=` query parameter, because they would leak through browser history, server logs and the `Referer` header.

The same setup works for any other MCP client that can send an `Authorization` header.

Earlier versions shipped a separate stdio server, `sideways-mcp.cjs`. It has been removed; a `.mcp.json` entry that still runs it should be replaced with the command above.

## Available Tools

Tools are namespaced by entity: `space_*`, `doc_*`, `comment_*`, `diagram_*`, plus `search`.

### Document refs

Every doc has a single-string canonical ref: `<space>:<section>/<path>.md` — e.g. `engineering:architecture/api-design.md`. `search` and `doc_list` emit refs you can copy verbatim into `doc_read`, `doc_edit`, `comment_add`, etc.

### Spaces
| Tool | Description |
|------|-------------|
| `space_list` | List all accessible spaces |
| `space_create` | Create a new space |

### Documents

| Tool | Description |
|------|-------------|
| `doc_list` | List documents in a space |
| `doc_read` | Read a document's markdown (optionally with comments) |
| `doc_write` | Create or update a document (upsert) |
| `doc_edit` | Search-and-replace edits without rewriting |
| `doc_rename` | Rename a document's title (path-changing renames go through `doc_move`) |
| `doc_move` | Move to another space, section, or path |
| `doc_duplicate` | Create a copy |
| `doc_delete` | Delete a document |
| `doc_versions` | List version history |

### Comments
| Tool | Description |
|------|-------------|
| `comment_add` | Add a comment (with optional anchor text) |
| `comment_list` | List comments (threaded display) |
| `comment_resolve` | Toggle resolve/reopen |

### Search
| Tool | Description |
|------|-------------|
| `search` | Full-text search across documents |

### Diagrams
| Tool | Description |
|------|-------------|
| `diagram_preview` | Render a Typst diagram as it would appear in a given document, and return it as an image with the compiler's warnings or errors |
| `diagram_guide` | Read the Typst diagram authoring guide, the same page as Typst diagrams in this space |

## The doc_edit Tool

`doc_edit` is particularly useful for AI agents — it applies search-and-replace edits without needing to rewrite the entire document:

```
doc_edit(ref="engineering:architecture/api-design.md", edits=[
  { old: "Status: Draft", new: "Status: Approved" },
  { old: "## Next Steps\n\n1. Review", new: "## Next Steps\n\n1. ~~Review~~ Done" }
])
```

Edits are applied sequentially. If any `old` string isn't found, the operation fails with no changes saved.

## Agent Identity

Edits and comments made by an agent carry an **actor name** alongside your own name. Because of it:

- Comments show as "Claude via Your Name"
- You receive notifications when the agent replies to your comments
- You receive notifications when the agent updates watched documents

Where the actor name comes from depends on how the agent connects:

- **Claude connectors** are always named "Connector", so their comments show as "Connector via Your Name". Sideways sets this at the consent screen and ignores the name the connector registers with, so a connector cannot pass itself off as a different agent.
- **API keys** use the actor name you give the key when creating it. Set it to "Claude" or your agent's name. A key with no actor name acts as you, and its changes are not marked as an agent's.

For CLI usage, set the environment variable:

```bash
SIDEWAYS_ACTOR="Claude" sideways push
```

## Server Instructions

The MCP server provides context instructions to the AI agent explaining the Sideways data model, common workflows, and how to use wiki-links and document hierarchy. Agents can immediately start working with documentation without additional prompting.
