---
name: github
description: "GitHub work agents usually get wrong, done safely: choosing which identity acts (fleet secret, fleet GitHub App, gh login, or an App key - never by accident), GitHub Discussions and maintaining a Discussions FAQ, pull request review mechanics (inline comments on valid diff lines, suggestions, review threads, resolving), sub-issues, issue types and duplicates, and GitHub Actions failure triage, re-runs and workflow_dispatch inputs. Use when the user mentions GitHub Discussions or a FAQ on GitHub, reviewing a PR with inline or suggested changes, unresolved or resolving review threads, sub-issues or issue types, marking an issue duplicate, why a GitHub Actions run or job failed, re-running failed jobs, dispatching a workflow with inputs, or a GitHub 401/403/404/SAML/'Resource not accessible by integration' error."
---

# GitHub skill (core)

This skill is a **supplement**. For everyday GitHub work - creating, listing or viewing PRs and
issues, merging, labels, cloning, `gh run list` - keep using `gh` and git as you normally would.
Use this skill for the parts agents reliably get wrong:

| Chapter | Covers |
|---|---|
| [auth](chapters/auth.md) | which identity acts for a write, setting identities up safely, diagnosing 401/403/404/SAML |
| [discussions](chapters/discussions.md) | Discussions (GraphQL-only) and the Discussions FAQ workflow: dedupe, answer + mark, index upkeep, markdown that renders |
| [pull-requests](chapters/pull-requests.md) | review mechanics: valid diff lines, multi-line ranges, suggestions, review threads, reply, resolve, re-request |
| [issues](chapters/issues.md) | sub-issues, issue types, closing as duplicate |
| [actions](chapters/actions.md) | why a run failed (failed steps, log tails, annotations), re-running failed jobs, dispatching with validated inputs |

**Read the chapter before acting in its area, and `chapters/auth.md` before the first write.**

## The script

Everything here goes through `scripts/github.mjs` (Node 18+, no dependencies). It talks to the
GitHub REST and GraphQL APIs directly, so it needs no `gh` install - except for the optional
`gh-cli` identity. `node "${CLAUDE_SKILL_DIR}/scripts/github.mjs" help` lists every command.

How you run it depends on the identity (see the auth chapter):

| Identity | How to run |
|---|---|
| `gh-cli` or `app-key` (token obtained by the script itself) | locally: `node "${CLAUDE_SKILL_DIR}/scripts/github.mjs" <command> ...` |
| `env`, token from an **apra-fleet secret** | `mcp__apra-fleet__execute_command` on a local member: `GH_TOKEN={{secret.<NAME>}} node "${CLAUDE_SKILL_DIR}/scripts/github.mjs" <command> ...` |
| `env`, token from the **apra-fleet GitHub App** | `mcp__apra-fleet__vcs_credential_exec` on a local member: `GH_TOKEN={{vcs_token}} node "${CLAUDE_SKILL_DIR}/scripts/github.mjs" <command> ...` |
| `env` in CI | `GH_TOKEN` is already set by the job |

apra-fleet substitutes `{{secret.NAME}}` and `{{vcs_token}}` **already quoted** for the member's
shell: write them bare, never inside your own quotes. In PowerShell use
`$env:GH_TOKEN={{secret.<NAME>}}; node ...`.

Output is JSON. Exit codes: `0` ok, `1` usage, `2` guardrail refusal, `3` API error, `4` config
error, `5` authentication problem (the message says what is wrong and what fixes it).

## Rules for every action

- **Know who acts.** Every write reports `acting_as`. Before the first write in a session, run
  `auth whoami -R <owner/repo>` and tell the user which identity will post. Never switch identity
  to get around an error; diagnose it (auth chapter).
- **Reads are free; writes need the user's request.** Posting discussions, comments or reviews,
  resolving threads, changing issues, re-running or dispatching workflows: only when asked.
- **Dry run first** for every write (`--dry-run`), show the user what will be sent, then run it.
- **Bodies come from files** you wrote and reviewed (`--body-file` etc.), never inline: shell
  quoting corrupts markdown. The script lints markdown bodies and blocks ones GitHub will render
  badly (see the discussions chapter).
- **Public by default:** discussions, comments and reviews on public repos are public. No internal
  names, ticket numbers, hostnames, credentials or private conversation in them.
- **Logs go to files** (`~/.cache/apra-github/logs/`, redacted, outside the repo); read the failing parts, don't paste whole logs.
