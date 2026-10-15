#!/usr/bin/env bash
# One-shot VPS installer (Ubuntu 22.04/24.04, Debian 12). Run as root or with sudo:
#   curl -fsSL https://raw.githubusercontent.com/rusius377/munder-difflin/main/trading/deploy/install_vps.sh | sudo bash
# Installs Python 3.12 venv, the desk, backtrader + websockets, and a systemd service that restarts forever.
# IMPORTANT: Binance Futures is geo-blocked in some regions (US, UK retail, ...). Pick a VPS region such as
# Singapore / Tokyo / Seoul / Frankfurt and verify with `munder-trader doctor`.
set -euo pipefail

REPO="${REPO:-https://github.com/rusius377/munder-difflin.git}"
DEST="${DEST:-/opt/munder-trader}"
USER_NAME="${USER_NAME:-trader}"

echo ">> packages"
apt-get update -y
apt-get install -y --no-install-recommends git python3 python3-venv python3-pip build-essential curl ca-certificates

id -u "$USER_NAME" >/dev/null 2>&1 || useradd -m -s /bin/bash "$USER_NAME"

echo ">> source"
if [ -d "$DEST/.git" ]; then
  git -C "$DEST" pull --ff-only
else
  git clone --depth 1 "$REPO" "$DEST"
fi
chown -R "$USER_NAME":"$USER_NAME" "$DEST"

echo ">> python env"
sudo -u "$USER_NAME" bash -c "cd '$DEST/trading' && python3 -m venv .venv && . .venv/bin/activate && pip install -U pip && pip install -r requirements.txt && pip install -e ."

if [ ! -f "$DEST/trading/.env" ]; then
  cp "$DEST/trading/.env.example" "$DEST/trading/.env"
  chown "$USER_NAME":"$USER_NAME" "$DEST/trading/.env"
  chmod 600 "$DEST/trading/.env"
  echo ">> wrote $DEST/trading/.env — put your BINANCE_API_KEY / BINANCE_API_SECRET and MT_TRADING_ENV there"
fi

echo ">> self-test"
sudo -u "$USER_NAME" bash -c "cd '$DEST/trading' && . .venv/bin/activate && munder-trader selftest >/dev/null && echo selftest OK"

echo ">> service"
sed "s#/opt/munder-trader#$DEST#g; s#User=trader#User=$USER_NAME#" "$DEST/trading/deploy/munder-trader.service" > /etc/systemd/system/munder-trader.service
systemctl daemon-reload
systemctl enable munder-trader
systemctl restart munder-trader

cat <<EOF

Done. Useful commands:
  journalctl -u munder-trader -f                       # live log
  sudo -u $USER_NAME $DEST/trading/.venv/bin/munder-trader doctor   # connectivity / keys / region check
  ssh -L 8787:127.0.0.1:8787 <user>@<vps>  → http://localhost:8787   # dashboard from your laptop/phone
  touch $DEST/trading/state/KILL_SWITCH                 # stop new entries immediately (rm to resume)
EOF
