"""Scratch-only synthetic Git metadata probe; persists fixed enums/counts only."""
import concurrent.futures
import json
import os
from pathlib import Path
import re
import selectors
import signal
import subprocess
import tempfile
import time


with tempfile.TemporaryDirectory(prefix="inertia-native-git-phase-") as temporary:
    root = Path(temporary)
    home = root / "provider-home"
    home.mkdir(mode=0o700)
    repository = root / "repository"
    repository.mkdir()
    guardian = root / "guardian-observer"
    subprocess.run([
        "cc", "-std=c11", "-Wall", "-Wextra", "-O2",
        "tests/fixtures/darwin-guardian-git-observer.c", "-lproc", "-o", str(guardian),
    ], check=True, timeout=30)
    actual_git = subprocess.check_output(
        ["/usr/bin/xcrun", "--find", "git"], timeout=5, text=True,
    ).strip()
    if not Path(actual_git).is_absolute():
        raise RuntimeError("Toolchain Git path was not absolute")
    environment = {key: os.environ[key] for key in ["USER", "LOGNAME", "TMPDIR"] if key in os.environ}
    environment.update({
        "HOME": str(home), "PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C",
        "GIT_TERMINAL_PROMPT": "0", "GIT_ASKPASS": "",
        "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
    })
    subprocess.run([actual_git, "init", "--quiet", str(repository)], env=environment,
                   check=True, timeout=5, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def run_case(case):
        binary, scenario, repeat = case
        temporary_directory = root / f"temporary-{binary}-{scenario}-{repeat}"
        temporary_directory.mkdir(mode=0o700)
        case_environment = {**environment, "TMPDIR": str(temporary_directory),
                            "TMP": str(temporary_directory), "TEMP": str(temporary_directory)}
        command = "/usr/bin/git" if binary == "apple-shim" else actual_git
        args = ["rev-parse", "--show-toplevel"] if scenario.startswith("rev-parse") else ["cat-file", "--batch"]
        child = subprocess.Popen(
            [str(guardian), "watch", str(os.getpid()), "--", command, *args],
            cwd=repository, env=case_environment, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True,
        )
        started = time.monotonic()
        stdout_bytes = 0
        stderr = bytearray()
        executed = None
        stopped = False
        forced = False
        ready = False
        try:
            ready_result = subprocess.run([str(guardian), "ready", str(child.pid)],
                                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=2)
            ready = ready_result.returncode == 0
            if not ready:
                raise RuntimeError("Private guardian did not become ready")
            os.kill(child.pid, signal.SIGUSR1)
            selector = selectors.DefaultSelector()
            for stream in [child.stdout, child.stderr]:
                os.set_blocking(stream.fileno(), False)
                selector.register(stream, selectors.EVENT_READ)
            while child.poll() is None or selector.get_map():
                now = time.monotonic()
                should_stop = (scenario == "rev-parse-timeout" and now - started >= 3
                               or scenario == "cat-file-cancel" and executed is not None and now - executed >= 0.1)
                if should_stop and not stopped:
                    if child.poll() is None:
                        os.kill(child.pid, signal.SIGTERM)
                    stopped = True
                if now - started > 8:
                    forced = True
                    break
                for key, _events in selector.select(0.01):
                    chunk = os.read(key.fileobj.fileno(), 65_536)
                    if not chunk:
                        selector.unregister(key.fileobj)
                    elif key.fileobj is child.stdout:
                        stdout_bytes += len(chunk)
                    elif len(stderr) < 65_536:
                        stderr.extend(chunk[:65_536 - len(stderr)])
                        if executed is None and b"FIXTURE_EXEC_READY" in stderr:
                            executed = time.monotonic()
                if stdout_bytes > 262_144:
                    forced = True
                    break
            selector.close()
        finally:
            if child.poll() is None:
                # This unreaped direct child still owns the private session;
                # the fixed synthetic commands are the only possible members.
                os.kill(child.pid, signal.SIGTERM)
                try:
                    child.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    forced = True
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait(timeout=3)
            for stream in [child.stdin, child.stdout, child.stderr]:
                stream.close()
        text = stderr.decode("ascii", errors="replace")
        phase = re.search(r"cleanup unproved: ([a-z-]{1,48})/([a-z-]{1,48})\]", text)
        observer = re.search(r"observer taint: ([a-z-]{1,48})\]", text)
        return {
            "binary": binary, "scenario": scenario, "repeat": repeat,
            "ready": ready, "elapsedMs": round((time.monotonic() - started) * 1000),
            "stopSent": stopped, "forced": forced, "returnCode": child.returncode,
            "noteForkEvents": text.count("FIXTURE_NOTE_FORK"),
            "eventErrors": text.count("FIXTURE_EVENT_ERROR"),
            "stdoutBytes": stdout_bytes,
            "failure": {"phase": phase[1], "census": phase[2]} if phase else None,
            "observer": observer[1] if observer else None,
        }

    cases = [(binary, scenario, repeat) for repeat in range(2)
             for scenario in ["rev-parse-complete", "rev-parse-timeout", "cat-file-cancel"]
             for binary in ["apple-shim", "resolved-toolchain"]]
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(run_case, cases))
    output = Path("test-results/macos-kimi/standalone-git-comparison.json")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({"platform": "darwin", "cases": results}, indent=2) + "\n")
    print(json.dumps(results, indent=2))
