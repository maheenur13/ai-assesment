#!/usr/bin/env python3
"""PreToolUse guard: keep secrets out of the (unedited, submitted) session transcripts.

Blocks tool calls that would print the contents of .env files or environment secrets.
Exit code 2 blocks the call and shows stderr to Claude.
"""
import json
import os
import re
import sys

event = json.load(sys.stdin)
tool = event.get("tool_name", "")
inp = event.get("tool_input", {}) or {}


def block(reason: str) -> None:
    print(f"Blocked by secret-guard: {reason} Transcripts are submitted unedited, so secrets must "
          "never appear in tool output. Use .env.example or ask the user.", file=sys.stderr)
    sys.exit(2)


def is_env_file(path: str) -> bool:
    name = os.path.basename(path or "")
    return name == ".env" or (name.startswith(".env.") and name != ".env.example")


if tool in ("Read", "Edit", "Write", "NotebookEdit") and is_env_file(inp.get("file_path", "")):
    block(f"{tool} of {inp.get('file_path')} is not allowed.")

if tool == "Grep" and is_env_file(inp.get("path", "")):
    block("searching inside .env files is not allowed.")

if tool == "Bash":
    cmd = inp.get("command", "")
    # Node/tsx flags that load a .env into the process without printing it are fine.
    cmd = re.sub(r"--env-file(-if-exists)?=\S+", "", cmd)
    # A .env file (not .env.example) referenced together with anything that can print it.
    env_ref = re.search(r"(^|[\s/'\"=])\.env(\.(?!example)[\w.-]+)?(?=$|[\s'\";|&)])", cmd)
    readers = r"\b(cat|less|more|head|tail|grep|rg|ag|sed|awk|cut|sort|uniq|xxd|od|strings|bat|nl|diff|cmp|source|base64|python3?|node|perl|ruby|tee|open)\b|(^|[;&|]\s*)\.\s"
    if env_ref and re.search(readers, cmd):
        block("this command could print a .env file.")
    # Commands that dump environment variables or resolved container config.
    dumps = [
        (r"(^|[;&|]\s*|\bexec\s+\S+\s+)(printenv|env)(\s|$)", "dumping the environment"),
        (r"\bdocker(\s+compose|-compose)\b[^;&|]*\bconfig\b", "`docker compose config` prints resolved secrets"),
        (r"\bdocker\s+(inspect|container\s+inspect)\b", "`docker inspect` prints container env"),
        (r"\$\{?(OPENAI_API_KEY|OPENROUTER_API_KEY|[A-Z_]*SECRET[A-Z_]*|[A-Z_]*API_KEY)\b", "expanding an API key variable"),
        (r"\bset\s*$|^\s*export\s*$", "dumping shell variables"),
    ]
    for pattern, why in dumps:
        if re.search(pattern, cmd):
            block(f"{why}.")

sys.exit(0)
