#!/bin/sh
# Section A of the Orkestrator test plan: the environment the Telegram tests need.
#
#   ops/env-check.sh            # all checks
#   ORCHESTRATOR_HOST=pi-ork ops/env-check.sh
#
# Every check prints OK or FAIL and the whole script exits 1 if anything failed. It changes nothing:
# it reads services, asks the phone for the quota and runs the phone's own token test. No token is printed.
set -u

HOST=${ORCHESTRATOR_HOST:-pi-ork}
HOME_AGENT=${HOME_AGENT_DIR:-$HOME/projekter/home-agent}
APP_DIR=${ORCHESTRATOR_APP:-/home/orkestrator/app}
fail=0

ok() { printf '  OK    %s\n' "$*"; }
bad() {
	printf '  FAIL  %s\n' "$*"
	fail=$((fail + 1))
}
skip() { printf '  MANU  %s\n' "$*"; }
head_() { printf '\n%s\n' "$*"; }

# T-A0 — the version the plan is written against.
head_ "T-A0  botten svarer og har version 0.1.10"
version=$(ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" \
	"node -e 'console.log(require(\"$APP_DIR/package.json\").version)'" 2>/dev/null)
case "$version" in
0.1.10) ok "version $version" ;;
"") bad "kunne ikke læse versionen på $HOST (SSH?)" ;;
*) bad "version $version, planen er skrevet til 0.1.10" ;;
esac

# T-A1 — the bot service.
head_ "T-A1  orkestrator.service kører"
state=$(ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" 'systemctl --user is-active orkestrator' 2>/dev/null)
[ "$state" = "active" ] && ok "active" || bad "state=${state:-ukendt} (se: ssh $HOST 'systemctl --user status orkestrator')"

# T-A2 — the tunnel service.
head_ "T-A2  orkestrator-tunnel.service kører"
tunnel=$(ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" 'systemctl --user is-active orkestrator-tunnel' 2>/dev/null)
[ "$tunnel" = "active" ] && ok "active" || bad "state=${tunnel:-ukendt}"

# T-A3 — the tunnel reaches the phone's MCP endpoint; 401 means it answers and wants the token.
head_ "T-A3  tunnelen svarer (401 = virker)"
code=$(ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" \
	'curl -s -m 10 -o /dev/null -w "%{http_code}" http://127.0.0.1:18901/mcp' 2>/dev/null)
case "$code" in
401 | 400 | 406) ok "HTTP $code fra 127.0.0.1:18901/mcp" ;;
"") bad "intet svar (tunnel eller ssh nede)" ;;
*) bad "HTTP $code; 000 = ingen forbindelse, 502 = telefonen svarer ikke" ;;
esac

# T-A4 — the phone's tool profile: the orkestrator token sees the approved tools, and no others.
head_ "T-A4  profilen på telefonen (8 tests)"
if [ -x "$HOME_AGENT/.venv-termux/bin/python" ]; then
	out=$(cd "$HOME_AGENT" && timeout 120 .venv-termux/bin/python ops/test-client-token.py 2>&1 | tail -2)
	case "$out" in
	*OK*)
		ran=$(printf '%s\n' "$out" | grep -m1 '^Ran ' || true)
		ok "${ran:-test-client-token.py} OK"
		;;
	*) bad "test-client-token.py: $(printf '%s' "$out" | tr '\n' ' ')" ;;
	esac
else
	bad "mangler $HOME_AGENT/.venv-termux/bin/python"
fi

# T-A5 — the quota source that /cost reads: six accounts, and only the phone's own keys are used.
head_ "T-A5  get_balances svarer med seks konti"
if [ -x "$HOME_AGENT/.venv-termux/bin/python" ]; then
	out=$(cd "$HOME_AGENT" && timeout 180 .venv-termux/bin/python - <<'PY' 2>&1
import sys
sys.path.insert(0, ".")
from server.balance import build_balance_tools
from server.config import load

class R:
    def __init__(self): self.tools = {}
    def tool(self, fn): self.tools[fn.__name__] = fn; return fn

r = R()
build_balance_tools(r, load())
for entry in r.tools["get_balances"]():
    print(f'{entry["account"]:16}|{entry.get("balance") or "ERR " + str(entry.get("error"))}')
PY
)
	echo "$out" | sed 's/^/        /'
	total=$(printf '%s\n' "$out" | grep -c '|')
	good=$(printf '%s\n' "$out" | grep -c '|[A-Za-z]' || true)
	broken=$(printf '%s\n' "$out" | grep -c '|ERR' || true)
	if [ "$total" -ne 6 ]; then
		bad "$total konti, forventet 6"
	elif [ "$broken" -eq 0 ]; then
		ok "6 konti, ingen fejl"
	elif [ "$good" -ge 4 ]; then
		ok "6 konti, $broken fejlede (Claude 2: kør 'claude-konto login' på telefonen)"
	else
		bad "6 konti, men kun $good læsbare"
	fi
else
	bad "mangler $HOME_AGENT/.venv-termux/bin/python"
fi

# T-A6 — Threaded Mode is a BotFather setting; there is nothing to query.
head_ "T-A6  Threaded Mode i @BotFather"
skip "slå op: @BotFather → /mybots → bot → Bot Settings → Threaded Mode → Enable"

printf '\n'
if [ "$fail" -eq 0 ]; then
	printf 'Afsnit A: alt grønt%s\n' "$( [ "$code" = 401 ] || printf ' (tunnel svarede %s, ikke 401)' "$code")"
	exit 0
fi
printf 'Afsnit A: %s fejl — se K-tabellen i testplanen\n' "$fail"
exit 1
