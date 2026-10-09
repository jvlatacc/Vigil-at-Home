# Vigil at Home on Arch Linux and Omarchy

Vigil at Home runs on Arch Linux and on [Omarchy](https://omarchy.org) (Arch +
Hyprland) from the AppImage. osquery — the part that watches what starts and
what connects where — comes from Arch's own `extra` repository. fapolicyd —
the part that blocks a program before it runs — is **not** in the official
repositories; it ships through the AUR, and until you install it Vigil can
watch but not block.

**Arch is not validated in CI.** Automated tests run on Ubuntu, in containers
and on runners; nothing in CI runs on Arch. On Arch you are the validation
tier: after installing, run the checks in [Validate your install](#validate-your-install)
(or the repo's `scripts/validate-linux.sh` routine, which automates the same
list) and read [What is not proven](#what-is-not-proven) before relying on it.

## Install Vigil

Download `Vigil-at-Home-<version>-x86_64.AppImage` from the releases page,
make it executable and run it:

```sh
chmod +x Vigil-at-Home-*-x86_64.AppImage
./Vigil-at-Home-*-x86_64.AppImage
```

If it won't start, your system may be missing FUSE, which AppImages use to
mount themselves; install the `fuse2` package, or run without mounting with
`./Vigil-at-Home-*-x86_64.AppImage --appimage-extract-and-run`. Replacing the
AppImage file with a newer version later is the update path — there is no
auto-update on Linux.

The first-run setup asks for your password through your desktop's own polkit
dialog to install the Vigil helper (a root systemd service). That dialog needs
a running polkit agent — see the next section.

## Desktop services a window-manager setup must provide

A full desktop runs four services that Vigil assumes and never mentions; a
window-manager setup has to provide them itself. **Omarchy bundles all four.**
On a hand-rolled Hyprland (or another bare WM), missing any of them looks like
a Vigil bug but isn't:

- A **polkit agent** — Omarchy ships `hyprpolkitagent`. Without one, no
  password dialog can open: the helper install fails with "nothing on this
  desktop answers polkit", and so does every unblock approval. Vigil then
  offers a copy-paste terminal command as a fallback.
- A **tray-capable bar** — Omarchy's waybar has the tray module. Without it,
  closing the Vigil window makes the app invisible until you start it again.
- A **notification daemon** — Omarchy ships `mako`. Without one, Vigil's
  alerts never appear.
- **XWayland** — Omarchy ships `xorg-xwayland`. Vigil shows its alert window
  through XWayland under Wayland.

## osquery (watching) — from the official extra repository

osquery is in Arch's official repositories, so a normal install is all it
takes:

```sh
sudo pacman -S --needed osquery
```

Vigil looks for `osqueryd` at `/opt/osquery/bin/osqueryd`, `/usr/bin/osqueryd`
or `/usr/local/bin/osqueryd` — the first is where osquery's own deb and rpm
packages put it, the second is where Arch's package puts it, and all three are
accepted. Older Vigil releases only looked under `/opt` and could never see a
distro-packaged osqueryd; if `osquery` reads "not installed" with a current
Arch package installed, update Vigil.

## fapolicyd (blocking) — AUR only

Arch does not package fapolicyd. Install it from the AUR with whatever helper
you use (`paru`, `yay`, `makepkg`); Vigil never runs an AUR helper for you.
While it's absent, Vigil can watch but not block — the setup wizard says so
instead of pretending the step is done.

Once it's installed, run the two setup commands the wizard shows (they match
Vigil's own copy-paste commands on every distribution):

```sh
sudo mkdir -p /etc/fapolicyd/rules.d && echo 'allow perm=any all : all' | sudo tee /etc/fapolicyd/rules.d/06-vigil-allow.rules >/dev/null
```

```sh
sudo sed -i 's/^trust *=.*/trust = file/' /etc/fapolicyd/fapolicyd.conf; sudo systemctl kill --signal=SIGKILL fapolicyd 2>/dev/null; sudo fagenrules --load; sudo systemctl enable fapolicyd && sudo systemctl restart fapolicyd
```

The first writes Vigil's allow-everything rule (so fapolicyd blocks only what
you block in Vigil), and the second points fapolicyd at plain files for trust,
loads the rules and starts the service. The restart at the end is not a
politeness: on fapolicyd 1.3 a rules reload never matches a hash, so the
service must fully restart for a block to take effect.

## How Vigil decides what's trusted on Arch

Vigil treats binaries owned by your package manager as trusted and everything
else as untrusted, which shapes how rules treat them. On Arch it reads
pacman's local database under `/var/lib/pacman/local`: a path listed there
belongs to a pacman package. Packages you install through pacman — including
AUR packages, which are installed and registered through pacman either
directly or through a helper — are owned and read trusted. Everything else
reads unsigned, like an unsigned download on macOS.

## Validate your install

Because nothing on Arch is covered by CI, validate by hand. The repo's
`scripts/validate-linux.sh` (run as root from a Vigil checkout) prints PASS or
FAIL with a remedy for each item below; if your checkout doesn't have it yet,
these are the checks:

- The helper is active (`systemctl is-active vigil-helper`) and answers on
  `/run/vigil-helper.sock`.
- fapolicyd is running, enforcing (`fapolicyd-cli --check-status`), set to
  `trust = file`, and has Vigil's allow rule at
  `/etc/fapolicyd/rules.d/06-vigil-allow.rules`.
- osquery's service is active and its process events actually arrive: start a
  program and give osquery a few seconds, then check that the launch is
  recorded in `/var/log/osquery/osqueryd.results.log`.
- A block round-trips: block a program you don't need (Vigil ships stand-ins
  for this in the repo's tests), confirm it's refused at the next launch, then
  unblock.

## What is not proven

Beyond CI, three things on Arch are known-unknowns: osquery's eBPF process
events depend on your kernel and on Arch's osquery build having BPF tables
(the check above tells you which side failed); fapolicyd on Arch is a
community AUR build rather than a distribution package, and Vigil's rule
handling assumes the 1.3+ behavior described above; and Wayland popup behavior
hasn't been verified on Hyprland. If a check fails, start with the repo's
troubleshooting guide and `journalctl -u vigil-helper`.

## Uninstall

Uninstall from the app's Settings, or run the uninstall script shipped in the
helper bundle. Removing the AppImage file alone leaves the root helper
installed, and network blocks it made stay in nftables until reboot — run the
uninstall script to clean both up.
