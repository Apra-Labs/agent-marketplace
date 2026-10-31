# rport

An agent skill for working safely with [RPort](https://github.com/openrport/openrport) servers
(rportd / openrport). It gives an LLM agent best practices and hard guardrails for RPort work, and a
small Node CLI that does the API calls. It works with any agent host that loads `SKILL.md` folders
and any LLM provider that can call apra-fleet tools.

The skill is chapter-based. **tunnels** is available: stored tunnels as definitions, revive with
reuse, expiry bookkeeping, and repointing an apra-fleet member when a tunnel's port changes.
**clients** and **users** are planned.

The agent never sees your RPort API token. It stays in the apra-fleet credential store and reaches
`skills/rport/scripts/rport.mjs` only as an environment variable inside
`mcp__apra-fleet__execute_command` (`{{secret.NAME}}`).

## Prerequisites

- An RPort server you administer, and an **RPort API token** for your user (`read+write` for tunnel
  work, `read` for status only). Note its expiry.
- **apra-fleet 0.4.4 or later** ([install](https://github.com/Apra-Labs/apra-fleet/blob/main/docs/install.md)) with at least one **local** member (any member type, LLM or not) on the machine
  that will use the tunnels. If you have none: `register_member member_type=local`.
- **Node.js >= 18** on that machine (the CLI uses global `fetch`; no npm dependencies).
- An agent host that loads skills from a folder containing `SKILL.md`.

## Install

Claude Code:
```
/plugin marketplace add Apra-Labs/agent-marketplace
/plugin install rport@apra
```
Other agent hosts: copy `skills/rport/` into that host's skills folder. In the commands below,
`<skill>` is that folder (Claude Code substitutes it for you).

## Quick start (one server, zero flags)

Run these through your agent; it uses apra-fleet for anything that needs the token.

1. Store the token out of band, scoped to your local member:
   `credential_store_set name=RPORT_API_TOKEN members=my-runner network_policy=confirm`.
2. Configure the server and runner (local, no token needed):
   ```
   node <skill>/scripts/rport.mjs server add --url https://rport.example.com --user alice
   node <skill>/scripts/rport.mjs runner set my-runner
   ```
   No moniker means `default`; with one server, `--server` is never needed.
3. Check access: `RPORT_TOKEN={{secret.RPORT_API_TOKEN}} node <skill>/scripts/rport.mjs whoami`.
4. Ask the agent to "create an SSH tunnel definition for my-server" (an admin change it does only
   on your request, after a dry run), then to "revive my-ssh" whenever you need it.

More servers work like hosts in an ssh client: `server add lab --url https://203.0.113.10 --user
alice --token-secret RPORT_LAB_TOKEN`, then `--server lab`.

## Safety model

- **Token isolation:** the agent never sees the token; the script never prints or logs it.
- **Short-lived tunnels:** auto-close default 2h, max 12h; idle timeout default 30 min, max 120;
  never `skip-idle-timeout`; `check_port` always on.
- **Narrow ACLs:** never empty, `0.0.0.0/0`, IPv6 or wider than `/30`; at most 4 entries. `self` is
  your public IP as seen by the server, stored as a `/32`.
- **Stored tunnels are definitions:** creating, editing or deleting them is an admin change done
  only on the operator's explicit request, dry run first. Revive never rewrites a stored ACL; if
  your IP changed, it refuses and says how to fix it.
- **No misuse:** LAN targets beyond the client need an explicit flag; no port scanning, no create
  loops, no force-closing active tunnels unless asked.
- Exit codes: `0` ok, `1` usage, `2` guardrail refusal, `3` API error, `4` config error.

Details: `skills/rport/SKILL.md` and `skills/rport/chapters/tunnels.md`.

## Layout

```
.claude-plugin/plugin.json  plugin manifest
skills/rport/               what Claude Code loads (and what other hosts copy)
  SKILL.md                  frontmatter + core: concepts, guardrails, apra-fleet calling, servers, chapter index
  chapters/tunnels.md       tunnels chapter
  scripts/rport.mjs         Node >= 18 CLI, no npm dependencies
  templates/config.example.json
tests/rport.test.mjs        node:test against local fake RPort servers (127.0.0.1); not loaded by Claude Code
```

## Test

From the repository root:
```
npm test
```
The tests start two fake RPort servers on 127.0.0.1 and run the CLI against them with a sentinel
token. They never contact a real server.

## Adding a chapter

1. Write `skills/rport/chapters/<name>.md`: concepts, safety model, setup, each workflow with the exact
   `execute_command` invocation for Git Bash and PowerShell runners, troubleshooting, what not to do.
   Use neutral placeholders (`rport.example.com`, `alice`, `my-server`, `my-member`).
2. If it needs API calls, add subcommands to `skills/rport/scripts/rport.mjs` (reuse `api()`, `connFor()`,
   the redaction and exit codes; give every write `--dry-run`; scope anything stored by server
   moniker) and tests in `tests/rport.test.mjs`, extending the fake server.
3. In `skills/rport/SKILL.md`, change the chapter's row from "planned, not yet written" to **available**,
   and extend the frontmatter description if it needs new trigger words. Keep chapter-specific
   detail out of the core.
4. `npm test`, bump `version` in `.claude-plugin/plugin.json` and the marketplace entry, add a CHANGELOG line.

## License

Licensed under the [Apache License, Version 2.0](LICENSE), the same as apra-fleet.
