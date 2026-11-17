# Chapter: sub-issues, issue types, duplicates

Creating, editing, labelling, commenting and closing issues: use `gh issue` as usual. This chapter
covers three things `gh` doesn't do or agents get wrong. `<run>` is your identity's command prefix.
Permission: Issues write.

## Sub-issues (parent/child)

```
<run> issues sub list -R o/r <parent>
<run> issues sub parent -R o/r <issue>
<run> issues sub add -R o/r <parent> <child-number | other/repo#n> [--replace-parent]
<run> issues sub remove -R o/r <parent> <child>
<run> issues sub move -R o/r <parent> <child> --before <n> | --after <n>
```
- The API wants the child's internal **id**, not its number; the script resolves it.
- Parent and child must belong to the same owner; up to 100 children per parent, 8 levels deep.
- An issue has one parent: moving it needs `--replace-parent` (ask first; it changes someone's plan).

## Issue types

```
<run> issues type -R o/r <issue> <TypeName>      # or: none
```
Types are defined per organization (not for user-owned repos); the script lists the valid ones if
the name doesn't match. Setting a type needs push access; without it GitHub **silently ignores**
the change, so check the result.

## Closing as duplicate

```
<run> issues duplicate -R o/r <issue> --of <original> [--rationale-file why.md] --dry-run
```
This closes the issue with the reason "duplicate" and links the original, which is what GitHub
shows in the timeline. A plain close with a "duplicate of #n" comment doesn't create the link.
