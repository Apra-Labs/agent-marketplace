# Chapter: tunnels

Read `SKILL.md` first: it covers how every command runs (through `mcp__apra-fleet__execute_command`
on the runner member, token only as `{{secret.NAME}}`), servers and monikers, and the general guardrails.

In this chapter `RUN <args>` is shorthand for the runner-shell command:

- Git Bash / POSIX: `RPORT_TOKEN={{secret.RPORT_API_TOKEN}} node "<skill>/scripts/rport.mjs" <args>`
- PowerShell: `$env:RPORT_TOKEN={{secret.RPORT_API_TOKEN}}; node "<skill>\scripts\rport.mjs" <args>`

Use the server's `token_secret` instead of `RPORT_API_TOKEN`, and add `--server <moniker>` when more
than one server is configured and the one you want is not `default`.

## 1. Concepts

| Thing | Where it lives | What it is |
|---|---|---|
| **Definition = stored tunnel** | on the RPort server: `GET /clients/{client_id}/stored-tunnels` | the named recipe for a tunnel |
| **Live tunnel** | on the RPort server: `GET /tunnels` | one running instance of a definition |
| **Ledger** | local `ledger.jsonl` | bookkeeping: which live tunnel came from which definition, and when it expires |
| **Link** | local `config.json` | optional: definition -> apra-fleet member to repoint after a revive |

- A **stored tunnel** is RPort's own saved definition, per client, identified here by
  (server moniker, client, name). Fields: `id, created_at, name, scheme, remote_ip, remote_port,
  public_port, acl, further_options`. `further_options` is free JSON the server stores but does not
  interpret; this skill keeps the live-tunnel options there, under the create endpoint's parameter
  names: `{"idle-timeout-minutes": 60, "auto-close": "8h", "protocol": "tcp"}`. Stored tunnels made
  in the RPort UI with `idle_timeout_minutes` / `auto_close` are read too; missing options fall back
  to the defaults (30 min / 2h).
- A **live tunnel** opens `lport` on the server and forwards to `remote_ip:remote_port` on the
  client. RPort returns `id, client_id, lhost, lport, rhost, rport, lport_random, scheme, protocol,
  acl, http_proxy, host_header, tunnel_url` (some servers also `idle_timeout_minutes`) and **no
  created or expiry time**, which is why the skill keeps a ledger.
- A stored tunnel's ACL is fixed. `self` is resolved via `GET /me/ip` when the stored tunnel is
  created or its ACL is set, and stored as that `/32`. If the operator's public IP changes, the ACL
  must be updated (an admin change) before the next revive.
