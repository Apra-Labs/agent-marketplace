# Chapter: GitHub Actions failures, re-runs, dispatch

Listing and viewing runs: `gh run list` / `gh run view` are fine. This chapter is about finding
**why** something failed without drowning in logs, re-running safely, and dispatching workflows
with inputs that won't be rejected. `<run>` is your identity's command prefix. Permissions: Actions
read (triage), Actions write (re-run, dispatch).

## Why did it fail?

```
<run> actions failures -R o/r --pr <n>            # or --branch <b> | --sha <sha>, [--workflow ci.yml]
```
For the newest failed run of each workflow on that head, the script finds the failed jobs and the
**failed steps**, downloads each failed job's log to `.github-logs/` and prints, per failed step,
the last lines plus the lines that look like errors, and the job's annotations (file:line
messages from compilers, linters and test reporters).

Then:

1. Start from the annotations and the error lines; open the full log file only around them.
2. Tell apart: a real failure in the change, a flaky test (passes on re-run, timing/network), and
   an infrastructure problem (runner, rate limit, expired secret, cancelled by a newer push).
3. Say which, with the evidence lines, before suggesting a fix or a re-run.

## Re-run (on request; dry run first)

```
<run> actions rerun -R o/r <run-id> --dry-run           # failed jobs only (default) + their dependents
<run> actions rerun -R o/r <run-id> --all
<run> actions rerun-job -R o/r <job-id>
```
- Re-run failed jobs, not the whole run, unless asked. Re-running a real failure won't fix it;
  re-run when the evidence points to flakiness or infrastructure.
- Runs can be re-run for 30 days and at most 50 times; re-runs use the **original actor's**
  permissions, not the identity that clicks re-run.
- `--debug` turns on runner debug logging for the re-run.

## Dispatch a workflow (on request)

```
<run> actions dispatch -R o/r ci.yml --ref main --input target=staging --input dry_run=true --dry-run
```
The script reads the workflow file at that ref and checks your inputs against its
`workflow_dispatch` inputs: unknown names, missing required ones, a `choice` value that isn't an
option, non-boolean or non-numeric values, more than 25 inputs. It prints the new run's URL when
GitHub returns it.
