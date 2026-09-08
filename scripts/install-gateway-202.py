#!/usr/bin/env python3
"""Run on dev202 with one reviewed commit SHA; no secrets are printed."""
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import time
import urllib.request

home = Path.home()
root = home / 'service-runners/su-managed'
source = home / 'service-runners/flow-runtime/ai-driven-development-discord-bot'
sha = sys.argv[1]
if len(sha) != 40 or any(c not in '0123456789abcdef' for c in sha):
    raise SystemExit('expected full commit SHA')
os.environ['PATH'] = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
release = root / 'releases' / sha
release.mkdir(parents=True, exist_ok=True)
archive = subprocess.check_output(['git', 'archive', sha], cwd=source)
subprocess.run(['/usr/bin/tar', '-xf', '-', '-C', str(release)], input=archive, check=True)
for args in [['npm', 'ci', '--no-audit', '--no-fund'], ['npm', 'run', 'typecheck'], ['npm', 'run', 'build:gateway']]:
    subprocess.run(args, cwd=release, check=True)
(release / '.built').touch()
shutil.copy2(release / 'scripts/supervise-gateway.py', root / 'supervise-gateway.py')
# Legacy gateway cannot drain. Require several consecutive idle observations.
port = 8790
for line in (home / 'service-runners/flow-local-workers/su-gateway.env').read_text().splitlines():
    if line.startswith('READINESS_PORT='):
        port = int(line.split('=', 1)[1].strip().strip(chr(34)).strip(chr(39)))
old_pid = None
for _ in range(3):
    with urllib.request.urlopen(f'http://127.0.0.1:{port}/readiness', timeout=5) as response:
        value = json.load(response)
    if value.get('activeWork') != 0:
        raise SystemExit('legacy gateway busy; retry installation later')
    time.sleep(3)
# Select the exact legacy process, not a broad pkill expression.
rows = subprocess.check_output(['ps', '-axo', 'pid,command']).decode().splitlines()
for row in rows:
    if 'node --env-file=/Users/buildman/service-runners/flow-local-workers/su-gateway.env dist/gateway/index.js' in row:
        old_pid = int(row.strip().split()[0])
        break
if old_pid is None:
    raise SystemExit('legacy PID missing; inspect before migration')
state = root / 'state'
state.mkdir(mode=0o700, exist_ok=True)
# Begin history recovery at cutover, not at first start after a connection gap.
(state / 'inbox.json').write_text(json.dumps({'pending': [], 'completed': [], 'onlineAt': int(time.time()*1000)+10000}))
os.chmod(state / 'inbox.json', 0o600)
(root / 'current.json').write_text(json.dumps({'sha': sha}))
label = 'net.nex-a.su.gateway-managed'
plist_path = home / 'Library/LaunchAgents' / (label + '.plist')
logs = home / 'Library/Logs/su-gateway'
plist = {
    'Label': label,
    'ProgramArguments': ['/usr/bin/ssh', '-tt', '-i', str(home / '.ssh/id_ed25519'), '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', 'buildman@127.0.0.1', 'exec /usr/bin/python3 ' + str(root / 'supervise-gateway.py')],
    'RunAtLoad': True, 'KeepAlive': True, 'ThrottleInterval': 10,
    'StandardOutPath': str(logs / 'managed.stdout.log'),
    'StandardErrorPath': str(logs / 'managed.stderr.log'),
}
with plist_path.open('wb') as file:
    plistlib.dump(plist, file)
subprocess.run(['launchctl', 'bootout', 'gui/501/net.nex-a.su.netprobe'], check=False)
os.kill(old_pid, 15)
for _ in range(30):
    try: os.kill(old_pid, 0)
    except ProcessLookupError: break
    time.sleep(1)
else: raise SystemExit('legacy PID did not exit; no duplicate started')
subprocess.run(['launchctl', 'bootstrap', 'gui/501', str(plist_path)], check=True)
print('installed', label, sha)