- **`CURRENT-IP-ADDRESS`** is the RPort web UI's placeholder in a stored tunnel's ACL ("whoever
  starts it"). The skill treats it as safe and binds it at revive time to the caller's `GET /me/ip`
  as a `/32`, so the live tunnel is still limited to one address. It never sends or stores the
  placeholder itself, and it follows IP changes without an ACL update. An IPv6 caller is refused.
  The binding is done inside `rport.mjs`, so it behaves the same on Windows, macOS and Linux runners.

## 2. Safety model (enforced by the script, explain it when refusing)

1. **Tunnels are short-lived.** Every live tunnel gets `auto-close` (default `2h`, hard max `12h`)
   and an idle timeout (default 30 min, max 120). `skip-idle-timeout` is never sent; a stored tunnel
   that asks for it, or for values over the caps, is refused. A long idle timeout (up to 120) is
   for SSH used intermittently by agents, e.g. a fleet member that sits idle between commands.
2. **Narrow ACL, always.** An empty ACL means open to the whole internet, so it is refused, as are
   `0.0.0.0/0` and any CIDR wider than `/30`. At most 4 entries, each a single IPv4 or a
   `/30`..`/32`, strictly validated. RPort tunnel ACLs are IPv4-only, so IPv6 is refused.
3. **Stored ACLs are never rewritten by revive.** Revive creates the live tunnel with exactly the
   stored ACL. If your current IP (`GET /me/ip`) is not covered, revive refuses: "your IP changed
   from … to …; run `def set-acl <name> self` (operator approval) and revive again". A stored tunnel
   with an unsafe ACL or options (e.g. made in the UI) is refused until the operator fixes it; the
   agent never fixes it on its own.
4. **Admin changes need the operator's explicit request.** `def add`, `def set-acl`, `def remove`
   change the RPort server. Do them only when asked, with `--dry-run` first.
5. **Misuse rules.**
   - Only create tunnels the operator asked for, to their own clients.
   - `remote_ip` other than the client itself (`127.0.0.1` / `localhost`) reaches the client's LAN:
     needs an explicit operator yes **and** `--allow-lan-target`, at `def add` and at every `revive`.
   - `http_proxy` only with `auth_user` + `auth_password` (stored `auth_user`; the password from a
     second fleet secret passed as `RPORT_PROXY_PASSWORD`) and scheme `http`/`https`.
   - `check_port` always on.
   - `public_port`: if the stored tunnel sets it, revive passes it as `local`; otherwise the server
     picks a random port. There is no CLI `--local` override.
   - One create per request. `revive` takes one name; more than 3 creates for one definition in
     15 minutes is refused as a loop.
   - Close tunnels when the work is done. Never `--force`-close a tunnel with active connections
     unless the operator asks.
   - Do not scan ports through tunnels: `remote` is exactly one port.
   - The tunnel port is not a secret; the API token is.
6. **Idempotent revive.** If the definition's tracked live tunnel (from the ledger) is still up with
   the same client, `remote_ip:remote_port`, protocol and ACL, it is reused (`reused: true`).
   Otherwise a new one is created. Other live tunnels to the same port are reported and left alone.

## 3. Setup

1. **Server** (once): `server add --url https://rport.example.com --user alice` (creates `default`).
2. **Secret** (once per server): `mcp__apra-fleet__credential_store_set` with
   `name: "RPORT_API_TOKEN"`, `members: "<runner member>"`, `network_policy: "confirm"` (or
   `"allow"`), and a prompt asking for an RPort API token with scope `read+write`. Never ask for the
   token in chat. Fix an existing secret scoped to `*` or with `network_policy: "deny"` via
   `mcp__apra-fleet__credential_store_update`.
3. **Runner member:** any local apra-fleet member on the machine that will use the tunnel
   (`register_member member_type=local` if there is none), then `runner set <member>`.
4. **Check:** `RUN whoami`, then `RUN ip`. A 401 means wrong user or a bad/expired token.

## 4. Workflows

All commands accept `--json`; every write accepts `--dry-run` (prints the planned call with
`Authorization: Basic [REDACTED]`, makes no write, writes no ledger or config).

### Find the client and its definitions
`RUN clients --name <name>` (`GET /clients?filter[name]=<name>`), then
`RUN def list --client <client>`: each stored tunnel with a safety check (`ok` or `UNSAFE: why`).
`RUN def show <name> --client <client>` adds the effective options and the linked fleet member.

### Create a definition (admin change, operator request only)
```
RUN def add <name> --client <client> --remote 22 --scheme ssh [--acl self|ip,...] [--idle 30] [--auto-close 2h] [--public-port P] --dry-run
RUN def add <name> --client <client> --remote 22 --scheme ssh [...]
```
`POST /clients/{client_id}/stored-tunnels` with `remote_ip` (default 127.0.0.1), `remote_port`,
`scheme`, `acl` (`self` resolved to your `/32`) and `further_options`. Guardrails are checked here
and again at every revive.

### Update the ACL after an IP change (admin change)
`RUN def set-acl <name> self --client <client>` (`PUT /clients/{client_id}/stored-tunnels/{id}`,
all fields sent back, since partial updates are not supported). A live tunnel keeps its old ACL; the
next revive creates a new one with the new ACL.

### Make an unsafe stored tunnel's options safe (admin change)
Stored tunnels made in the RPort UI often carry `skip-idle-timeout` (never closes when idle), which
the skill refuses to revive. With the operator's approval, after a `--dry-run`:
`RUN def set-options <name> --client <client> --idle 60 [--auto-close 8h] [--protocol tcp]`.
It removes `skip-idle-timeout` and `check_port=0`, sets the idle timeout, auto-close and protocol
given (otherwise it keeps the stored values; the idle timeout defaults to 30), keeps every other key
the UI stored, and refuses if the result would still break a guardrail. All fields are sent back
(`PUT …/stored-tunnels/{id}`). A live tunnel keeps its old options; the next revive uses the new ones.

### Remove a definition (admin change)
`RUN def remove <name> --client <client>` (`DELETE …/stored-tunnels/{id}`). Live tunnels stay open
until closed or expired.

### Link a definition to a fleet member (local, optional)
`RUN link add <name> --client <client> --fleet-member <member>`; `link list`, `link remove`.

### Revive (reuse or create)
`RUN revive <name> --client <client>` (dry-run first the first time). The last stdout line is
machine-readable:
```
RESULT {"name":"my-ssh","server":"default","host":"rport.example.com","port":31337,"expires_at":"2026-10-29T18:04:11.000Z","reused":false,"action":"create","tunnel_id":"4","client_id":"<id>","stored_tunnel_id":"<id>","acl":"198.51.100.7/32","idle_timeout_minutes":60,"fleet_member":"my-member","previous_port":30211,"port_changed":true}
```
Parse that line, not the human lines. `action` is `create` or `reuse`. `expires_at` is the hard
expiry in UTC (null if unknown). `fleet_member` comes from the link.

### Status (source of truth)
`RUN status [<name> --client <client>]`. Without a name it covers every definition that has a link
or a ledger entry, on all servers:
- **alive** with time left to hard expiry, and `WARNING` when under 15 minutes;
- **expired**: hard expiry passed;
- **closed-idle**: gone before hard expiry, normally the idle timeout (or closed outside the skill);
- **client-offline**: gone and the client is disconnected; reviving fails until it reconnects;
- **closed** (closed by this skill) or **none** (no live tunnel created by the skill yet).

Idle expiry is soft: an alive tunnel can still close after `idle_timeout_minutes` without traffic.

### Live tunnels
`RUN tunnels [--client <client>]` lists `GET /tunnels` joined with ledger expiry. Tunnels not
created by this skill show as untracked; an empty ACL shows as `OPEN TO EVERYONE`.

### Close
`RUN close <name> --client <client>` or `RUN close --tunnel <id> [--client <client>]`
(`DELETE /clients/{client_id}/tunnels/{tunnel_id}`; the stored tunnel stays). If the server says
the tunnel still has active connections, the script reports the refusal (exit 3). Tell the
operator; add `--force` only if they explicitly ask.

### Ledger
`RUN ledger [--def <name>] [--since 24h|<ISO>]`. One record per create, reuse and close:
`def, server, stored_tunnel_id, tunnel_id, client_id, host, lport, acl, created_at, auto_close,
hard_expires_at` (= created_at + auto-close), `idle_timeout_minutes, action`; later records carry
`supersedes`, and listing marks replaced ones `superseded`. A reuse keeps the original
`hard_expires_at`: the auto-close clock does not restart.

## 5. After a revive: update the fleet member

If `RESULT.fleet_member` is set and `port_changed` is true (or this is the first revive):
1. `mcp__apra-fleet__update_member` with `member_name: <fleet_member>`, `host: <RESULT.host>` (only
   if it changed), `port: <RESULT.port>`, `fleet_install: "skip"`.
2. Check reachability with one trivial `mcp__apra-fleet__execute_command` on that member, e.g.
   `hostname`. If it fails, run `RUN status <name> --client <client>` once and report; do not loop.

## 6. Expiry bookkeeping and reminders

- After every create or revive, tell the operator the hard expiry in **their** local time (convert
  `expires_at`; the human line shows the runner's local time) and the idle timeout.
- Optional, if your agent host can schedule a one-shot reminder (Claude Code: `CronCreate` with
  `recurring: false`): offer one about 10 minutes before the hard expiry, e.g. "rport tunnel my-ssh
  expires at 18:04; run status and revive if still needed". Create it only if the operator says yes.
- Whenever in doubt, run `RUN status`: it is the source of truth, not the ledger or memory. A live
  tunnel cannot be extended; after expiry, revive creates a new one (usually a new port).

## 7. Worked example: a fleet SSH member behind a tunnel whose port changes

A device runs the rport client as `my-server`; the fleet member `my-member` reaches it over SSH
through a tunnel. Server `https://rport.example.com`, user `alice`, runner `my-runner` (Git Bash),
secret `RPORT_API_TOKEN` scoped to `my-runner`.

1. Once, local: `node "<skill>/scripts/rport.mjs" server add --url https://rport.example.com --user alice`
   and `node "<skill>/scripts/rport.mjs" runner set my-runner`.
2. Once, **operator-approved admin change**: create the stored tunnel. Dry run, show it, then run:
   ```
   RPORT_TOKEN={{secret.RPORT_API_TOKEN}} node "<skill>/scripts/rport.mjs" def add my-ssh --client my-server --remote 22 --scheme ssh --acl self --idle 60 --auto-close 8h --dry-run
   RPORT_TOKEN={{secret.RPORT_API_TOKEN}} node "<skill>/scripts/rport.mjs" def add my-ssh --client my-server --remote 22 --scheme ssh --acl self --idle 60 --auto-close 8h
   ```
   Idle 60 because the agent uses SSH intermittently; 8h covers a working day.
3. Once, local: `RUN link add my-ssh --client my-server --fleet-member my-member`.
4. Each time it is needed, via `mcp__apra-fleet__execute_command` on `my-runner`:
   ```
   RPORT_TOKEN={{secret.RPORT_API_TOKEN}} node "<skill>/scripts/rport.mjs" revive my-ssh --client my-server
   ```
   PowerShell runner:
   ```
   $env:RPORT_TOKEN={{secret.RPORT_API_TOKEN}}; node "<skill>\scripts\rport.mjs" revive my-ssh --client my-server
   ```
5. Read `RESULT`. With `port_changed: true`: `mcp__apra-fleet__update_member` with
   `member_name: "my-member"`, `port: <RESULT.port>`, `fleet_install: "skip"`; then
   `execute_command` `hostname` on `my-member`.
6. Tell the operator: "my-ssh is at rport.example.com:<port>, open to your IP only, hard expiry
   <local time>, closes after 60 idle minutes." Offer a reminder if the host supports one.
7. Next day, "the tunnel expired": `RUN status` shows `expired`; `revive` creates a new tunnel; update
   the member again. If revive says your IP changed, ask the operator to approve
   `def set-acl my-ssh self --client my-server`, then revive.
8. Done for the day: `RUN close my-ssh --client my-server`.

## 8. Troubleshooting

| Symptom / code | Meaning | What to do |
|---|---|---|
| exit 2 `REFUSED (guardrail)` | the request or the stored tunnel broke a rule above | explain the rule; do not work around it |
| exit 2 `your IP changed from … to …` | stored ACL does not cover your current IP | ask the operator to approve `def set-acl <name> self`, then revive |
| exit 4 `pick one: …` | several servers, none `default` | pass `--server <moniker>` |
| exit 4 `RPORT_TOKEN is not set` / `unsubstituted placeholder` | secret name wrong, not scoped to the runner, or `network_policy: deny` | check with `credential_store_list`; fix with `credential_store_update` |
| exit 4 `no stored tunnel named …` | wrong name, client or server | `def list --client <c> [--server <m>]` |
| 401 | wrong user, token wrong, expired or revoked | operator checks the token's `expires_at`; re-enter via `credential_store_set` |
| 403 | token scope too small (e.g. `read` for a write) | a `read+write` token is needed for writes |
| 404 on create | client disconnected or unknown | `clients --name`; wait for the client to reconnect |
| `ERR_CODE_REMOTE_PORT_NOT_OPEN` | nothing listens on the remote port | check the service on the client; never disable `check_port` |
| `ERR_CODE_LOCAL_PORT_IN_USE` | the stored `public_port` (or a random one) is taken | find what holds it; ask the operator |
| `ERR_CODE_INVALID_ACL` | server rejected the ACL | `def show`; fix with `def set-acl` (operator approval) |
| `ERR_CODE_TUNNEL_EXIST` / `ERR_CODE_TUNNEL_TO_PORT_EXIST` | a tunnel to that remote already exists | `tunnels --client`; if it is an old one of yours and unused, close it, then revive |
| `ERR_CODE_INVALID_IDLE_TIMEOUT` | server rejected the idle timeout | keep 1..120 |
| close says "still has active connections" | someone is connected | tell the operator; `--force` only on their explicit request |
| status `closed-idle` repeatedly | idle timeout too short | recreate the definition with a larger `--idle` (max 120), operator-approved |
| `create loop` refusal | 3+ creates in 15 min for one definition | stop; find out why tunnels die (client flapping? idle?) |

## 9. What not to do

- Don't call the RPort API from the agent session (curl, web fetch) or handle the token in any form.
- Don't create, edit or delete stored tunnels unless the operator explicitly asked.
- Don't widen, rewrite or "fix" a stored ACL or options during revive.
- Don't create tunnels the operator did not ask for, or to clients that aren't theirs.
- Don't use `skip-idle-timeout`, `check_port=0` or `http_proxy` without auth.
- Don't revive in a loop or retry blindly; one revive per request.
- Don't force-close tunnels with active connections unless asked.
- Don't scan ports or sweep a LAN through a tunnel.
