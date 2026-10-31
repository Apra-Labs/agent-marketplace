---
name: rport
description: "Best practices and guardrails for working with RPort servers (rportd / openrport): tunnels, stored tunnels, clients, users and remote access through the RPort API, run safely via apra-fleet so the agent never sees the API token. Use when the user mentions RPort, rportd or openrport, an RPort tunnel, stored tunnel or client, remote access to a device through RPort, asks to revive a tunnel, says a tunnel expired or closed, or says a tunnel port changed and a fleet member or SSH connection must follow it."
---

# RPort skill (core)

This skill works with any agent that can call apra-fleet tools. It is chapter-based: this file
holds the concepts, the guardrails for every RPort action, and how to call the API. Each area of
work is a chapter in `chapters/`. Read the chapter before acting in its area.

## Chapter index

| Chapter | Status | Covers |
|---|---|---|
| [tunnels](chapters/tunnels.md) | **available** | stored tunnels as definitions, revive, status, expiry bookkeeping, close, fleet-member links |
| clients | planned, not yet written | adding and registering clients, client auth |
| users | planned, not yet written | users, groups, API tokens |

**Rule for planned chapters:** for a planned chapter, do not improvise admin actions; explain what's
missing and ask the operator. That covers creating or deleting clients, client auth credentials,
users, groups and API tokens, and any server configuration (`rportd.conf`). Read-only listing the
CLI already offers (`clients`, `whoami`) is fine.

## Concepts

- **rportd** is the server; **rport** is the client agent on a remote machine, keeping an outbound
  connection to the server. A client has an id and a name.
- The **API** lives at `https://<server>/api/v1`. Authentication is HTTP basic: the RPort username
  plus an **API token as the password**. Tokens have a scope (`read`, `read+write` or
  `clients-auth`) and an `expires_at`.
- The operator may use **several RPort servers**, like an ssh client with several hosts. Each has a
  **moniker** in the local config. Everything server-side (clients, stored tunnels) and everything
  the skill records (links, ledger) is scoped by moniker, so two servers may have clients and stored
  tunnels with the same names.

## How to call the API: always through apra-fleet

