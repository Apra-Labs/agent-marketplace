# Chapter: identity and authentication

Every write on GitHub is done **as someone**: you, a teammate, a bot, a GitHub App. Agents tend to
use whatever `gh` happens to be logged in as, so work ends up under the wrong account. This skill
makes the identity an explicit choice and never falls back to another one silently.

## Identity sources

Configure one or more named identities (`config identity add`), then choose per repo:

| Source | What it is | Good for | Watch out |
|---|---|---|---|
| `env` | Token in `GH_TOKEN` (or `GITHUB_TOKEN`) for that one command | apra-fleet secrets, the apra-fleet GitHub App, CI | The token must be injected per command, never written into config or a file |
| `gh-cli` | The script asks `gh auth token` for the host/user | People who already use `gh` and want their own account | It is *your* account: everything is posted as you. Opt-in only |
| `app-key` | A GitHub App's id, installation id and private key file; the script mints a 1-hour installation token | Teams without apra-fleet that want bot identity | Keep the `.pem` outside any plugin folder (those are replaced on update) and readable only by you |

With apra-fleet:

- **Fleet secret**: store a fine-grained PAT once (`credential_store_set name=GH_FAQ_TOKEN
  members=<local member> persist=true`, collected out of band), add an `env` identity, and run
  commands as `GH_TOKEN={{secret.GH_FAQ_TOKEN}} node ...` through `execute_command`.
- **Fleet GitHub App** (recommended for team and bot work): the fleet mints short-lived App tokens.
  Provision the level the work needs on the local member - `provision_vcs_auth provider=github
  github_mode=github-app git_access=issues` (issues, PRs and discussions) or `full` - then run
  `GH_TOKEN={{vcs_token}} node ...` through `vcs_credential_exec`. Posts appear as the App.

## Choosing who acts

```
node ".../github.mjs" config identity add work-app --source env
node ".../github.mjs" config identity add me --source gh-cli [--user <login>]
node ".../github.mjs" config map my-org/* work-app        # per repo or per owner
node ".../github.mjs" config default me
node ".../github.mjs" config repo my-org/my-repo          # default -R
```
Order: `--identity` flag, then the repo mapping, then the default. If the chosen identity can't
authenticate, the script stops with an AUTH error; it never tries another.

Check before the first write: `auth whoami -R owner/repo` reports the identity, token kind
(`ghp_` classic PAT, `github_pat_` fine-grained PAT, `gho_` OAuth, `ghu_` App user token,
`ghs_` App installation token), the actor, your permission on the repo, and the rate limit.

## Permissions per task

| Task | Fine-grained PAT / GitHub App permission | Classic PAT scope |
|---|---|---|
| Discussions read/write, mark answers | Discussions: write (marking an answer also needs triage+ or being the author) | `public_repo` / `repo` |
| PR reviews, threads, re-request | Pull requests: write | `public_repo` / `repo` |
| Sub-issues, issue types, duplicates | Issues: write (setting a type needs push access, otherwise it is silently ignored) | `public_repo` / `repo` |
| Actions logs | Actions: read | `repo` |
| Re-run, dispatch | Actions: write | `repo` + `workflow` |

For the apra-fleet App: `git_access=issues` covers issues, PRs and discussions but not Actions
writes; `full` covers everything (the App itself must have been granted those permissions).

## Diagnosing failures

| Symptom | Meaning | Fix |
|---|---|---|
| 401 | Token missing, expired or revoked | Re-inject / recreate; App tokens expire after 1 hour (re-mint) |
| 403 "Resource not accessible by integration" | App or fine-grained PAT lacks a permission | The error lists `X-Accepted-GitHub-Permissions`: grant that permission |
| 403 mentioning SAML / SSO | Org enforces SAML SSO | Authorize the token for that org in the token's settings |
| 404 on a repo that exists | No access with *this* identity (GitHub hides private repos) | Check `auth whoami`; map the right identity |
| 403/429 secondary rate limit | Too many writes too fast | The script waits once for `retry-after`; slow down |
| `/user` fails with an App token | Installation tokens have no user | Expected; `whoami` reports the installation instead |

## Never

- Never put a token in config, a file, a URL or a command-line argument; never echo it.
- Never switch to your own `gh` login to get past a permission error on a bot identity, or the
  other way round, without the user deciding that.
