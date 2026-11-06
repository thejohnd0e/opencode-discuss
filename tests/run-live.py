"""Isolated smoke test for the server part of the discuss plugin.

It loads the plugin through OPENCODE_CONFIG_CONTENT in a private directory and
checks that the server plugin reaches its ready point. It does not call a model
and does not touch the user's configuration or state.

Full discussion runs still need an approved model pair; see README.
"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent
EXE = Path(os.environ["APPDATA"]) / "npm/node_modules/@opencode/cli/bin/opencode.exe"
TEMP = Path(os.environ["LOCALAPPDATA"]) / "Temp/opencode" / "discuss-server-smoke"
TEMP.mkdir(parents=True, exist_ok=True)

log = TEMP / "discuss.jsonl"
log.write_text("", encoding="utf-8")

env = os.environ.copy()
env["DISCUSS_LOG"] = str(log)
env["XDG_STATE_HOME"] = str(TEMP / "state")
env["OPENCODE_CONFIG_CONTENT"] = json.dumps({
    "plugins": [str(REPO)],
    "permissions": [],
})
env["OPENCODE_CLI_CONFIG_CONTENT"] = json.dumps({
    "plugins": ["-*"],
    "highlights": False,
    "attention": {"notifications": False, "sound": False},
    "terminal": {"title": False},
})

with (TEMP / "stdout.txt").open("wb") as stdout, (TEMP / "stderr.txt").open("wb") as stderr:
    process = subprocess.Popen(
        [str(EXE), "--standalone", str(TEMP)],
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=stdout,
        stderr=stderr,
        cwd=str(TEMP),
    )
    deadline = time.time() + 30
    ready = False
    try:
        while time.time() < deadline:
            time.sleep(1)
            if log.exists() and '"server-ready"' in log.read_text(encoding="utf-8"):
                ready = True
                break
            if process.poll() is not None:
                break
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=10)

errors = (TEMP / "stderr.txt").read_text(encoding="utf-8", errors="replace")
result = {
    "ready": ready,
    "log": str(log),
    "stderr": errors[-800:] if errors.strip() else "",
}
print(json.dumps(result, ensure_ascii=False))
raise SystemExit(0 if ready else 1)
