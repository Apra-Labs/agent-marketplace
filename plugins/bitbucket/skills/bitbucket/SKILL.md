---
name: bitbucket
description: "Bitbucket Cloud done right: authentication for REST and git (API tokens with scopes, access tokens), repositories, branches, code, pull requests and reviews, pipelines and their logs, deployments and variables. The token stays in apra-fleet's credential store and never reaches the agent. Use whenever the user mentions Bitbucket or bitbucket.org, a Bitbucket repo, PR, pipeline, deployment or workspace, cloning or pushing to Bitbucket, or a Bitbucket 401/403/410, authentication failure or token/scope problem."
---

# Bitbucket skill (core)

Bitbucket Cloud authenticates REST and git differently, and agents get it wrong all the time. This
skill makes every call go through one tested script that applies the right auth, keeps the token
out of the conversation, and explains failures. It is chapter-based: this file holds the rules for
every Bitbucket action and how to run the script; each area of work is a chapter in `chapters/`.
**Read the chapter before acting in its area. Read `chapters/auth.md` before any credential setup
or when anything returns 401, 403 or 410.**

## Chapter index

| Chapter | Covers |
|---|---|
| [auth](chapters/auth.md) | credential types, the REST-vs-git username traps, scopes, setup, diagnosing 401/403/410 |
| [repos](chapters/repos.md) | repositories, branches, tags, commits, compare, file contents, code search, clone/push |
| [pull-requests](chapters/pull-requests.md) | list, review (diff, comments, tasks), create, approve, request changes, merge, decline |
| [pipelines](chapters/pipelines.md) | status, failures, logs, run, stop, monitoring |
| [deployments](chapters/deployments.md) | deployment environments and their variables |

## Requires apra-fleet 0.4.4 or later

Before the first Bitbucket action in a session, call `mcp__apra-fleet__version` (it returns e.g.
`apra-fleet v0.4.4_<build>`). If the tool is missing or the version is below 0.4.4, stop: tell the
user to install or upgrade apra-fleet (https://github.com/Apra-Labs/apra-fleet/blob/main/docs/install.md)
and do not try a workaround.

## How to call Bitbucket: always through the script, via apra-fleet

The user keeps **one secret: their Bitbucket token** (an API token with scopes, or a repository/
project/workspace access token) in the apra-fleet credential store, under any name. Email,
workspace, credential type and the secret's **name** are not secret; they live in the script's
config (`~/.config/bitbucket-skill/config.json`, set with `config set`).

**`<SECRET>` below is that name.** Run `node "${CLAUDE_SKILL_DIR}/scripts/bitbucket.mjs" config show`
(no token needed) and use its `runner_env` value verbatim (e.g.
`BITBUCKET_TOKEN={{secret.BITBUCKET_API_TOKEN}}`, the default name). If the user stored the token
under another name, save it once: `config set --token-secret <NAME>`; if you don't know the name,
`credential_store_list` shows the stored names (never values).

1. **Never** call the Bitbucket API or run authenticated `git` against bitbucket.org yourself (curl,
   web fetch, `git clone https://user:token@...`, credential helpers). Always use
   `scripts/bitbucket.mjs` (Node >= 18, no dependencies).
2. Run it with `mcp__apra-fleet__execute_command` on the **runner member** (any local member on
   this machine; it sees `${CLAUDE_SKILL_DIR}`), passing the token as an environment variable in
   that one command only. Check the runner's shell with `member_detail`.
3. apra-fleet substitutes `{{secret.NAME}}` **already quoted** for the runner's shell. Write it
   bare - `BITBUCKET_TOKEN={{secret.<SECRET>}}`, never inside your own quotes, or the
   token arrives corrupted and Bitbucket answers 401.
4. The script never prints the token and redacts `Authorization` from errors.

Git Bash on Windows, or bash/zsh/sh on macOS and Linux:
```
BITBUCKET_TOKEN={{secret.<SECRET>}} node "${CLAUDE_SKILL_DIR}/scripts/bitbucket.mjs" <group> <command> [args]
```
PowerShell:
```
$env:BITBUCKET_TOKEN={{secret.<SECRET>}}; node "${CLAUDE_SKILL_DIR}/scripts/bitbucket.mjs" <group> <command> [args]
```
Commands that need no token (`config show|set`, `help`) can run with plain `node` locally.

If `execute_command` reports the secret is missing or blocked by its `network_policy`, ask the user
to store it (`credential_store_set`, collected out of band) or relax the policy
(`credential_store_update name=<SECRET> network_policy=allow|confirm`). Never ask for the
token in chat.

Output is JSON on stdout. Exit codes: `0` ok, `1` usage, `2` guardrail refusal, `3` API error,
`4` config error, `5` authentication problem (the message says which trap; see `chapters/auth.md`).
`node ".../bitbucket.mjs" help` lists every command.

## Guardrails for every action

- **Reads are free; writes need the user's request.** Creating or merging PRs, approving,
  commenting, running or stopping pipelines, creating branches, pushing, and changing deployment
  environments or variables are done only when the user asked for that change.
- **Dry run first** for every write: run it with `--dry-run`, show the user what will be sent, then
  run it for real. Merges and anything on `main`/`master`/release branches: always confirm first.
- **No force push** unless the user explicitly asks; the script refuses it without `--allow-force`.
- **Secret values stay out of chat too:** deployment variables marked secured take their value from
  another fleet secret via `--value-env` (e.g. `MY_VALUE={{secret.MY_VALUE}}` before `node`), never
  from a literal argument.
- **Logs and diffs go to files** (`.pipeline-logs/`, `--out`), and you read the parts you need;
  don't dump megabytes into the conversation. Suggest adding `.pipeline-logs/` to `.gitignore`.
- **Respect rate limits**: about 1,000 REST calls/hour per user. Prefer one list call with
  `--limit` over many single gets; stop and tell the user if the script warns you are near the limit.
- Use only what Atlassian supports today: API tokens with scopes and access tokens. Never suggest
  app passwords (removed), unscoped API tokens, credential files, or tokens in URLs.
