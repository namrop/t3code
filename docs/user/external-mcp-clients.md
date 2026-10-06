# Outside MCP clients

A client that T3 did not launch can authenticate to the server's `/mcp` endpoint
with a long-lived bearer credential. This is separate from the short-lived,
in-memory credentials attached to T3 provider sessions. It is not MCP OAuth.

## Issue, list, revoke

Run the CLI as the user that owns the T3 home. Use the **same base directory as
the running server**; `T3CODE_HOME` also selects that directory.

```bash
t3 mcp client issue --base-dir /path/to/t3-home --label OpenClaw --runtime-mode-ceiling auto
t3 mcp client list --base-dir /path/to/t3-home
t3 mcp client revoke <credential-id> --base-dir /path/to/t3-home
```

`issue` prints JSON containing `token` and public `credential` metadata. The token
is printed only during issuance and cannot be retrieved later. `--token-only`
prints only the token for capture by a credential-installation script. `list`
prints only public metadata; `revoke` reports `{ id, revoked }`.

The ceiling defaults to `auto`. Choices, from narrowest to broadest, are
`approval-required`, `auto-accept-edits`, `auto`, and `full-access`.

For a dev server, pass its `--dev-url` too, so issuance selects the same dev
userdata namespace. There is no token expiry, refresh operation, or update
command: issue a replacement and revoke the old credential to rotate it.

## Persistence and revocation

Each credential is one JSON entry under `userdata/mcp-clients/` (or the dev
userdata namespace), named by the SHA-256 hash of a random 256-bit token. It
stores the hash, credential ID, label, ceiling, and issue time, never the token.
Entries are published with an atomic rename and a mode-0600 temporary file.
Independent entries avoid a shared read/modify/write race between concurrent CLI
processes and the server; no database migration or server restart is needed.

The HTTP registry reads the entry on every authentication request. Revocation
therefore applies to the next request, including one carrying an existing MCP
session ID. It does not retroactively cancel a request already authenticated.
Credentials survive server restarts and are not subject to provider-session
liveness expiry. Backing up or restoring this directory also backs up or restores
credential validity.

## Authority and tool discovery

Client scopes have no calling thread. The credential ID is the client session
identity and isolates the request namespace. They receive `orchestration` and
`pull-requests`, not `worktree`, `preview`, or `device` capabilities. Worktree
handoff/status operations and provider delegation require a T3-owned calling
thread; browser/device operations are deliberately unavailable to outside
clients.

The existing thread/project handlers enforce the runtime-mode ceiling. Clients
must provide `projectId` when launching and `threadId` when targeting a thread.
Read `t3_project_list` to find project IDs, and `orchestrator_capabilities` to
find provider instance/model selections. A launch without a requested runtime
mode uses the client's ceiling; a broader mode is refused. Launching with no
message opens an idle thread; provide `message` to start an agent run. Project
creation/deletion and environment mutations still require `full-access`.

**Catalog limitation:** `tools/list` currently returns the whole T3 catalog,
including tools that require a calling thread or an ungranted capability. Those
calls are rejected by their handlers, rather than hidden during discovery. An
outside-client probe currently lists 72 tools; discovery is not an authorization
promise.

## OpenClaw 2026.9.3

Store the token as `T3_MCP_TOKEN` in the OpenClaw state directory's `.env` file,
not literally in `openclaw.json`. Add this server definition:

```json
{
  "mcp": {
    "servers": {
      "t3": {
        "enabled": true,
        "url": "http://127.0.0.1:5195/mcp",
        "transport": "streamable-http",
        "headers": { "Authorization": "Bearer ${T3_MCP_TOKEN}" },
        "connectionTimeoutMs": 30000,
        "requestTimeoutMs": 60000
      }
    }
  }
}
```

OpenClaw's MCP header schema accepts scalar values, not SecretRef objects. The
`${...}` config interpolation is supported and remains a reference on disk.
There is no separate `mcp.enabled` switch. A `full` tool profile with no narrowing
allow/deny policy needs no tool-policy change. Restrictive policies must permit
the `t3__*` namespace as appropriate; OpenClaw exposes the launch tool as
`t3__t3_thread_launch` and project discovery as `t3__t3_project_list`. This is a
Gateway-configured MCP server, not ACP's unsupported per-session MCP injection.

For the CLI add path, save first, then probe:

```bash
openclaw mcp add t3 --url http://127.0.0.1:5195/mcp --transport streamable-http \
  --header 'Authorization=Bearer ${T3_MCP_TOKEN}' --connect-timeout 30 --timeout 60 --no-probe
openclaw mcp probe t3 --json
openclaw mcp status --json
```

`--no-probe` matters in this release: `add` probes the newly supplied header
literally, before a normal config reload can interpolate it. The subsequent
`probe` reads the saved config, resolves the environment reference, and connects.
The equivalent `mcp set t3 '<server-object-json>'` preserves the reference too.

MCP configuration changes are classified as hot changes that dispose/rebuild
MCP runtimes under the default hybrid reload policy. Write the new `.env` entry
before the server configuration. Config reads reload dotenv for missing variables;
changing an already-loaded environment variable is a separate rotation concern.
Verify the applied Gateway config and a new agent turn after activation; the
isolated CLI probe does not prove that a running agent's retained tool surface
has changed.

For isolated testing, inspect the OpenClaw launcher first. A wrapper that
unconditionally exports `OPENCLAW_CONFIG_PATH` and `OPENCLAW_STATE_DIR` overrides
supplied isolation variables. Invoke its exact Node binary and `openclaw.mjs`
entrypoint directly, with both variables pointing to a private throwaway home.
Do not use the production launcher for an isolated write test if it hard-codes
production paths.
