# Chapter: pipelines

`bb` below is the runner command from SKILL.md:
`BITBUCKET_TOKEN={{secret.BITBUCKET_API_TOKEN}} node "${CLAUDE_SKILL_DIR}/scripts/bitbucket.mjs"`
(PowerShell: `$env:BITBUCKET_TOKEN={{secret.BITBUCKET_API_TOKEN}}; node "${CLAUDE_SKILL_DIR}/scripts/bitbucket.mjs"`).
`<repo>` is `<workspace>/<repo>`, or just `<repo>` when the workspace is in the config. A
`<pipeline>` is a build number (`123`) or a uuid.

Scopes: `read:pipeline:bitbucket` to read; `write:pipeline:bitbucket` (plus read) to run or stop.

## Read

| Want | Command |
|---|---|
| Recent pipelines | `bb pipelines list <repo> [--status FAILED\|SUCCESSFUL\|...] [--branch B] [--limit N]` |
| Latest / latest failed | `bb pipelines latest <repo> [--branch B]`, `bb pipelines latest-failed <repo> [--branch B]` |
| One pipeline, its steps | `bb pipelines get <repo> <pipeline>`, `bb pipelines steps <repo> <pipeline>` |
| Which steps failed | `bb pipelines failed-steps <repo> [<pipeline>]` (default: latest failed) |
| Progress of a running one | `bb pipelines status <repo> [<pipeline>] [--tail-lines N]` |

## Debug a failure

1. `bb pipelines failed-logs <repo> [<pipeline>]` downloads every failed step's log to
   `.pipeline-logs/` in the runner's working folder (`--out DIR` to change).
2. Read the end of each log first (errors are usually in the last 100-200 lines), then search it
   for `error`, `failed`, `exception`. Don't load whole logs into the conversation.
3. One step only: `bb pipelines log <repo> <pipeline> <step-uuid|step-name> [--tail BYTES]`.
4. Explain the root cause, propose the fix, and after the user's fix is pushed, check the new
   pipeline with `latest` / `status`.

If a log comes back "not available", Bitbucket has expired it (old pipelines) or the step wrote
none; say so rather than retrying.

## Run and stop (only when the user asks)

```
bb pipelines run <repo> --branch <branch> [--custom <pipeline-name>] [--commit <sha>] --dry-run
bb pipelines run <repo> --branch <branch> [...]
bb pipelines stop <repo> <pipeline> --dry-run
bb pipelines stop <repo> <pipeline>
```
Then follow it with `status` at a sensible pace (every 30-60 s, not in a tight loop), within the
rate limit.
