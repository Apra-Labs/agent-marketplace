# Chapter: scripts

Read `SKILL.md` first: it covers how every command runs (through `mcp__apra-fleet__execute_command`
on the runner member, token only as `{{secret.NAME}}`), servers and monikers, and the general guardrails.

In this chapter `RUN <args>` is shorthand for the runner-shell command:

- Git Bash / POSIX: `RPORT_TOKEN={{secret.RPORT_API_TOKEN}} node "<skill>/scripts/rport.mjs" <args>`
- PowerShell: `$env:RPORT_TOKEN={{secret.RPORT_API_TOKEN}}; node "<skill>\scripts\rport.mjs" <args>`

Use the server's `token_secret` instead of `RPORT_API_TOKEN`, and add `--server <moniker>` when more
than one server is configured and the one you want is not `default`.

## 1. Concepts

- The RPort server keeps a **script library**: named, reviewed scripts with an interpreter, working
  directory, timeout, tags and an `is_sudo` flag.
- **Running** a script sends its text to **one connected client**, which writes it to a temp file,
  runs it with the interpreter, and reports stdout/stderr back as a **job** (`jid`). RPort has no
  "run library script" call: the CLI reads the library entry and submits its exact text.
- A job's status is `running`, `successful`, `failed` or `unknown`. **`unknown` means the server
  stopped watching at the timeout; the process may still be running on the client.** RPort has no
  way to cancel a running script.
- Output is kept per job on the server (each of stdout/stderr capped by the client, default 4 MiB).

## 2. Safety model (enforced by the script, explain it when refusing)

Running a script is remote code execution on someone's machine. This skill is deliberately narrow:

| Allowed | Not allowed |
|---|---|
| Read the library, read past jobs and their output | Ad-hoc scripts or commands you write, on any client |
| Run a **library** script on **one** client, on the operator's request, after a dry run | Multi-client runs, client groups, tags, websocket runs |
| Elevation (`--sudo`) only when the operator explicitly asks for it for that run | Running a library script marked `is_sudo` without that request |
| Create/update/delete library scripts only on explicit request, dry run first | Script text passed as a command-line string (only from a file) |

- If what the operator wants isn't in the library, say so and offer to **add it to the library**
  (from a file they review), never to run it ad hoc.
- Before every run, show the dry run: client, script name, interpreter, working directory, sudo,
  timeout, the script's SHA-256 and its first lines. Run only after the operator agrees.
- Timeouts: default from the library entry (else 60 s), maximum 3600 s. A larger request body than
  the server accepts (default 10 KB, base64 inflates by a third) is refused; split the script.
- Every run is recorded in the ledger (script, hash, client, sudo, job id, status) and in the
  server's audit log.

## 3. Setup

Needs, on the RPort side (admin tasks; explain them, don't do them):

- An API token with **`read+write`** scope (a `read` token can only look) and a user in a group
  with the **`scripts`** permission and access to the target client (administrators have both).
- On the client, in `rport.conf`: `[remote-commands] enabled = true` **and**
  `[remote-scripts] enabled = true` (scripts need both; the example config ships scripts disabled),
  then restart the client.

## 4. Workflows

### Browse the library (read-only)
```
RUN scripts list [--query <text>]
RUN scripts show <script>                  # full text, interpreter, sudo, timeout, tags
```
`<script>` is a library name (exact, then case-insensitive) or id.

### Run a library script on one client (operator request only)
```
RUN scripts run <script> --client <client> --dry-run
RUN scripts run <script> --client <client> [--timeout <sec>] [--cwd <dir>] [--wait <sec>]
```
Add `--sudo` only when the operator explicitly asked for elevation for this run. The CLI polls the
job and prints status, the last lines of stdout/stderr and the path of the full job file
(`--out <file>` to choose it). Read the summary and tails first; open the full file only for what
you need. If it says the job is still running, check later with `scripts job`.

### Check jobs
```
RUN scripts job <client> <jid>             # one job: status, error, output tails, full output file
RUN scripts jobs <client> [--limit N]      # recent jobs on that client
```

### Manage the library (admin change, operator request only)
```
RUN scripts add <name> --file <path> [--interpreter <i>] [--cwd <dir>] [--sudo] [--timeout <sec>] [--tags a,b] --dry-run
RUN scripts update <script> [--file <path>] [--name <n>] [--interpreter <i>] [--cwd <dir>] [--sudo|--no-sudo] [--timeout <sec>] [--tags a,b] --dry-run
RUN scripts delete <script> --dry-run
```
Then without `--dry-run` once the operator agrees. Script text only comes from a file the operator
has seen. Interpreter: `cmd` or `powershell` on Windows, `sh`/`bash` or an absolute path on Unix;
leave it unset for the server default (`cmd` on Windows, `/bin/sh` on Unix).

## 5. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| 409 "remote scripts are disabled" / "remote commands execution is disabled" | Client config | Operator enables both sections in the client's `rport.conf` and restarts it |
| 409 "a previous command is still running" | One job at a time per client | Check `scripts jobs <client>`; wait |
| 404 "Active client ... not found" | Client offline or paused | Check `clients`; nothing runs on a disconnected client |
| "scope of the provided token is not authorized" | `read` token | Operator creates a `read+write` token and updates the fleet secret |
| 403 | User lacks the `scripts` permission or access to that client | RPort admin grants it |
| status `unknown` | Timeout reached; process may still run | Don't re-run blindly; check the client later, or ask the operator |
| Request too large | Script over the server's `max_request_bytes` | Split it, or the admin raises the limit |

## 6. What not to do

- Never run anything that isn't in the library, and never paste script text into a command line.
- Never run on more than one client per request, or loop a run over clients.
- Never add `--sudo` on your own, or edit a library script to drop/add `is_sudo` to get around the rule.
- Never re-run a script because a job went `unknown`: it may still be running.
- Never put secrets in library scripts or their arguments.
