#!/bin/sh
# Installs an uploaded ADI-2-Pi release (System → ADI-2-Pi updates → Install from a file). Run as
# root by adi2-pi-self-update.service. ADI-2-Pi stages the archive and its signature; this script
# copies both, checks the signature against the installed release key, unpacks the copy and runs
# its installer with the options of the previous run.
set -eu
STAGE=/var/lib/adi2-pi/update
WORK="$(mktemp -d /var/tmp/adi2-pi-update.XXXXXX)"
trap 'rm -rf "$WORK" "$STAGE/release.tar.gz" "$STAGE/release.tar.gz.sig"' EXIT
echo "== $(date '+%Y-%m-%d %H:%M:%S') installing an uploaded release"
# root-owned copies: what is checked is what gets installed
cat "$STAGE/release.tar.gz" > "$WORK/release.tar.gz"
cat "$STAGE/release.tar.gz.sig" > "$WORK/release.tar.gz.sig"
VERSION="$(/usr/bin/env node /opt/adi2-pi/lib/release-verify.js "$WORK/release.tar.gz" "$WORK/release.tar.gz.sig")"
echo "signature valid – ADI-2-Pi $VERSION"
tar -xzf "$WORK/release.tar.gz" -C "$WORK" --no-same-owner
cd "$WORK/adi2-pi"
bash ./install.sh -y --same-options
echo "== done $(date '+%Y-%m-%d %H:%M:%S')"
