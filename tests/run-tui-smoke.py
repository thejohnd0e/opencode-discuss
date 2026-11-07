"""Isolated smoke test for the TUI part of the discuss plugin.

Starts a private standalone OpenCode with only this plugin enabled on the TUI
side, and waits for the TUI journal to record `ready`. A setup that throws
(for example "Keymap.Provider is missing") never reaches `ready`, and the
host's own log line for the failure is reported.

It does not call a model and does not touch the user's configuration or
state: config comes from environment variables, the journal and state go to
a private temp directory.
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
TEMP = Path(tempfile.gettempdir()) / "opencode" / "discuss-tui-smoke"
TEMP.mkdir(parents=True, exist_ok=True)

journal = TEMP / "tui.jsonl"
journal.write_text("", encoding="utf-8")

env = os.environ.copy()
env["DISCUSS_LOG"] = str(journal)
env["XDG_STATE_HOME"] = str(TEMP / "state")
env["OPENCODE_CONFIG_CONTENT"] = json.dumps({"plugins": [PLUGIN], "permissions": []})
env["OPENCODE_CLI_CONFIG_CONTENT"] = json.dumps({
    "plugins": ["-*", PLUGIN],
    "highlights": False,
    "attention": {"notifications": False, "sound": False},
    "terminal": {"title": False},
})


def lines():
    out = []
    for raw in journal.read_text(encoding="utf-8").splitlines():
        try:
            out.append(json.loads(raw))
        except json.JSONDecodeError:
            pass
    return out


started = time.time()
with (TEMP / "stdout.txt").open("wb") as stdout, (TEMP / "stderr.txt").open("wb") as stderr:
    process = subprocess.Popen(
        [str(EXE), "--standalone", str(TEMP)],
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=stdout,
        stderr=stderr,
        cwd=str(TEMP),
    )
    deadline = time.time() + 40
    ready = False
    try:
        while time.time() < deadline:
            time.sleep(1)
            if any(entry.get("stage") == "ready" for entry in lines()):
                ready = True
                break
            if process.poll() is not None:
                break
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=10)

# The host logs a failed plugin setup in the shared OpenCode log; report only
# lines written during this run that name this plugin.
failures = []
log_file = Path.home() / ".local/share/opencode/log/opencode.log"
if log_file.exists():
    since = time.strftime("%Y-%m-%dT%H:%M", time.gmtime(started - 60))
    with log_file.open(encoding="utf-8", errors="replace") as handle:
        for raw in handle:
            if "plugin operation failed" in raw and "plugin=discuss" in raw and raw[10:26] >= since:
                failures.append(raw.strip()[:400])

stages = [entry.get("stage") for entry in lines()]
result = {"ready": ready, "stages": stages[:12], "hostFailures": failures[-3:], "journal": str(journal)}
print(json.dumps(result, ensure_ascii=False))
raise SystemExit(0 if ready else 1)
