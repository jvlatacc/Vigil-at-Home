# Design: Omarchy enablement (osquery paths, pacman trust, arch guidance)

Arch and Omarchy users could install Vigil but got a broken story: the helper
could never see a distro-packaged osqueryd, every binary on the system read
"unsigned", and the setup wizard went silent about install commands. This
design fixes the two structural blockers in code and gives Arch honest
guidance, per spec D4 (art_OrIt2PK3). Two decisions were settled with the
maintainer and bound this work: **enable, not describe** (fix the blockers in
code; no AUR automation), and **Arch stays out of the CI validation matrix**
(it gets docs and the manual validation routine instead).

## Blocker 1 — the osquery path split (gap analysis G2, §3.3)

The two halves of the app disagreed about what "osquery is installed" means:

- The helper hard-coded `LINUX_OSQUERYD_PATH = '/opt/osquery/bin/osqueryd'`
  in `packages/sensors/src/osquery/linuxConfig.ts`, and
  `packages/helper/src/system.ts` repeated the same path in
  `LINUX_BINARIES.osqueryd` (used for the daemon's installed-probe).
  `ensureLinuxOsquery` returned `'not-installed'` unless that exact path
  existed — so a distro-packaged osqueryd was permanently invisible to
  blocking, and the config was never written.
- The app's own check (`checks.ts`) accepted `/opt/osquery/bin/osqueryd` **or**
  `/usr/bin/osqueryd`.

On Arch, `extra/osquery` installs to `/usr/bin/osqueryd` — which the app
called installed and the helper called missing. The `extra` repository is
official (verified against archlinux.org: osquery 5.22.1-4), so telling Arch
users to fetch installers from osquery.io was worse than their own repo.

**Fix:** one resolver, one candidate list, three consumers.

## Blocker 2 — the pacman trust inversion (gap analysis G4, §3.4)

`packages/sensors/src/linux/packages.ts` built the package-trust index from
dpkg and rpm sources (plus snap and flatpak recognition). There was no pacman
source, so on Arch `PackageIndex` was empty and `trust()` returned
`{ signing: 'unsigned' }` for **every binary on the system** — pacman-owned
system libraries included. The index's contract ("anything not owned by a
package manager is untrusted") inverted Arch's trust signal wholesale, which
shapes rule behavior: untrusted is treated like macOS-unsigned.

**Fix:** a pacman source reading the local database — same pattern as the
dpkg source, which also reads plain files rather than invoking a package
manager.

## The resolver interface

`packages/sensors/src/osquery/linuxConfig.ts`:

```ts
export const OSQUERYD_CANDIDATES = [
  '/opt/osquery/bin/osqueryd', // pkg.osquery.io deb/rpm layout
  '/usr/bin/osqueryd', // distro packages (Arch extra, future rpm targets)
  '/usr/local/bin/osqueryd', // manual installs
] as const;

export function resolveOsqueryd(
  candidates: readonly string[] = OSQUERYD_CANDIDATES,
  exists: (p: string) => boolean = existsSync,
): string | undefined;
```

Contract: ordered, first existing path wins; `undefined` means not installed;
`exists` is injectable so tests need no real filesystem. Consumers:

- `packages/helper/src/system.ts` — `LINUX_BINARIES.osqueryd` resolves through
  the shared list (the daemon's installed-probe).
- `apps/desktop/src/main/onboarding/checks.ts` — the app's osquery check uses
  the same resolver instead of its own two-path list.
- `apps/desktop/src/main/sensor-health.ts` — the health check replaces its
  hardcoded path list with the resolver.

`ensureLinuxOsquery` keeps writing config to `/etc/osquery` regardless of
which binary was found — only the binary lookup changed. The 0600 socket and
staged digest-verified installs are untouched; nothing here widens the
helper's privileges.

## The pacman trust source

`pacmanSource(dbDir = PACMAN_DB_DIR)` in `packages/sensors/src/linux/packages.ts`
joins `linuxPackageIndex()` alongside dpkg and rpm. It reads pacman's local
files database at `/var/lib/pacman/local` — one directory per package named
`<name>-<version>-<release>`, each with a `files` file whose `%FILES%`
section lists the package's paths (per `alpm-db-files(5)`; pacman ≥ 6.1's
files format — no `pacman` binary invoked). Parsing rules that the fixture
tests pin down:

- The package name is everything before the final `-<version>-<release>`:
  names may contain hyphens (`linux-api-headers`).
- Versions may carry an epoch prefix containing a colon (`1:24.2.3-1`) — the
  epoch has no hyphen, so splitting on the last two hyphens is safe.
- Directories that don't match the name-version-release shape (and `%BACKUP%`
  paths, which are config files, not owned binaries) contribute nothing.
