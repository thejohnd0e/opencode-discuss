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
import subprocess
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent
EXE = Path(os.environ["APPDATA"]) / "npm/node_modules/@opencode/cli/bin/opencode.exe"
TEMP = Path(os.environ["LOCALAPPDATA"]) / "Temp/opencode" / "discuss-tui-smoke"
TEMP.mkdir(parents=True, exist_ok=True)

journal = TEMP / "tui.jsonl"
journal.write_text("", encoding="utf-8")

env = os.environ.copy()
env["DISCUSS_LOG"] = str(journal)
env["XDG_STATE_HOME"] = str(TEMP / "state")
env["OPENCODE_CONFIG_CONTENT"] = json.dumps({"plugins": [str(REPO)], "permissions": []})
env["OPENCODE_CLI_CONFIG_CONTENT"] = json.dumps({
    "plugins": ["-*", str(REPO)],
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
