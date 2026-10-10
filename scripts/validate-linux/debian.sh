# Debian family: Debian, Ubuntu, Mint, Pop!_OS and their relatives. The .deb
# is the package channel, so the check reads dpkg's own record; the AppImage
# counts too when one is named (no package-manager record either way).

check_package_install() {
  if [ -n "$OPT_APPIMAGE" ]; then
    package_by_appimage
    return
  fi
  local status
  status=$(dpkg-query -W -f='${db:Status-Abbrev}' "$APP_DEB" 2>/dev/null) || return 1
  case $status in
    ii*) ;;
    *) return 1 ;;
  esac
  # The helper's install script ships inside the app's resources; without it
  # the helper can never be installed from this package.
  [ -f "$APP_INSTALL_ROOT/resources/helper/linux/install.sh" ]
}
