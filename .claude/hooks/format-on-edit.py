#!/usr/bin/env python3
"""PostToolUse: run Prettier on files Claude just edited in this repo (never blocks)."""
import json
import os
import subprocess
import sys

event = json.load(sys.stdin)
path = (event.get("tool_input") or {}).get("file_path", "")
repo = os.environ.get("CLAUDE_PROJECT_DIR", ".")
exts = (".ts", ".tsx", ".js", ".mjs", ".json", ".md", ".yml", ".yaml", ".css", ".html")
skip = ("/node_modules/", "/dist/", "/generated/", "/migrations/")
if path.startswith(repo + os.sep) and path.endswith(exts) and not any(s in path for s in skip):
    subprocess.run(["pnpm", "exec", "prettier", "--write", "--log-level", "warn", path],
                   cwd=repo, capture_output=True, timeout=20)
sys.exit(0)
