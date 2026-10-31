# Chapter: authentication (REST and git)

Bitbucket Cloud authenticates **REST** and **git** differently, and the same token needs a
different username on each. Most "Bitbucket doesn't work" problems are one of the traps below.
Read this whole chapter before setting up credentials or debugging a 401/403.

Facts verified against Atlassian's docs and by live tests, 2026-10-31.

## What exists (and what doesn't any more)

Supported credentials:

| Credential | Who it acts as | REST | git over HTTPS |
|---|---|---|---|
| **API token with scopes** (personal) | the Atlassian user | Basic `<atlassian email>:<token>`, or `Authorization: Bearer <token>` | username `x-bitbucket-api-token-auth` (or the user's Bitbucket username, exact case); password = token |
| **Access token** (repository, project or workspace) | a bot user of that repo/project/workspace | `Authorization: Bearer <token>` only | username `x-token-auth`; password = token |

Gone or unusable - never suggest them, and replace them when you find them:

- **App passwords**: creation stopped 2025-09-09, fully removed **2026-07-28**. REST now answers
  401; git answers **410** with `CHANGE-3222 ... App passwords are deprecated`.
- **API tokens without scopes** (the plain "Create API token" button): Bitbucket requires scopes.
  The user must use **"Create API token with scopes"** and pick Bitbucket scopes.
- **Credential files** (`~/.bitbucket-credentials`, `credentials.json`) and tokens in URLs, `.git/config`,
  query strings or command-line arguments. This skill keeps the token in the apra-fleet credential
  store only.
- **OAuth consumers**: their access tokens last 1 hour and refresh tokens rotate on every use, so
  they cannot live in a static secret store. Not supported by this skill.
- **`git@bitbucket.org` SSH**: deprecated in favour of `ssh.bitbucket.org` (brownouts running,
  removal Nov/Dec 2026). If a user relies on SSH remotes, tell them to switch the host to
  `ssh.bitbucket.org`; this skill itself uses HTTPS.

## The three traps

1. **REST with an API token needs the Atlassian account email** as the Basic username. The
   Bitbucket username or `x-bitbucket-api-token-auth` gets
   `401 "API token must be used with an atlassian registered email"`.
2. **git must NOT use the email.** The email as git username fails with a misleading
   `You may not have access to this repository or it no longer exists ... Authentication failed`.
   Use `x-bitbucket-api-token-auth` (API token) or `x-token-auth` (access token).
3. **API-token scopes don't imply each other.** `write:repository:bitbucket` without
   `read:repository:bitbucket` can't read; every `write:` scope needs its `read:` scope too. A
   missing scope is a **403** `"Your credentials lack one or more required privilege scopes."`,
   whose `detail.required` names exactly what to add.

Also: `GET /2.0/user` needs `read:user:bitbucket` and never works with access tokens, so it is a
bad self-test. `auth test` checks a repository instead.

## Scopes to request

API token with scopes (tick read **and** write where you need write):

| Work | Scopes |
|---|---|
| Read repos, clone, browse code | `read:repository:bitbucket` |
| Push, create branches | + `write:repository:bitbucket` |
| Read PRs and comments | `read:pullrequest:bitbucket` |
| Create, comment, approve, merge, decline PRs | + `write:pullrequest:bitbucket` |
| Read pipelines, logs, deployment environments and variables | `read:pipeline:bitbucket` |
| Run or stop pipelines | + `write:pipeline:bitbucket` |
| Create/update deployment variables or environments | + `admin:pipeline:bitbucket` |
| Optional: `GET /user` | `read:user:bitbucket` |

Access tokens use the classic scope names, which do imply each other: `repository`,
`repository:write`, `pullrequest`, `pullrequest:write` (implies `repository:write`), `pipeline`,
`pipeline:write`, `pipeline:variable`.

API tokens must have an expiry (max 1 year). Note it; an expired token is a plain 401.

## Setup (once)

1. The user creates the token in their browser (never paste it into the chat):
   - API token: https://id.atlassian.com/manage-profile/security/api-tokens -> **Create API token
     with scopes** -> app **Bitbucket** -> the scopes above.
   - Access token: repository/project/workspace **Settings -> Access tokens**.
2. Store it in apra-fleet, collected out of band and scoped to the local runner member:
   `credential_store_set name=BITBUCKET_API_TOKEN members=<runner> network_policy=confirm`.
   Use `allow` instead of `confirm` only if the user wants no confirmation per call.
3. Save the non-secret settings (local, no token needed):
   ```
   node "${CLAUDE_SKILL_DIR}/scripts/bitbucket.mjs" config set --type api_token --email <atlassian email> --workspace <workspace>
   ```
   For an access token: `--type access_token` (no email).
4. Test both channels (see SKILL.md for the exact runner command):
   `auth test <workspace>/<repo>` -> REST check + `git ls-remote`, with a diagnosis if either fails.

## How git gets the token (never in the URL)

`scripts/bitbucket.mjs git clone|ls-remote|run` runs git with these environment variables, so the
secret is never in the remote URL, `.git/config`, a helper file, or git's argument list:

```
GIT_TERMINAL_PROMPT=0
GIT_CONFIG_COUNT=2
GIT_CONFIG_KEY_0=credential.helper        GIT_CONFIG_VALUE_0=            (bypass any credential manager)
GIT_CONFIG_KEY_1=http.https://bitbucket.org/.extraHeader
GIT_CONFIG_VALUE_1=Authorization: Basic base64(<git username>:<token>)
```

`Authorization: Bearer` does **not** work for git on Bitbucket Cloud; only Basic does. For push,
fetch or pull in an existing clone use `git run -C <dir> -- push origin <branch>`; never write the
token into a remote URL and never run `git config credential.*` to store it.

## Diagnosing failures

| Symptom | Cause | Fix |
|---|---|---|
| REST 401 `API token must be used with an atlassian registered email` | API token sent with a username that isn't the Atlassian email | `config set --email <atlassian email>` |
| REST 403 `lack one or more required privilege scopes` | Authenticated, scope missing | Add the scopes in `detail.required` (+ their `read:` pair); a new token is needed (scopes can't be edited) |
| REST 401 (other) | Expired/revoked token, unscoped classic token, or access token used as Basic | Check expiry; recreate "with scopes"; access tokens are Bearer |
| git 410 / `CHANGE-3222 App passwords are deprecated` | An app password is still in use, often cached by a credential manager | Remove the cached Bitbucket credential; use this skill's `git` commands |
| git `Authentication failed` / `may not have access ... no longer exists` | Email used as git username, wrong username case, expired token, or no repo read scope | Let `bitbucket.mjs git ...` build auth; check expiry and `read:repository` |
| Bearer rejected on `/2.0/user` | Access tokens can't call `/user` | Test a repository endpoint (`auth test`) |

Rate limits: about 1,000 REST calls/hour for repository data, per user; git operations 60,000/hour.
The script warns when Bitbucket reports you are near the limit; slow down instead of retrying.

## Never

- Ask the user to paste a token into the chat, or put one in a file, URL, `.git/config` or argument.
- Suggest app passwords, unscoped API tokens, or OAuth consumers.
- Call the Bitbucket API with curl or a web-fetch tool from the agent session; use the script
  through apra-fleet.
