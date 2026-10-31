# Chapter: repositories, code and git

`bb` and `<repo>` as in [pipelines](pipelines.md).

Scopes: `read:repository:bitbucket` to read and clone; `write:repository:bitbucket` (plus read)
to push or create branches.

## Browse without cloning

| Want | Command |
|---|---|
| Repositories | `bb repos list [<workspace>] [--query <text>] [--limit N]` |
| One repository | `bb repos get <repo>` |
| Branches, tags | `bb repos branches <repo> [--query <text>]`, `bb repos tags <repo>` |
| Commits | `bb repos commits <repo> [<branch>] [--limit N]` |
| Compare two refs | `bb repos compare <repo> <a>..<b>` (changed files) |
| One file at a ref | `bb repos file <repo> <ref> <path> [--out <file>]` |
| Code search | `bb repos search [<workspace>] "<query>"` (only if code search is enabled for the workspace) |

Reading a few files is cheaper than cloning; clone when you need to build, test or edit.

## Git: clone, fetch, push

Never build a git URL with a token in it, never run `git config credential.*`, and never use
the user's email as git username (see [auth](auth.md)). Let the script inject auth:

```
bb git ls-remote <repo>                              # quick access check
bb git clone <repo> [<dir>] [--branch <b>]           # remote URL stays https://bitbucket.org/<ws>/<repo>.git
bb git run -C <dir> -- fetch origin
bb git run -C <dir> -- pull --ff-only
bb git run -C <dir> -- push -u origin <branch>       # only when the user asked for the push
```
Plain local git (status, diff, commit, checkout) needs no auth: run it normally in the clone.
Only commands that talk to bitbucket.org go through `bb git run`.

`git run` refuses force pushes (`--force`, `-f`, `--force-with-lease`, `+refspec`, `--mirror`)
unless the user explicitly asked and you pass `--allow-force`, and refuses any URL carrying
credentials. Needs git 2.31 or later on the runner.

Creating a branch on Bitbucket without a clone (only when asked):
`bb repos branch-create <repo> <name> --from <branch|sha> --dry-run`, then without `--dry-run`.
