# Chapter: discussions and the Discussions FAQ

`gh` has no Discussions commands; everything is GraphQL with node IDs. Use the script:
`<run>` below is the command prefix for your identity from SKILL.md, and `-R owner/repo` can be
omitted when `config repo` is set.

Permissions: Discussions write. Marking an answer also needs the triage role or being the
discussion's author, and the category must accept answers (a "Q&A"-style category).

## Read

```
<run> discussions categories -R o/r              # names, ids, which accept answers
<run> discussions list -R o/r [--category NAME] [--answered|--unanswered] [--limit N]
<run> discussions search -R o/r "<words>"        # title search
<run> discussions get -R o/r <number>            # body, comments, replies, answer
```

## Write (on request; `--dry-run` first; bodies from files)

```
<run> discussions create -R o/r --category NAME --title "..." --body-file q.md
<run> discussions comment -R o/r <number> --body-file c.md [--reply-to <comment-id>]
<run> discussions answer -R o/r <number> --body-file a.md      # comment + mark as answer
<run> discussions edit -R o/r <number> [--title ...] [--body-file ...] [--category NAME]
<run> discussions edit-comment <comment-id> --body-file c.md
<run> discussions close|reopen|lock|unlock -R o/r <number> [--reason ...]
```
`create` first searches for an existing discussion with the same or a very similar title and
refuses if it finds one (`--allow-duplicate` only when the user confirms it is different).
`answer` refuses on a category that doesn't accept answers, and on an already answered
discussion unless `--replace-answer`.

## The Discussions FAQ pattern

A FAQ built from Discussions is searchable and linkable:

- **One discussion per question.** Title: the question, under 80 characters (it is what people
  search for). Body: the question as a reader would ask it, with context. **No answer in the body.**
- **The answer is a comment marked as the answer.**
- **A "Start Here" index discussion**, pinned, whose body is a grouped table of contents: a short
  intro, `---`, then `### Topic` headings, each followed by one `- [Question?](url)` line per entry.

### Add an entry (one command)
```
<run> faq add -R o/r --index <index-number> --category NAME --group "Topic" --title "Question?" --question-file q.md --answer-file a.md --dry-run
```
This checks for duplicates, creates the discussion, posts and marks the answer, and adds the
entry to the index. If something fails halfway, re-running the same command resumes; it doesn't
create a second discussion.

### Index upkeep
```
<run> faq index-create -R o/r --category NAME --title "Start Here" --intro-file intro.md
<run> faq index -R o/r <index-number>                       # parsed groups + problems found
<run> faq index-add -R o/r <index-number> --entry <number> --group "Topic"
```
Rules (the script enforces the first three):

- Every entry is in the index; never leave an orphaned FAQ discussion.
- Entries are appended to their group; **existing lines are never reordered** (links are shared
  outside GitHub).
- One line per entry: the title only, no summaries.
- Start a new group when three or more entries share a theme.
- **Pinning has no API.** After creating the index, ask the user to pin it once in the web UI.

`faq index` also reports broken links, duplicates and titles that no longer match their
discussion; fix them with `discussions edit` on the index (dry run shows the diff).

## Answer quality bar

- **Self-contained**: a reader with no prior context understands it.
- **Scannable**: a short bold summary line first, then detail.
- **No internal references**: no team members, internal conversations or ticket numbers the public
  can't open.
- **Tables for comparisons** and matrices of behaviour.
- **No meta-commentary** about how the question came up.
- **Prompts before tool calls**: if an answer shows both what a reader can say to their AI
  assistant and the tool call behind it, lead with the prompt; the call is the "under the hood"
  detail.

## Markdown that renders (the linter enforces this)

GitHub's discussion renderer folds lines unpredictably ("lazy continuation"), so text wrapped at a
fixed column often renders mangled: lists swallowed into paragraphs, quote lines escaping the quote.
Every body file must follow these rules; `discussions ...`, `faq ...` and PR writes refuse a body
that breaks them (`lint <file>` checks one on its own):

- **Each paragraph is one unwrapped line**, blockquote paragraphs too (`> one long line`).
- **A blank line before and after** every list, blockquote, heading and fenced code block,
  including right after a lead-in sentence such as "This does two things:".
- Write the body to a file and re-read it as literal markdown before posting.