**Requires apra-fleet 0.4.4 or later.** Before the first RPort action in a session, call
`mcp__apra-fleet__version` (it returns e.g. `apra-fleet v0.4.4_<build>`). If the tool is missing or
the version is below 0.4.4, stop: tell the operator to install or upgrade apra-fleet to 0.4.4+
(https://github.com/Apra-Labs/apra-fleet/blob/main/docs/install.md) and do not try a workaround.

The operator gives this skill **one secret per server: their RPort API token**, kept in the
apra-fleet credential store. URL, username and moniker are not secret; they live in the config.

Secret values are substituted only inside `mcp__apra-fleet__execute_command` via `{{secret.NAME}}`,
so the agent never sees or handles the token. Therefore:

1. **Never** call the RPort API with curl, a web-fetch tool or anything else from the agent session.
2. Always run `scripts/rport.mjs` (Node >= 18, no dependencies) through
   `mcp__apra-fleet__execute_command` on the **runner member**, passing the token as an environment
   variable in that one command only.
3. The script reads `RPORT_TOKEN`, never prints it, never puts it in a URL, log, error or the ledger,
   and redacts `Authorization` in `--debug` output.
4. apra-fleet substitutes `{{secret.NAME}}` **already quoted** for the runner's shell. Write it
   bare, as in the templates below - never inside your own quotes, or the token arrives corrupted
   and the server answers 401.

Command templates (`<NAME>` = the server's `token_secret`, default `RPORT_API_TOKEN`; `<skill>` = this
skill's folder, `${CLAUDE_SKILL_DIR}`, here and in `chapters/`; forward slashes work in PowerShell
too). The runner must be a local member, so it sees this folder. Check the runner's shell with
`member_detail`.

The script is plain Node (≥18) with no OS-specific calls, so any runner works: Windows, macOS or
Linux. Only the way the environment variable is set differs by shell.

Git Bash on Windows, or bash/zsh/sh on macOS and Linux:
```
RPORT_TOKEN={{secret.<NAME>}} node "<skill>/scripts/rport.mjs" <command> [args]
```
PowerShell:
```
$env:RPORT_TOKEN={{secret.<NAME>}}; node "<skill>\scripts\rport.mjs" <command> [args]
```
Commands that touch only local config (`server`, `runner`, `link list`, `ledger`) need no token; run
them without the `RPORT_TOKEN` part. If the runner member is on another machine than the skill, copy
`scripts/rport.mjs` there once with `send_files` and use that path.

`node rport.mjs --help` lists all commands. Exit codes: `0` ok, `1` usage, `2` guardrail refusal,
`3` API error, `4` config error. On `2`, do not look for a way around the refusal; tell the operator
what was refused and why.

### Servers

```
node "<skill>/scripts/rport.mjs" server add --url https://rport.example.com --user alice
```
With no moniker this creates `default` with secret name `RPORT_API_TOKEN`. When only one server
exists, or one is called `default`, `--server` is optional everywhere. More servers:
`server add lab --url https://203.0.113.10 --user alice --token-secret RPORT_LAB_TOKEN`, then pass
`--server lab`. With several servers and none called `default`, commands refuse with
"pick one: …". `server list | show [<moniker>] | remove <moniker>`. Plain `http://` is refused
except to localhost, since basic auth would send the token in clear text.

### Runner member

Any **local** apra-fleet member works, LLM or not. It must be local to **the machine that will use
the RPort resource** (e.g. the machine that will SSH through a tunnel): the server sees that
machine's public IP, so `GET /me/ip` returns the right source IP for ACLs. A future apra-fleet
version may provide a default local member; until then, register one with `register_member`
`member_type=local`. Set it once: `runner set <member>`; override per server with
`server add <moniker> … --runner-member <member>`. `runner show` prints the effective runner.

### Secret hygiene (tell the operator, and check)

- **Never paste the token in chat.** If the operator has to give it, call
  `mcp__apra-fleet__credential_store_set` with a prompt; the value is collected out of band.
  Use `persist: true` only if the operator wants it to survive restarts.
- **Scope it to the runner member only**: `members: "<runner member>"`, not `"*"`.
- **Network policy:** the runner makes HTTPS calls with the token, so the secret needs
  `network_policy` `allow` or `confirm`; with `deny`, apra-fleet blocks the command (the script then
  reports an unsubstituted placeholder or a blocked command). Change it with
  `mcp__apra-fleet__credential_store_update` (`name`, `network_policy`) and say why: the secret
  exists only to be sent to the RPort server. `confirm` is the safer default when the operator is present.
- **Least scope:** prefer a `read+write` token for tunnel work and a `read` token if only status is
  needed. Ask the operator to note the token's `expires_at`; a 401 usually means it expired.
- The token is a secret; tunnel ports, client ids and server hostnames are not.

## Local state

`~/.config/rport-skill/` (override: `RPORT_SKILL_HOME`), created owner-only where the OS allows:

- `config.json`: `runner_member`, `servers { <moniker>: { url, user, token_secret, runner_member? } }`
  and chapter data such as links. Template: `templates/config.example.json`.
- `ledger.jsonl`: append-only record of what the skill did, for bookkeeping.

## Guardrails for every RPort action

1. Do only what the operator asked, on their own servers and clients. No admin actions "while we're here".
2. **Admin changes on the server** (anything that creates, edits or deletes server-side objects,
   e.g. stored tunnels) happen only on the operator's explicit request. Run them with `--dry-run`
   first, show the planned call, then run them for real.
3. Read before you write: list or check status first.
4. One write per request. No loops, no blind retries; if a write fails, read the error, explain, ask.
5. Never weaken a safety default of RPort or of this skill to make something work, and never
   "fix" an unsafe server object yourself; report it and ask.
6. Never print, echo, log or store the token. Never put it on a command line except as the
   `{{secret.NAME}}` placeholder in the env assignment above.
7. If a chapter is planned but not written, stop and ask (see the rule above).

## Adding a chapter

Chapters are plain Markdown files in `chapters/`. Write `chapters/<name>.md`, add any CLI
subcommands to `scripts/rport.mjs` with tests, flip its row in the index above to **available**, and
keep this core file free of chapter-specific detail. See the repo README.
