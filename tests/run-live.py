"""Isolated smoke test for the server part of the discuss plugin.

It loads the plugin through OPENCODE_CONFIG_CONTENT in a private directory and
checks that the server plugin reaches its ready point. It does not call a model
and does not touch the user's configuration or state.

Full discussion runs still need an approved model pair; see README.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent


def find_opencode():
    """OPENCODE_BIN, then the npm install on Windows, then `opencode` on PATH."""
    explicit = os.environ.get("OPENCODE_BIN")
    if explicit:
        return Path(explicit)
    appdata = os.environ.get("APPDATA")
    if appdata:
        npm = Path(appdata) / "npm/node_modules/@opencode/cli/bin/opencode.exe"
        if npm.exists():
            return npm
    found = shutil.which("opencode")
    if not found:
        sys.exit("opencode not found: put it on PATH or set OPENCODE_BIN")
    return Path(found)


EXE = find_opencode()
# DISCUSS_PLUGIN: load another spec (an installed package directory, a tarball) instead of this checkout.
PLUGIN = os.environ.get("DISCUSS_PLUGIN", str(REPO))
TEMP = Path(tempfile.gettempdir()) / "opencode" / "discuss-server-smoke"
TEMP.mkdir(parents=True, exist_ok=True)

log = TEMP / "discuss.jsonl"
log.write_text("", encoding="utf-8")

env = os.environ.copy()
env["DISCUSS_LOG"] = str(log)
env["XDG_STATE_HOME"] = str(TEMP / "state")
env["OPENCODE_CONFIG_CONTENT"] = json.dumps({
    "plugins": [PLUGIN],
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
