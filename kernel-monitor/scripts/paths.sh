#!/bin/sh
# Every path the kernel-monitor lifecycle touches, in one place. install.sh,
# uninstall.sh, check_packaging.sh (host) and vm-lifecycle-check.sh (VM) all
# source this, so what the installer creates and what the residue checks
# demand absent can never drift apart. Must stay POSIX sh.
# Sourced, not run: the VIG_* names are the consumers' interface.
# shellcheck disable=SC2034
VIG_SERVICE=vigil-kernel-monitor.service
VIG_UNIT=/etc/systemd/system/vigil-kernel-monitor.service
VIG_LIBEXEC_DIR=/usr/libexec/vigil-kernel-monitor
VIG_DROPIN_LOCAL=/etc/rsyslog.d/vigil-kernel-monitor.conf
VIG_DROPIN_FORWARD=/etc/rsyslog.d/vigil-forward.conf
VIG_ETC_DIR=/etc/vigil/kernel-monitor
VIG_RULES_DIR=/etc/vigil/kernel-monitor/rules
VIG_INDEX_DIR=/var/lib/vigil/kernel-monitor
