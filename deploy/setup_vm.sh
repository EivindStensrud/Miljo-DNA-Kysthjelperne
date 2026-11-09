#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu/Debian VM (NREC or any other) that serves the Kysthjelperne site.
#
#   sudo ./setup_vm.sh <domain> <repo-https-url> [branch]
#   example: sudo ./setup_vm.sh kysthjelperne.uio.no https://github.com/EivindStensrud/Miljo-DNA-Kysthjelperne.git main
#
# What it does: installs nginx + git + certbot, makes a user without login (kystsite), clones the repo,
# serves its docs/ folder, and checks every 5 minutes for a new version on GitHub.
# It does NOT turn on HTTPS: do that after the domain points to this VM (README.md, step 5).
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "run with sudo"; exit 1; }
DOMAIN="${1:?usage: sudo ./setup_vm.sh <domain> <repo-https-url> [branch]}"
REPO_URL="${2:?usage: sudo ./setup_vm.sh <domain> <repo-https-url> [branch]}"
BRANCH="${3:-main}"
HERE="$(cd "$(dirname "$0")" && pwd)"
BASE=/srv/kysthjelperne
REPO_DIR="$BASE/repo"

command -v apt-get >/dev/null || { echo "This script is for Ubuntu/Debian (apt). See README.md for other systems."; exit 1; }

echo "== packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq nginx git certbot python3-certbot-nginx unattended-upgrades util-linux

echo "== user and folders"
id kystsite >/dev/null 2>&1 || useradd --system --home "$BASE" --shell /usr/sbin/nologin kystsite
mkdir -p "$BASE"
chown kystsite:kystsite "$BASE"

echo "== clone $REPO_URL ($BRANCH)"
if [ ! -d "$REPO_DIR/.git" ]; then
    sudo -u kystsite git clone --quiet --branch "$BRANCH" "$REPO_URL" "$REPO_DIR"
fi
[ -f "$REPO_DIR/docs/index.html" ] || { echo "docs/index.html not found in the clone, wrong repository or branch?"; exit 1; }

echo "== update service (every 5 minutes)"
cat > /etc/kysthjelperne-site.env <<EOF
REPO_DIR=$REPO_DIR
BRANCH=$BRANCH
EOF
install -m 755 "$HERE/update_site.sh" /usr/local/bin/kysthjelperne-update
cat > /etc/systemd/system/kysthjelperne-update.service <<'EOF'
[Unit]
Description=Fetch the newest Kysthjelperne site from GitHub

[Service]
Type=oneshot
User=kystsite
ExecStart=/usr/local/bin/kysthjelperne-update
EOF
cat > /etc/systemd/system/kysthjelperne-update.timer <<'EOF'
[Unit]
Description=Check for a new Kysthjelperne site every 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now kysthjelperne-update.timer

echo "== nginx"
sed -e "s#@DOMAIN@#$DOMAIN#g" -e "s#@ROOT@#$REPO_DIR/docs#g" "$HERE/nginx-site.conf.template" > /etc/nginx/sites-available/kysthjelperne
ln -sf /etc/nginx/sites-available/kysthjelperne /etc/nginx/sites-enabled/kysthjelperne
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

echo "== automatic security updates"
dpkg-reconfigure -f noninteractive unattended-upgrades || true

cat <<EOF

Done. The site is served over HTTP at http://$DOMAIN (once DNS points here).
Next: turn on HTTPS once the domain resolves to this VM:
    sudo certbot --nginx -d $DOMAIN --redirect -m you@uio.no --agree-tos
Check the updater:   systemctl list-timers | grep kysthjelperne     and     journalctl -t kysthjelperne-update
EOF
