# Assessment process rules (always loaded)

- One git commit per task in this repo, tagged `task-N`, pushed with `--follow-tags`. Amend freely
  until the tag exists; never after. Finish a task only through `/finish-task N`.
- Never claim something works without showing the command output that proves it. Report failures,
  skipped steps and overruns plainly.
- Time is real wall-clock time from `date`, recorded in README "Time spent". Never round or invent.
- Transcripts are raw and unedited: never print secrets, never `cat .env`; one session per task.
- Every external service the system or reviewers touch goes into the README table
  (provider, purpose, task).
- The parent folder (`..`) mirrors submission.zip; never add visible files there. Edit originals here;
  `scripts/sync-submission.sh` copies README, RUN, tests and fixtures to `..`.
- Major scope or architecture choices: present options + recommendation and ask the user first.
  Record accepted decisions in `docs/decisions.md` with sources.
