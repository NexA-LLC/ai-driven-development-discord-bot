#!/usr/bin/env python3
"""202 supervisor: stage first, drain without killing active work, health-gated rollback."""
import fcntl
import json
import os
from pathlib import Path
import signal
import subprocess
import time
import urllib.request

ROOT = Path(os.environ.get('SU_RUNTIME_ROOT', str(Path.home() / 'service-runners/su-managed')))
SOURCE = Path(os.environ.get('SU_SOURCE_REPO', str(Path.home() / 'service-runners/flow-runtime/ai-driven-development-discord-bot')))
ENV = Path.home() / 'service-runners/flow-local-workers/su-gateway.env'
ROOT.mkdir(parents=True, exist_ok=True)
lock = (ROOT / 'supervisor.lock').open('w')
fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
NODE = '/opt/homebrew/bin/node'
os.environ['PATH'] = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
PORT = int(os.environ.get('READINESS_PORT', '8790'))
child = None
stopping = False

def log(message):
    print(time.strftime('%Y-%m-%dT%H:%M:%S%z'), message, flush=True)

def run(args, cwd=SOURCE):
    return subprocess.check_output(args, cwd=cwd, stderr=subprocess.STDOUT, timeout=300).decode().strip()

def stage(sha):
    release = ROOT / 'releases' / sha
    if (release / '.built').exists():
        return release
    release.mkdir(parents=True, exist_ok=True)
    archive = subprocess.check_output(['git', 'archive', sha], cwd=SOURCE, timeout=60)
    subprocess.run(['/usr/bin/tar', '-xf', '-', '-C', str(release)], input=archive, check=True)
    run(['npm', 'ci', '--no-audit', '--no-fund'], release)
    run(['npm', 'run', 'typecheck'], release)
    run(['npm', 'run', 'build:gateway'], release)
    (release / '.built').touch()
    return release

def health():
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{PORT}/readiness', timeout=3) as response:
            return json.load(response)
    except Exception:
        return {}

def start(sha):
    env = dict(os.environ, SU_RELEASE_SHA=sha, SU_STATE_DIR=str(ROOT / 'state'))
    proc = subprocess.Popen([NODE, f'--env-file={ENV}', 'dist/gateway/index.js'], cwd=ROOT / 'releases' / sha, env=env)
    log(f'started release={sha} pid={proc.pid}')
    return proc

def ready(proc, sha):
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline and proc.poll() is None:
        value = health()
        if value.get('pid') == proc.pid and value.get('release') == sha and value.get('startupReady'):
            return True
        time.sleep(2)
    return False

def drain(proc):
    if proc.poll() is not None:
        return
    proc.send_signal(signal.SIGUSR2)
    log(f'drain requested pid={proc.pid}')
    # No forced timeout: an unresolved request blocks deployment, never gets killed.
    while proc.poll() is None:
        time.sleep(1)

def stop(_sig, _frame):
    global stopping
    stopping = True
    if child and child.poll() is None:
        child.send_signal(signal.SIGUSR2)

signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
signal.signal(signal.SIGHUP, stop)
current_file = ROOT / 'current.json'
current = json.loads(current_file.read_text())['sha']
child = start(current)
last_check = 0
failed = set()
while not stopping:
    if child.poll() is not None:
        log(f'child exited code={child.returncode}; restarting current release')
        time.sleep(5)
        child = start(current)
    if time.monotonic() - last_check >= 60:
        last_check = time.monotonic()
        try:
            run(['git', 'fetch', 'origin', 'main'])
            desired = run(['git', 'rev-parse', 'origin/main'])
            if desired != current and desired not in failed:
                # Never downgrade a locally staged release or cross divergent history.
                run(['git', 'merge-base', '--is-ancestor', current, desired])
                stage(desired)
                if stopping:
                    break
                previous = current
                drain(child)
                if stopping:
                    break
                child = start(desired)
                if ready(child, desired):
                    current = desired
                    temp = ROOT / 'current.tmp'
                    temp.write_text(json.dumps({'sha': current}))
                    temp.replace(current_file)
                    log(f'activated release={current}')
                else:
                    log(f'readiness failed; rollback to {previous}')
                    failed.add(desired)
                    drain(child)
                    child = start(previous)
        except Exception as error:
            log(f'update deferred: {type(error).__name__}: {str(error)[:300]}')
    time.sleep(1)
if child:
    drain(child)
log('supervisor stopped')
