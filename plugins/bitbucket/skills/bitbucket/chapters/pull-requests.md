# Chapter: pull requests

`bb` and `<repo>` as in [pipelines](pipelines.md). `<id>` is the PR number.

Scopes: `read:pullrequest:bitbucket` to read; `write:pullrequest:bitbucket` (plus read) to create,
comment, approve, request changes, merge or decline. Pushing the source branch first needs
`write:repository:bitbucket`.

## Read and review

| Want | Command |
|---|---|
| Open PRs | `bb prs list <repo> [--state OPEN\|MERGED\|DECLINED\|SUPERSEDED] [--limit N]` |
| One PR | `bb prs get <repo> <id>` |
| What changed | `bb prs diffstat <repo> <id>` (files), `bb prs diff <repo> <id> --out <file>` (full diff) |
| Discussion | `bb prs comments <repo> <id>`, `bb prs activity <repo> <id>` |

Reviewing: start from `diffstat`, write the diff to a file with `--out`, read the files that
matter, then give the user your findings. Post comments only when the user asks you to.

## Write (only when the user asks; `--dry-run` first)

```
bb prs create <repo> --title "<title>" --source <branch> [--dest <branch>] [--description "<text>"] [--reviewers <uuid,...>] [--close-source] [--draft] --dry-run
bb prs comment <repo> <id> --body "<text>" [--reply-to <comment-id>] [--path <file> --line <n>] --dry-run
bb prs approve|unapprove|request-changes <repo> <id> --dry-run
bb prs merge <repo> <id> [--strategy merge_commit|squash|fast_forward] [--close-source] [--message "<text>"] --dry-run
bb prs decline <repo> <id> [--message "<text>"] --dry-run
```
Re-run without `--dry-run` once the user agrees. Always confirm a merge, and say which strategy the
repo normally uses if you can tell from recent merged PRs.

The source branch must exist on Bitbucket first: push it with
`bb git run -C <dir> -- push -u origin <branch>` (see [repos](repos.md)).
