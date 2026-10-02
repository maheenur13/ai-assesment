#!/usr/bin/env python3
"""PreToolUse guard for the assessment's git rules: one commit per task, tagged task-0..task-3.

Blocks history rewrites and destructive git operations. Exit code 2 blocks the call.
"""
import json
import os
import re
import subprocess
import sys

event = json.load(sys.stdin)
if event.get("tool_name") != "Bash":
    sys.exit(0)
cmd = (event.get("tool_input") or {}).get("command", "")
if not re.search(r"\bgit\b", cmd):
    sys.exit(0)


def block(reason: str) -> None:
    print(f"Blocked by git-safety: {reason} The submission needs exactly one commit per task, "
          "tagged task-N, and pushed history must never be rewritten. Ask the user if this is "
          "really intended.", file=sys.stderr)
    sys.exit(2)


rules = [
    (r"\bgit\b[^;&|]*\bpush\b[^;&|]*(\s--force\b|\s--force-with-lease\b|\s-f\b|\s\+\S)", "force push."),
    (r"\bgit\b[^;&|]*\bpush\b[^;&|]*(\s--delete\b|\s-d\b|\s:\S)", "deleting remote refs."),
    (r"\bgit\b[^;&|]*\btag\b[^;&|]*(\s-d\b|\s--delete\b|\s-f\b|\s--force\b)", "deleting or moving a tag."),
    (r"\bgit\b[^;&|]*\b(rebase|filter-branch|filter-repo|replace)\b", "rewriting history."),
    (r"\bgit\b[^;&|]*\breset\b[^;&|]*\s--hard\b", "`git reset --hard` discards work."),
    (r"\bgit\b[^;&|]*\bupdate-ref\b[^;&|]*\s-d\b", "deleting refs."),
    (r"\bgit\b[^;&|]*\bclean\b[^;&|]*\s-[a-z]*f", "`git clean -f` deletes untracked files."),
]
for pattern, why in rules:
    if re.search(pattern, cmd):
        block(why)

# Amending is fine while a task is in progress, never once its commit is tagged.
if re.search(r"\bgit\b[^;&|]*\bcommit\b[^;&|]*\s--amend\b", cmd):
    repo = os.environ.get("CLAUDE_PROJECT_DIR", ".")
    m = re.search(r"\bgit\s+-C\s+(\"[^\"]+\"|'[^']+'|\S+)", cmd)
    if m:
        repo = m.group(1).strip("'\"")
    cd = re.search(r"\bcd\s+(\"[^\"]+\"|'[^']+'|\S+)", cmd)
    if cd:
        repo = cd.group(1).strip("'\"")
    tags = subprocess.run(["git", "-C", repo, "tag", "--points-at", "HEAD"],
                          capture_output=True, text=True).stdout.split()
    if any(t.startswith("task-") for t in tags):
        block(f"HEAD is already tagged {', '.join(tags)}; amending would orphan the tag.")

sys.exit(0)
