# RHEL family: Fedora, RHEL, CentOS Stream, Rocky, Alma. No rpm package
# target ships yet (a deliberate non-goal), so the AppImage is the only
# channel and there is no package-manager record to read — the check is the
# AppImage is runnable and pkexec exists to carry the helper install.

check_package_install() {
  package_by_appimage
}
