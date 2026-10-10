import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { UPSTREAM_REPO } from './update-repo.js';
import { compareVersions, isLinuxPackage, newest, releasesUrl, UpdateChecker } from './updates.js';

const release = (tag: string, o: { draft?: boolean; prerelease?: boolean } = {}) => ({
  tag_name: `v${tag}`,
  html_url: `https://github.com/ShmalexM/Vigil-at-Home/releases/tag/v${tag}`,
  draft: o.draft ?? false,
  prerelease: o.prerelease ?? tag.includes('-'),
  published_at: '2026-09-28T22:00:00Z',
  assets: ['arm64', 'x64'].map((arch) => ({
    name: `Vigil-at-Home-${tag}-${arch}.dmg`,
    browser_download_url: `https://github.com/ShmalexM/Vigil-at-Home/releases/download/v${tag}/Vigil-at-Home-${tag}-${arch}.dmg`,
  })),
});

describe('compareVersions', () => {
  it('orders releases and pre-releases', () => {
    const sorted = ['0.1.0', '0.1.0-alpha.10', '0.1.0-alpha.2', '0.2.0', '0.1.0-beta.1'].sort(
      compareVersions,
    );
    expect(sorted).toEqual(['0.1.0-alpha.2', '0.1.0-alpha.10', '0.1.0-beta.1', '0.1.0', '0.2.0']);
  });
});

describe('newest', () => {
  it('picks the newest published release and the DMG for this chip', () => {
    const a = newest(
      [
        release('0.1.0-alpha.3'),
        release('0.1.0-alpha.5', { draft: true }),
        release('0.1.0-alpha.4'),
      ],
      '0.1.0-alpha.2',
      'arm64',
      UPSTREAM_REPO,
    );
    expect(a?.version).toBe('0.1.0-alpha.4');
    expect(a?.downloadUrl).toMatch(/-arm64\.dmg$/);
    expect(
      newest([release('0.1.0-alpha.3')], '0.1.0-alpha.2', 'x64', UPSTREAM_REPO)?.downloadUrl,
    ).toMatch(/-x64\.dmg$/);
  });

  it('says nothing when this is the newest, and skips pre-releases on a full release', () => {
    expect(
      newest([release('0.1.0-alpha.2')], '0.1.0-alpha.2', 'arm64', UPSTREAM_REPO),
    ).toBeUndefined();
    expect(
      newest([release('0.2.0-alpha.1'), release('0.1.0')], '0.1.0', 'arm64', UPSTREAM_REPO),
    ).toBeUndefined();
    expect(newest([release('0.1.1')], '0.1.0', 'arm64', UPSTREAM_REPO)?.version).toBe('0.1.1');
  });

  it('offers pre-releases to a full-release build while no full release is published', () => {
    // What GitHub lists today: alpha.1 tagged without the v and no assets, and alpha.3.
    const list = [
      release('0.1.0-alpha.3'),
      { ...release('0.1.0-alpha.1'), tag_name: '0.1.0-alpha.1', assets: [] },
    ];
    expect(newest(list, '0.0.1', 'arm64', UPSTREAM_REPO)).toMatchObject({
      version: '0.1.0-alpha.3',
      downloadUrl: expect.stringMatching(/0\.1\.0-alpha\.3-arm64\.dmg$/),
    });
    // A published full release ends that: pre-releases stay hidden on 0.0.1 again.
    expect(newest([...list, release('0.0.2')], '0.0.1', 'arm64', UPSTREAM_REPO)?.version).toBe(
      '0.0.2',
    );
  });

  it('ignores links that are not github.com', () => {
    const r = release('0.1.0-alpha.3');
    r.assets[0]!.browser_download_url = 'https://example.com/Vigil-at-Home-0.1.0-alpha.3-arm64.dmg';
    expect(newest([r], '0.1.0-alpha.2', 'arm64', UPSTREAM_REPO)?.downloadUrl).toBeUndefined();
    expect(
      newest([{ ...r, html_url: 'https://evil.test/x' }], '0.1.0-alpha.2', 'arm64', UPSTREAM_REPO),
    ).toBeUndefined();
  });

  it('ignores github.com links outside this repo', () => {
    const r = release('0.1.0-alpha.3');
    r.assets[0]!.browser_download_url = r.assets[0]!.browser_download_url.replace(
      'ShmalexM/Vigil-at-Home',
      'someone/else',
    );
    expect(newest([r], '0.1.0-alpha.2', 'arm64', UPSTREAM_REPO)?.downloadUrl).toBeUndefined();
    const other = { ...r, html_url: 'https://github.com/someone/else/releases/tag/v0.1.0-alpha.3' };
    expect(newest([other], '0.1.0-alpha.2', 'arm64', UPSTREAM_REPO)).toBeUndefined();
    // GitHub owner and repo names are not case-sensitive.
    const lower = { ...release('0.1.0-alpha.3') };
    lower.html_url = lower.html_url.replace('ShmalexM/Vigil-at-Home', 'shmalexm/vigil-at-home');
    expect(newest([lower], '0.1.0-alpha.2', 'arm64', UPSTREAM_REPO)?.version).toBe('0.1.0-alpha.3');
  });

  it('accepts links of the configured repo only', () => {
    const fork = 'jvlatacc/Vigil-at-Home';
    const r = release('0.1.0-alpha.3');
    const forked = {
      ...r,
      html_url: r.html_url.replace(UPSTREAM_REPO, fork),
      assets: r.assets.map((a) => ({
        ...a,
        browser_download_url: a.browser_download_url.replace(UPSTREAM_REPO, fork),
      })),
    };
    // A fork that names its own repo as the update source gets its own releases.
    expect(newest([forked], '0.1.0-alpha.2', 'arm64', fork)?.version).toBe('0.1.0-alpha.3');
    // The same links are strangers to upstream.
    expect(newest([forked], '0.1.0-alpha.2', 'arm64', UPSTREAM_REPO)).toBeUndefined();
  });
});

