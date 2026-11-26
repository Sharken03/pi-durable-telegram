#!/bin/sh
# Copy orkestrator to the host and restart its systemd user service. No sudo.
# Usage: sh ops/deploy-pi.sh [ssh-host]   (default host: pi-ork)
# The script never reads or copies the env file; it only checks that the host has one.
set -eu

HOST=${1:-pi-ork}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

if [ ! -d node_modules ]; then
	echo "error: node_modules is missing; run npm ci first" >&2
	exit 1
fi

set -- src node_modules package.json package-lock.json ops
if [ -d scripts ]; then
	set -- "$@" scripts
fi

echo "Copying $* to $HOST:app/"
ssh "$HOST" 'mkdir -p app work .config/orkestrator .config/systemd/user'
# --delete removes stale files inside the copied folders only, not other files in app/.
rsync -a --delete "$@" "$HOST:app/"

echo "Installing the systemd user unit"
ssh "$HOST" 'cp app/ops/orkestrator.service .config/systemd/user/orkestrator.service &&
	systemctl --user daemon-reload &&
	systemctl --user enable orkestrator'

if ! ssh "$HOST" 'test -f .config/orkestrator/env'; then
	echo "warning: ~/.config/orkestrator/env is missing on $HOST; the service is not restarted" >&2
	echo "  On $HOST: cp app/ops/env.example .config/orkestrator/env, chmod 600 it, fill it in," >&2
	echo "  then run: systemctl --user restart orkestrator" >&2
	exit 1
fi

echo "Restarting orkestrator"
ssh "$HOST" 'systemctl --user restart orkestrator'
sleep 3
if ssh "$HOST" 'systemctl --user is-active --quiet orkestrator'; then
	echo "orkestrator is active on $HOST"
else
	# The journal is in RAM only, so the service user cannot read its own log; an admin user can.
	echo "error: orkestrator is not active on $HOST; see: ssh pi 'journalctl _SYSTEMD_USER_UNIT=orkestrator.service -n 50'" >&2
	exit 1
fi

if ssh "$HOST" 'loginctl show-user "$(id -un)" -p Linger 2>/dev/null' | grep -q '^Linger=no'; then
	echo "note: linger is off, so the service stops at logout and does not start at boot" >&2
	echo "  As root on $HOST: loginctl enable-linger orkestrator" >&2
fi
