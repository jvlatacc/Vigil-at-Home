import { describe, expect, it } from 'vitest';
import { repoFromRemoteUrl, resolveUpdateRepo, UPSTREAM_REPO } from './update-repo.js';

describe('repoFromRemoteUrl', () => {
  it('reads owner/repo out of the git remote spellings', () => {
    expect(repoFromRemoteUrl('https://github.com/ShmalexM/Vigil-at-Home.git')).toBe(UPSTREAM_REPO);
    expect(repoFromRemoteUrl('git@github.com:ShmalexM/Vigil-at-Home.git')).toBe(UPSTREAM_REPO);
    expect(repoFromRemoteUrl('ssh://git@github.com/ShmalexM/Vigil-at-Home')).toBe(UPSTREAM_REPO);
    expect(repoFromRemoteUrl('https://github.com/jvlatacc/Vigil-at-Home.git')).toBe(
      'jvlatacc/Vigil-at-Home',
    );
  });

  it('says nothing about remotes that are not this host', () => {
    expect(repoFromRemoteUrl('https://gitlab.com/owner/repo.git')).toBeUndefined();
    expect(repoFromRemoteUrl('https://github.com/owner/repo/extra')).toBeUndefined();
    expect(repoFromRemoteUrl('not a remote')).toBeUndefined();
  });
});

describe('resolveUpdateRepo', () => {
  it('derives upstream from the origin, and a fork ships with checks off', () => {
    expect(resolveUpdateRepo(undefined, 'https://github.com/ShmalexM/Vigil-at-Home.git')).toBe(
      UPSTREAM_REPO,
    );
    expect(resolveUpdateRepo(undefined, 'git@github.com:shmalexm/vigil-at-home.git')).toBe(
      UPSTREAM_REPO,
    );
    // The fork this repository actually lives in.
    expect(
      resolveUpdateRepo(undefined, 'https://github.com/jvlatacc/Vigil-at-Home.git'),
    ).toBeUndefined();
    // No git (a source tarball build) defaults to upstream.
    expect(resolveUpdateRepo(undefined, undefined)).toBe(UPSTREAM_REPO);
  });

  it('lets the build name its own update source, and refuses a malformed one', () => {
    expect(
      resolveUpdateRepo('jvlatacc/Vigil-at-Home', 'https://github.com/ShmalexM/Vigil-at-Home.git'),
    ).toBe('jvlatacc/Vigil-at-Home');
    expect(resolveUpdateRepo('  someone/else  ', undefined)).toBe('someone/else');
    expect(() => resolveUpdateRepo('not-a-repo', undefined)).toThrow(/owner\/repo/);
  });
});
