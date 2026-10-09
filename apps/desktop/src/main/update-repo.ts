/**
 * Which GitHub repo a build checks for updates, decided at build time
 * (electron.vite.config.ts imports this): releases live in one repo, and a
 * fork must not surface upstream releases as updates for it (audit INFO-2).
 */

/** The upstream repo, the default update source. */
export const UPSTREAM_REPO = 'ShmalexM/Vigil-at-Home';

/** The owner/repo a git remote URL points at on github.com, or undefined. */
export function repoFromRemoteUrl(url: string): string | undefined {
  const clean = url.trim().replace(/\/+$/, '');
  const m = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i.exec(clean);
  return m ? `${m[1]}/${m[2]}` : undefined;
}

/**
 * The update source for this build: an explicit VIGIL_UPDATE_REPO wins; an
 * upstream checkout — and a build without git, e.g. a source tarball — checks
 * upstream; a fork checkout ships with update checks off. A malformed override
 * fails the build rather than silently pointing checks nowhere or upstream.
 */
export function resolveUpdateRepo(
  override: string | undefined,
  originUrl: string | undefined,
): string | undefined {
  const wanted = override?.trim();
  if (wanted) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(wanted)) {
      throw new Error(`VIGIL_UPDATE_REPO must name a repo as owner/repo, got "${override}"`);
    }
    return wanted.toLowerCase() === UPSTREAM_REPO.toLowerCase() ? UPSTREAM_REPO : wanted;
  }
  const origin = originUrl ? repoFromRemoteUrl(originUrl) : undefined;
  return !origin || origin.toLowerCase() === UPSTREAM_REPO.toLowerCase()
    ? UPSTREAM_REPO
    : undefined;
}