- Owner ids are `pkg:pacman`; a missing database yields an empty source, not
  an error — `linuxPackageIndex` already skips sources whose database is
  absent, so non-Arch systems are unaffected.

AUR packages installed through pacman (`pacman -U`, directly or via a helper)
are registered in the same database, so they read trusted — that is the
truthful signal, not a promotion of AUR safety.

## The arch bucket contract

`linuxDistro()` gains `'arch'`: `ID`/`ID_LIKE` containing `arch` or
`archarm` (checked after debian and fedora, so nothing reparents). For
`'arch'`, `linuxProtection()` emits:

1. **fapolicyd step** — the allow-all rule and the load/restart command as on
   every family (exact shared constants `FAPOLICYD_ALLOW_RULES` and
   `FAPOLICYD_START`), but **no install command** and copy that names the
   truth: fapolicyd ships through the AUR only, and until it's installed
   Vigil can watch but not block.
2. **osquery step** — one command, `sudo pacman -S --needed osquery`, from
   the official `extra` repository; no key or repo setup. The step's
   done-check names all three candidate paths.
3. **Desktop services step** — optional (`optional: true`, manual entries,
   no commands, no Vigil check), naming the four prerequisites: a polkit
   agent (`hyprpolkitagent`), a tray-capable bar (waybar's tray module), a
   notification daemon (`mako`), XWayland (`xorg-xwayland`). Omarchy bundles
   all four; a hand-rolled Hyprland does not. Optional so it never holds up
   finishing setup, and placed last so the protection steps' established
   order (`fapolicyd`, `osquery`, `helper`) is unchanged for every distro.
4. **helper step** — unchanged, distro-agnostic.

Guarantees the contract pins (tested): the first three protection step ids
stay `['fapolicyd', 'osquery', 'helper']` for every distro including arch;
no `brew` or Santa steps appear on Linux; arch's fapolicyd copy mentions the
AUR and never claims the package "comes with your distribution".

## Acceptance criteria

From the spec's D4 row, each observable:

- **Resolver:** unit tests cover candidate order and preference, the
  missing-everything case, and an injected `exists` probe; helper, app
  checks, and sensor health consume the shared resolver — no call site
  hard-codes `/opt`.
- **Pacman trust:** the source is tested against a fixture database (names
  with hyphens and epochs, `%FILES%`/`%BACKUP%` sections, stray directories,
  missing database); `PackageIndex.trust` returns `pkg:pacman` ownership for
  pacman-owned paths on a fixture, and the wiring lands in
  `linuxPackageIndex()`.
- **Arch bucket:** `linuxDistro()` arch cases (plain `arch`, `archarm`,
  `ID_LIKE=arch` relatives, empty file) and the plan contract above;
  `pnpm check` green.
- **Docs:** `docs/arch-omarchy.md` exists, states plainly that Arch is not
  CI-validated, points at the validation routine (`scripts/validate-linux.sh`,
  the companion D2 change) as the manual path, and quotes the fapolicyd
  commands byte-identically to the wizard constants; README's Linux section
  links it.

Follow-ups this deliberately does not take: an rpm package target, AppImage
runtime CI, AUR automation, and any CI job for Arch (spec: Omarchy stays
outside the CI validation matrix).
