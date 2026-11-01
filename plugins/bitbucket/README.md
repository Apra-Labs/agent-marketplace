# bitbucket

An agent skill that makes Claude (or any agent that can call apra-fleet tools) work properly with
**Bitbucket Cloud**: repositories and code, pull requests and reviews, pipelines and logs,
deployments and variables.

Its main job is authentication. Bitbucket authenticates REST and git differently, and the same
token needs a different username on each: REST wants your Atlassian **email**, git must **not**
get the email (it wants `x-bitbucket-api-token-auth`). The skill routes every call through one
tested script that applies the right rule, keeps the token out of the conversation and out of
files, and explains 401/403/410 errors. See
[skills/bitbucket/chapters/auth.md](skills/bitbucket/chapters/auth.md).

Only what Atlassian supports today: **API tokens with scopes** and **repository/project/workspace
access tokens**. No app passwords (removed 2026-07-28), unscoped API tokens, OAuth consumers,
credential files, or tokens in URLs.

## Prerequisites

- **apra-fleet 0.4.4 or later** ([install](https://github.com/Apra-Labs/apra-fleet/blob/main/docs/install.md))
  with a **local** member on this machine (any type; `register_member member_type=local`). The
  token lives in its credential store.
- **Node.js 18+** and **git 2.31+** on that machine.
- A Bitbucket **API token with scopes** (https://id.atlassian.com/manage-profile/security/api-tokens
  -> "Create API token with scopes" -> Bitbucket) or an **access token**. Scopes per task are in
  the auth chapter.

## Install

```
/plugin marketplace add Apra-Labs/agent-marketplace
/plugin install bitbucket@apra
```
Other agent hosts: copy `skills/bitbucket/` into that host's skills folder.

## Quick start

Ask your agent; it handles the commands.

1. Store the token in apra-fleet, collected out of band (never paste it in chat):
   `credential_store_set name=BITBUCKET_API_TOKEN members=<your local member> network_policy=confirm persist=true`
   (any name works; if you pick another, the agent records it with `config set --token-secret <NAME>`)
2. "Set up Bitbucket for workspace `<workspace>` with my email `<atlassian email>`" ->
   `config set --type api_token --email ... --workspace ...` (non-secret, `~/.config/bitbucket-skill/`).
3. "Test my Bitbucket access on `<workspace>/<repo>`" -> `auth test` checks REST and git and
   explains any failure.
4. Then: "why did the last pipeline fail?", "review PR 42", "clone `<repo>` and push my branch",
   "set the AWS_REGION deployment variable in staging".

Moving from the old `bitbucket-devops` skill or `~/.bitbucket-credentials`: put the token into
apra-fleet as above, run `config set`, then delete the credentials file. If it held an app
password, create an API token with scopes instead; app passwords no longer work.

## Layout

```
.claude-plugin/plugin.json
skills/bitbucket/
  SKILL.md                 core: apra-fleet version gate, how to run the script, guardrails, chapter index
  chapters/                auth, repos, pull-requests, pipelines, deployments
  scripts/bitbucket.mjs    Node 18+ CLI, no npm dependencies; token only from BITBUCKET_TOKEN
  templates/config.example.json
tests/bitbucket.test.mjs   node:test against a local fake Bitbucket (REST + git smart-HTTP), 127.0.0.1 only
```

## Test

From the repository root: `npm test`.

## License

[Apache License 2.0](LICENSE).