describe('UpdateChecker', () => {
  function checker(body: unknown, ok = true, repo: string | null = UPSTREAM_REPO) {
    let saved: unknown = {};
    const opened: string[] = [];
    const found: string[] = [];
    const fetched: string[] = [];
    const c = new UpdateChecker({
      current: '0.1.0-alpha.2',
      arch: 'arm64',
      repo,
      load: () => saved,
      save: (s) => void (saved = s),
      fetch: (async (url: string | URL) => {
        fetched.push(String(url));
        return { ok, status: ok ? 200 : 403, json: async () => body };
      }) as never,
      openExternal: async (u) => void opened.push(u),
      onFound: (v) => found.push(v),
      now: () => 1000,
    });
    return { c, opened, found, fetched };
  }

  it('asks the build’s repo for its published releases', async () => {
    const { c, fetched } = checker([release('0.1.0-alpha.3')]);
    await c.check();
    expect(fetched).toEqual([releasesUrl(UPSTREAM_REPO)]);
  });

  it('finds an update, tells once, downloads the DMG, and remembers Later', async () => {
    const { c, opened, found } = checker([release('0.1.0-alpha.3')]);
    const v = await c.check();
    expect(v.available?.version).toBe('0.1.0-alpha.3');
    expect(v.dismissed).toBe(false);
    await c.check();
    expect(found).toEqual(['0.1.0-alpha.3']);
    await c.download();
    expect(opened[0]).toMatch(/0\.1\.0-alpha\.3-arm64\.dmg$/);
    c.dismiss();
    expect(c.view().dismissed).toBe(true);
    c.setAuto(false);
    expect(c.view()).toMatchObject({ auto: false, dismissed: true });
  });

  it('opens the release page for What’s new', async () => {
    const { c, opened } = checker([release('0.1.0-alpha.3')]);
    await c.openNotes();
    expect(opened).toEqual([]);
    await c.check();
    await c.openNotes();
    expect(opened[0]).toMatch(/\/releases\/tag\/v0\.1\.0-alpha\.3$/);
  });

  it('reports a failed check in words', async () => {
    const { c } = checker(null, false);
    expect((await c.check()).error).toMatch(/403/);
  });

  it('checks nothing in a fork build: no fetch, no error, no timers', async () => {
    const { c, fetched, found } = checker([release('0.1.0-alpha.3')], true, null);
    const v = await c.check();
    expect(v.available).toBeUndefined();
    expect(v.error).toBeUndefined();
    expect(v.lastCheckedAt).toBeUndefined();
    expect(found).toEqual([]);
    expect(fetched).toEqual([]);
    vi.useFakeTimers();
    try {
      c.start();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('schedules the automatic checks for an upstream build', () => {
    vi.useFakeTimers();
    try {
      const { c } = checker([]);
      c.start();
      expect(vi.getTimerCount()).toBe(2);
      c.stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('newest on Linux', () => {
  const withLinux = (tag: string) => {
    const r = release(tag);
    r.assets.push(
      ...['amd64.deb', 'x86_64.AppImage'].map((suffix) => ({
        name: `Vigil-at-Home-${tag}-${suffix}`,
        browser_download_url: `https://github.com/ShmalexM/Vigil-at-Home/releases/download/v${tag}/Vigil-at-Home-${tag}-${suffix}`,
      })),
    );
    return r;
  };

  it('only counts a release with a package for this chip', () => {
    expect(
      newest([release('0.1.0-alpha.3')], '0.1.0-alpha.2', 'x64', UPSTREAM_REPO, 'linux'),
    ).toBeUndefined();
    expect(
      newest([withLinux('0.1.0-alpha.3')], '0.1.0-alpha.2', 'arm64', UPSTREAM_REPO, 'linux'),
    ).toBeUndefined();
    // A newer Mac-only release doesn't hide the newest one Linux can install.
    expect(
      newest(
        [release('0.1.0-alpha.4'), withLinux('0.1.0-alpha.3')],
        '0.1.0-alpha.2',
        'x64',
        UPSTREAM_REPO,
        'linux',
      )?.version,
    ).toBe('0.1.0-alpha.3');
    expect(isLinuxPackage('Vigil-at-Home-1.0.0-arm64.AppImage', 'arm64')).toBe(true);
    expect(isLinuxPackage('Vigil-at-Home-1.0.0-x64.dmg', 'x64')).toBe(false);
  });

  it('never offers a Mac DMG to an x64 Linux machine: the release page opens instead', () => {
    const a = newest([withLinux('0.1.0-alpha.3')], '0.1.0-alpha.2', 'x64', UPSTREAM_REPO, 'linux');
    expect(a?.version).toBe('0.1.0-alpha.3');
    expect(a?.downloadUrl).toBeUndefined();
    expect(a?.notesUrl).toMatch(/^https:\/\/github\.com\//);
  });
});
describe('UpdateChecker verifies release signatures (REL-01)', () => {
  const tag = '0.1.0-alpha.3';
  const base = `https://github.com/ShmalexM/Vigil-at-Home/releases/download/v${tag}`;
  const sumsBody = `9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08  Vigil-at-Home-${tag}-arm64.dmg\n`;

  const ed25519Pair = () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    return {
      privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    };
  };

  const minisigFor = (data: string, privatePem: string) => {
    const sig = sign(null, Buffer.from(data, 'utf8'), createPrivateKey(privatePem));
    return `untrusted comment: Vigil at Home release signature\n${sig.toString('base64')}\n`;
  };

  /**
   * A checker whose fetch serves the releases list plus checksum assets from
   * a map. `withMinisig: false` makes an unsigned release (sums or not).
   */
  async function checkWith(
    files: Record<string, { ok?: boolean; status?: number; body: string }>,
    options: { signingPublicKey?: string; withMinisig?: boolean; minisigUrl?: string } = {},
  ) {
    const r = release(tag);
    r.assets.push(
      { name: 'SHA256SUMS.txt', browser_download_url: `${base}/SHA256SUMS.txt` },
      ...(options.withMinisig === false
        ? []
        : [
            {
              name: 'SHA256SUMS.txt.minisig',
              browser_download_url: options.minisigUrl ?? `${base}/SHA256SUMS.txt.minisig`,
            },
          ]),
    );
    let saved: unknown = {};
    const opened: string[] = [];
    const found: string[] = [];
    const warnings: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((...parts: unknown[]) => {
      warnings.push(parts.map(String).join(' '));
    });
    try {
      const c = new UpdateChecker({
        current: '0.1.0-alpha.2',
        arch: 'arm64',
        repo: UPSTREAM_REPO,
        load: () => saved,
        save: (s) => void (saved = s),
        fetch: (async (url: string | URL) => {
          const u = String(url);
          if (new URL(u).hostname === 'api.github.com') {
            return { ok: true, status: 200, json: async () => [r] } as never;
          }
          const f = files[u];
          if (!f) return { ok: false, status: 404, text: async () => '' } as never;
          return { ok: f.ok ?? true, status: f.status ?? 200, text: async () => f.body } as never;
        }) as never,
        openExternal: async (u) => void opened.push(u),
        onFound: (v) => found.push(v),
        now: () => 1000,
        ...(options.signingPublicKey !== undefined
          ? { signingPublicKey: options.signingPublicKey }
          : {}),
      });
      const view = await c.check();
      return { c, view, opened, found, warnings };
    } finally {
      warn.mockRestore();
    }
  }

  it('offers a signed release whose checksums verify', async () => {
    const kp = ed25519Pair();
    const { view, found, warnings } = await checkWith(
      {
        [`${base}/SHA256SUMS.txt`]: { body: sumsBody },
        [`${base}/SHA256SUMS.txt.minisig`]: { body: minisigFor(sumsBody, kp.privatePem) },
      },
      { signingPublicKey: kp.publicPem },
    );
    expect(view.available?.version).toBe(tag);
    expect(view.error).toBeUndefined();
    expect(found).toEqual([tag]);
    expect(warnings).toEqual([]);
  });

  it('pairs the committed release key with the dogfood key without options', async () => {
    // Signs with scripts/release/dogfood-signing-key.b64; the checker falls
    // back to the committed RELEASE_SIGNING_PUBLIC_KEY.
    const b64 = readFileSync(
      new URL('../../../../scripts/release/dogfood-signing-key.b64', import.meta.url),
      'utf8',
    ).trim();
    const pem = `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
    const { view, warnings } = await checkWith({
      [`${base}/SHA256SUMS.txt`]: { body: sumsBody },
      [`${base}/SHA256SUMS.txt.minisig`]: { body: minisigFor(sumsBody, pem) },
    });
    expect(view.available?.version).toBe(tag);
    expect(warnings).toEqual([]);
  });

  it('does not offer a release whose signature fails (tampered sums)', async () => {
    const kp = ed25519Pair();
    // Signed over different bytes than the sums that ship.
    const tampered = minisigFor(`${sumsBody}deadbeef  extra.bin\n`, kp.privatePem);
    const { c, view, found, opened } = await checkWith(
      {
        [`${base}/SHA256SUMS.txt`]: { body: sumsBody },
        [`${base}/SHA256SUMS.txt.minisig`]: { body: tampered },
      },
      { signingPublicKey: kp.publicPem },
    );
    expect(view.available).toBeUndefined();
    expect(view.error).toMatch(/does not verify/);
    expect(found).toEqual([]);
    await c.download();
    expect(opened).toEqual([]);
  });

  it('fails closed when the checksums cannot be downloaded for verification', async () => {
    const kp = ed25519Pair();
    const { view } = await checkWith(
      {
        [`${base}/SHA256SUMS.txt`]: { ok: false, status: 404, body: '' },
        [`${base}/SHA256SUMS.txt.minisig`]: { body: minisigFor(sumsBody, kp.privatePem) },
      },
      { signingPublicKey: kp.publicPem },
    );
    expect(view.available).toBeUndefined();
    expect(view.error).toMatch(/answered 404/);
  });

  it('refuses signature assets that do not come from the allowlisted URL', async () => {
    // No files at all: an evil URL must never even be fetched.
    const { view, warnings } = await checkWith(
      {},
      {
        signingPublicKey: ed25519Pair().publicPem,
        minisigUrl: 'https://evil.test/SHA256SUMS.txt.minisig',
      },
    );
    expect(view.available).toBeUndefined();
    expect(view.error).toMatch(/allowlisted/);
    expect(warnings.join('\n')).toMatch(/allowlisted/);
  });

  it('refuses a release that has a signature but no checksums to verify', async () => {
    const kp = ed25519Pair();
    // Build the release by hand: minisig present, sums missing.
    let captured: { view: ReturnType<UpdateChecker['view']> } | undefined;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const r = release(tag);
      r.assets.push({
        name: 'SHA256SUMS.txt.minisig',
        browser_download_url: `${base}/SHA256SUMS.txt.minisig`,
      });
      const c = new UpdateChecker({
        current: '0.1.0-alpha.2',
        arch: 'arm64',
        repo: UPSTREAM_REPO,
        load: () => ({}),
        save: () => {},
        fetch: (async () => ({
          ok: true,
          status: 200,
          json: async () => [r],
          text: async () => '',
        })) as never,
        openExternal: async () => {},
        signingPublicKey: kp.publicPem,
      });
      captured = { view: await c.check() };
    } finally {
      warn.mockRestore();
    }
    expect(captured!.view.available).toBeUndefined();
    expect(captured!.view.error).toMatch(/no SHA256SUMS\.txt/);
  });

  it('still offers an unsigned release, with a logged warning (fail-open)', async () => {
    const { view, found, warnings } = await checkWith(
      { [`${base}/SHA256SUMS.txt`]: { body: sumsBody } },
      { withMinisig: false },
    );
    expect(view.available?.version).toBe(tag);
    expect(found).toEqual([tag]);
    expect(warnings.join('\n')).toMatch(/no SHA256SUMS\.txt\.minisig/);
  });
});
