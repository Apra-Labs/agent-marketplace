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

## 5. Analysing run history (read-only)

People ask "who ran what on which machine, when, and what did it do?" RPort can answer, but the
answer is spread over several places and none of them is complete. Analysing history is
**read-only work**: it never runs, re-runs or test-runs anything.

### Where each fact lives

| Fact | Source | Catch |
|---|---|---|
| A run on a client: status, times, who, privileges, output | job detail `/clients/{id}/commands/{jid}` | The job **list** has only id, status and finish time; everything else needs the detail |
| What ran | job detail `command` | For scripts this is the **full script text**. There is **no link to a library script**: attribution means matching the text |
| Which library script, which version | library + audit log `library.script` create/update | The library holds only the current text; earlier versions exist only in the audit log |
| Who started it, from which IP, which targets | audit log `client.script` `execute.start` / `execute.done` | Needs the `auditlog` permission, and often covers only part of the history |
| One click, many clients | multi-job `/commands/{jid}` (`multi_job_id` on the job) | The web UI runs everything as a multi-job, even for one client |
| Scheduled vs manual | job `schedule_id` | Non-null means a schedule started it, not a person at that moment |

Times: job times carry the **client's** time-zone offset (e.g. `+05:30`); the audit log and
multi-jobs use UTC. Compare only normalised UTC times, and quote local time only as a hint.

### How to analyse
```
RUN scripts history [--client <client>] [--user <u>] [--script <name>] [--since 7d|<ISO>] [--until <ISO>] [--status failed]
RUN scripts job <client> <jid>             # one run, same attribution and flags
```
`scripts history` joins all the sources above into one record per run. It caches finished jobs
locally so repeated questions don't re-download them (`--refresh` to bypass). Each record says:
when (UTC + the client's local time), who and from which IP (if audited), what (library script and
**version**, or "not in library"), where (client and OS), how (interpreter as actually resolved,
sudo, timeout, scheduled, how many clients that click targeted) and the outcome (status, error,
output tails), plus **flags**. It also writes a Markdown report (timeline, per-script, per-user,
per-client, and an "Attention" list) and prints its path. Read the JSON or the report; don't page
through raw job lists.

The flags mean:

| Flag | Meaning, and what to say |
|---|---|
| `INTERPRETER_OS_MISMATCH` | The script's syntax doesn't fit the interpreter it ran under, e.g. a bash/`docker` script sent with the default interpreter to a **Windows** client, where `cmd` runs it line by line. Almost always the reason for the failure |
| `NOT_FROM_LIBRARY` | The text matches no library script, past or present: someone ran ad-hoc code |
| `LIBRARY_VERSION_OUTDATED` | It matches an **older** version of a library script; the library has changed since |
| `RAN_SOON_AFTER_LIBRARY_EDIT` | Run within 30 minutes of an edit to that script: likely someone testing their change |
| `SUDO` | Ran elevated through RPort's `is_sudo` (Linux/macOS) |
| `INLINE_SUDO` | `is_sudo` was off, but the text itself calls `sudo` (e.g. `sudo docker ...`, `sudo reboot`): elevation came from the client's sudo rules. Report it as elevated |
| `UNKNOWN_MAY_STILL_RUN` / `STILL_RUNNING` | The server stopped watching (timeout) or it is genuinely still running; its effects may be incomplete or still happening |
| `STALE_RUNNING` | Still says `running` long after its timeout: the client disconnected, rebooted or lost the job, so the status was never finalised. A `sudo reboot` typically ends like this. Whether it completed is unknown from RPort alone |
| `FAILED` | Non-zero exit or execution error; read `error` and the stderr tail |
| `NO_AUDIT_RECORD` | The audit log has no matching entry, so who/IP rest on the job's `created_by` only |
| `MULTI_CLIENT` | One click targeted several clients (the web UI wraps even single-client runs in a multi-job; those are not flagged) |
| `SCHEDULED`, `EMPTY_CLIENT_NAME`, `OUTPUT_TRUNCATED_OR_LARGE` | Context worth stating when relevant |

### Effects: infer, never test

"What did it do?" is answered from **the script text plus its output**, never by running anything:

- Read the script and list what it **intends** to change: containers started or killed, files
  written or deleted, services or packages changed, network calls, reboots.
- Check the output and status for what **actually** happened: a `failed` run whose first command
  errored probably changed nothing; a `successful` `docker run -d` probably left a container
  running; an `unknown` run may still be running.
- Mark each effect as **confirmed by output**, **likely** or **unknown**. If confirming it would
  need a command on the client, say so and leave that decision to the operator. Never run a check
  or a "harmless" test script yourself.

### Reporting to a human

- Lead with the answer, as a short timeline: `<UTC time> <user> ran <script>@<version> on <client> (sudo) -> <status>`, then the reason when it failed.
- Separate **fact** (from records) from **inference** (yours), and say how complete the data is
  ("the audit log covers 40 of 203 runs; user and IP for the rest come from the job record only").
- Group repeats: "7 runs of `kill_firefox` on 3 clients by 2 users, all successful".
- Describe what happened, not who is to blame: name users only as the records do, and don't guess
  intent.
- Job output can contain hostnames, IPs, credentials or personal data. Quote only the lines needed,
  and never repeat anything that looks like a secret even if the redaction missed it.

## 6. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| 409 "remote scripts are disabled" / "remote commands execution is disabled" | Client config | Operator enables both sections in the client's `rport.conf` and restarts it |
| 409 "a previous command is still running" | One job at a time per client | Check `scripts jobs <client>`; wait |
| 404 "Active client ... not found" | Client offline or paused | Check `clients`; nothing runs on a disconnected client |
| "scope of the provided token is not authorized" | `read` token | Operator creates a `read+write` token and updates the fleet secret |
| 403 | User lacks the `scripts` permission or access to that client | RPort admin grants it |
| status `unknown` | Timeout reached; process may still run | Don't re-run blindly; check the client later, or ask the operator |
| Request too large | Script over the server's `max_request_bytes` | Split it, or the admin raises the limit |

## 7. What not to do

- Never run, re-run or test-run a script to find out what it does or how history gets recorded.
  History analysis is read-only.
- Never run anything that isn't in the library, and never paste script text into a command line.
- Never run on more than one client per request, or loop a run over clients.
- Never add `--sudo` on your own, or edit a library script to drop/add `is_sudo` to get around the rule.
- Never re-run a script because a job went `unknown`: it may still be running.
- Never put secrets in library scripts or their arguments.
