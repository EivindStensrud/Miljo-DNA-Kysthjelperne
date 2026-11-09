#!/usr/bin/env bash
# Pulls the newest version of the site from GitHub. Run every few minutes by kysthjelperne-update.timer
# (set up by setup_vm.sh). Safe to run by hand:  sudo -u kystsite /usr/local/bin/kysthjelperne-update
#
# Safety: if the repository ever contains files from a raw/ or private/ folder (anything other than the
# PUT_RAW_FILES_HERE.txt placeholders) the site is NOT updated and the problem is logged.
set -euo pipefail

ENV_FILE=/etc/kysthjelperne-site.env
# shellcheck disable=SC1090
[ -f "$ENV_FILE" ] && . "$ENV_FILE"
REPO_DIR="${REPO_DIR:-/srv/kysthjelperne/repo}"
BRANCH="${BRANCH:-main}"

log() { logger -t kysthjelperne-update "$*"; echo "$*"; }

exec 9>/tmp/kysthjelperne-update.lock
flock -n 9 || { echo "already running"; exit 0; }

cd "$REPO_DIR"
git fetch --quiet origin "$BRANCH"

local_rev=$(git rev-parse HEAD)
remote_rev=$(git rev-parse "origin/$BRANCH")
if [ "$local_rev" = "$remote_rev" ]; then
    echo "up to date ($local_rev)"
    exit 0
fi

# GDPR guard: look at the NEW version before it is published
bad=$(git ls-tree -r --name-only "origin/$BRANCH" | grep -E '(^|/)(raw|private)/' | grep -v 'PUT_RAW_FILES_HERE\.txt$' || true)
if [ -n "$bad" ]; then
    log "REFUSING to update: the repository contains files from raw/ or private/ folders:"
    log "$bad"
    exit 1
fi

git reset --hard --quiet "origin/$BRANCH"
if [ ! -f "$REPO_DIR/docs/index.html" ]; then
    log "WARNING: docs/index.html is missing after update to $remote_rev"
    exit 1
fi
log "updated $local_rev -> $remote_rev"
