#!/bin/sh
# Installs all available updates of the Pi's apt sources. Run as root by
# adi2-pi-os-upgrade.service (started from ADI-2-Pi's System tab or its automatic updates).
# Non-interactive: changed configuration files are kept, new defaults go next to them (.dpkg-dist).
set -e
export DEBIAN_FRONTEND=noninteractive APT_LISTCHANGES_FRONTEND=none
echo "== $(date '+%Y-%m-%d %H:%M:%S') system update"
# finish an interrupted dpkg run first
dpkg --configure -a
# wait up to 10 min if apt's own daily job holds the lock
apt-get -q -o DPkg::Lock::Timeout=600 update
apt-get -q -y -o DPkg::Lock::Timeout=600 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold full-upgrade
echo "== done $(date '+%Y-%m-%d %H:%M:%S')"
