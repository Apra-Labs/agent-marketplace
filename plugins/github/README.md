# github

A **supplement** for agents working on GitHub. Agents already handle everyday `gh` work well
(creating and viewing PRs and issues, merging, labels, cloning), so this plugin covers only what
they reliably get wrong:

- **Identity**: every write says who it acts as. Choose per repo between a token injected from an
  apra-fleet secret, the apra-fleet GitHub App, your own `gh` login, or a GitHub App key; never by
  accident, never a silent fallback.
- **Discussions** (GraphQL-only, no `gh` support) and a **Discussions FAQ**: duplicate check,
  answer + mark answer, a "Start Here" index kept in order, and a linter for markdown that GitHub
  renders badly.
- **PR review mechanics**: comment only on lines that are in the diff, multi-line ranges,
  suggestions, list/reply/resolve review threads, re-request review.
- **Issues**: sub-issues, issue types, closing as duplicate.
- **Actions**: why a run failed (failed steps, log tails, annotations), re-run failed jobs,
  dispatch with validated inputs.

## Requirements

- Node.js 18+. No npm dependencies; `gh` is only needed for the optional `gh-cli` identity.
- apra-fleet is optional. It enables two identities: a token kept as a fleet secret
  (`{{secret.NAME}}`), or short-lived GitHub App tokens (`{{vcs_token}}` via `vcs_credential_exec`).
  Without fleet use the `gh-cli` or `app-key` identity, or `GH_TOKEN` in CI.

## Install

```
/plugin marketplace add Apra-Labs/agent-marketplace
/plugin install github@apra
```
Other agent hosts: copy `skills/github/` into the host's skills folder.

## Quick start

1. "Set up GitHub identities: use my gh login for my own repos and the fleet App for my-org/*."
2. "Who will post if I comment on my-org/my-repo?" -> `auth whoami`.
3. "Add an FAQ entry to my-org/my-repo discussions: ..." / "Why did CI fail on PR 123?" /
   "Review PR 45 and suggest a fix on the off-by-one" / "Which review threads are still open?"

## Layout

```
.claude-plugin/plugin.json
skills/github/
  SKILL.md                 core: when to use (and not), how to run per identity, rules
  chapters/                auth, discussions, pull-requests, issues, actions
  scripts/github.mjs       Node 18+ CLI, REST + GraphQL, no dependencies
  templates/config.example.json
tests/github.test.mjs      node:test against a local fake GitHub (127.0.0.1)
```

## Test

From the repository root: `npm test`.

## License

[Apache License 2.0](LICENSE).
