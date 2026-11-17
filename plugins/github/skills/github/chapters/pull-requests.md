# Chapter: pull request review mechanics

Creating, viewing, checking out and merging PRs: use `gh` as usual. This chapter is about the parts
of **reviewing** that agents get wrong: comments placed on lines GitHub rejects, the deprecated
`position` field, broken suggestions, and review threads (which `gh` can't list or resolve).
`<run>` is your identity's command prefix (SKILL.md). Permission: Pull requests write.

## Where you can comment

GitHub only accepts inline comments on lines **inside the diff hunks**: added or context lines on
the RIGHT (new file), removed or context lines on the LEFT (old file). Anything else fails with a
422. Look before you write:

```
<run> prs lines -R o/r <pr> [--path src/file.ts]      # commentable line ranges per file and side
```
Binary or very large files have no patch: only file-level comments are possible there.

## Post a review (on request; dry run first)

Write `review.json`:
```json
{
  "event": "REQUEST_CHANGES",
  "body_file": "review-summary.md",
  "comments": [
    { "path": "src/app.ts", "line": 42, "body_file": "c1.md" },
    { "path": "src/app.ts", "start_line": 50, "line": 53, "body": "Extract this block?" },
    { "path": "src/util.ts", "line": 7, "body": "Off by one.", "suggestion": "  return items.length - 1;" }
  ]
}
```
```
<run> prs review -R o/r <pr> --file review.json --dry-run
<run> prs review -R o/r <pr> --file review.json [--pending]
```
- `line` (+ `side`, default RIGHT; `start_line`/`start_side` for a range). Never `position`.
- A range must sit inside one hunk; a `suggestion` only on the RIGHT side, and it **replaces exactly
  the commented line or range** with its text (keep the original indentation).
- `event`: `COMMENT`, `APPROVE` or `REQUEST_CHANGES` (the last two need the user's explicit say-so);
  `COMMENT` and `REQUEST_CHANGES` need a summary body. `--pending` leaves it as a draft for the
  user to submit.
- The script validates every comment against the diff first and refuses the whole review if one
  line is invalid, so nothing is half-posted.

## Review threads

```
<run> prs threads -R o/r <pr> --unresolved     # path, line, outdated?, who said what, thread id
<run> prs reply <thread-id> --body-file r.md   # replies go to the THREAD, not a comment id
<run> prs resolve|unresolve <thread-id>
<run> prs rerequest -R o/r <pr> --reviewers alice,bob
```
- Resolve a thread only when its point is addressed (or the user says so). Don't bulk-resolve.
- `isOutdated` threads refer to code that changed: check whether the point still applies before
  replying.
- Re-request review after pushing fixes for requested changes; reviewers must be collaborators.
