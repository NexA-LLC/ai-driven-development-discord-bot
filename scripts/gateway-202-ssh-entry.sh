#!/bin/sh
# The managed Gateway runs through loopback SSH for local-network permission.
# Keep its long-running stdout/stderr off the SSH pseudo-terminal: if the
# transport stops draining the PTY, both supervisor and Gateway can block in
# a synchronous write and stop serving readiness or checking for updates.
case "$SSH_ORIGINAL_COMMAND" in
  check)
    printf 'ready\n'
    ;;
  run)
    exec /usr/bin/python3 "$HOME/service-runners/su-managed/supervise-gateway.py" \
      >> "$HOME/Library/Logs/su-gateway/managed.stdout.log" \
      2>> "$HOME/Library/Logs/su-gateway/managed.stderr.log" \
      < /dev/null
    ;;
  *) exit 64 ;;
esac
