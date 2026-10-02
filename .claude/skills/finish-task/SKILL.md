---
name: finish-task
description: Run the Definition of Done for task N (verify, document, commit, tag, push, sync). User-invoked only because it commits, tags and pushes.
argument-hint: <task number 0-3>
disable-model-invocation: true
---

Finish task $ARGUMENTS. Do each step, show real output, stop and report on any failure.
Paths are relative to this repo; `..` is the submission folder.

1. `pnpm lint && pnpm typecheck && pnpm format:check && pnpm test` (db container up).
2. `pnpm audit --prod` — report findings honestly; fix or document in README.
   For tasks 2 and 3 also run the `security-reviewer` agent; fix Critical/High findings (with
   tests) before continuing, and list anything deferred under README "Incomplete work".
3. Clean-clone check: `docker compose down`; commit first if needed (amend is allowed until the tag
   exists); `git clone . <scratchpad>/clean`; there run
   `docker compose -p blubird-clean -f code/docker-compose.yml up --build -d` from a folder laid out
   like the zip (clone placed at `<dir>/code`); verify `/readyz`, seeded data and this task's feature
   with curl; then `docker compose -p blubird-clean ... down -v`.
4. Update README (assumptions, exclusions, incomplete work, services table, test count, time
   spent with the real end time from `date`), RUN.md, docs/decisions.md, CLAUDE.md if conventions
   changed.
5. Secret scan: `git grep -nE 'sk-or-|sk-[A-Za-z0-9]{20,}|OPENAI_API_KEY=.+' -- ':!.claude/skills/finish-task/'` must be empty;
   `git status`.
6. One commit for the task (`git add -A && git commit`), tag `task-$ARGUMENTS`,
   `git push -u origin main --follow-tags` (pre-push runs the tests).
7. `scripts/sync-submission.sh` to refresh `../tests`, `../fixtures`, `../README.md`, `../RUN.md`.
8. Remind the user: after the last message of this session, exit, then build the transcript
   unedited from the submission folder:
   `S=~/.claude/projects/-Users-jahidunnur-Desktop-Job-Assesment-code/<session-id> && cat "$S.jsonl" "$S"/subagents/*.jsonl > transcripts/task-$ARGUMENTS.jsonl`
   (main session first, subagent lines appended verbatim; skip the glob if there are none).
