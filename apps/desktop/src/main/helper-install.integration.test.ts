import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { helperDigest, helperMatch, helperScriptFiles } from './helper-install.js';

// Installs the real helper with the Linux install.sh, as root, under systemd,
// then removes it. Runs in CI's linux job (sudo, VIGIL_LINUX_INTEGRATION=1).
const enabled =
  process.platform === 'linux' &&
  process.env['VIGIL_LINUX_INTEGRATION'] === '1' &&
  process.getuid?.() === 0 &&
  spawnSync('systemctl', ['is-system-running']).stdout?.toString().trim() !== 'offline';

const app = join(import.meta.dirname, '..', '..');
const dev = join(app, 'build', 'helper', `dev-${process.arch}`);
const sh = (script: string) =>
  spawnSync('/bin/sh', [join(dev, 'linux', script)], { encoding: 'utf8' });

describe.skipIf(!enabled)('Linux helper install', () => {
  it(
    'installs a root systemd service with its polkit policy, then removes it all',
    () => {
      execFileSync(process.execPath, [join(app, 'scripts', 'build-helper.mjs'), '--dev'], {
        cwd: app,
        stdio: 'inherit',
      });

      const install = sh('install.sh');
      expect(install.status, install.stderr).toBe(0);
      expect(install.stdout).toContain('Vigil helper installed and running.');
      expect(existsSync('/run/vigil-helper.sock')).toBe(true);
      expect(spawnSync('systemctl', ['is-active', '--quiet', 'vigil-helper.service']).status).toBe(
        0,
      );
      expect(spawnSync('systemctl', ['is-enabled', '--quiet', 'vigil-helper.service']).status).toBe(
        0,
      );
      expect(existsSync('/usr/share/polkit-1/actions/com.vigilathome.helper.policy')).toBe(true);
      // The launcher that pkexec runs for the Vigil-named install action.
      expect(existsSync('/usr/libexec/vigil-helper-launcher')).toBe(true);
      expect(
        readFileSync('/usr/share/polkit-1/actions/com.vigilathome.helper.policy', 'utf8'),
      ).toContain('com.vigilathome.helper.install');
      // The launcher runs the installed node and helper.
      const approve = spawnSync('/usr/libexec/vigil-helper', ['approve', 'a'.repeat(32)]);
      expect(approve.status).toBe(0);

      // The app sees that the installed helper is the one it ships.
      expect(helperMatch(dev, 'linux').installed).toBe('current');
      // An updated app carrying a different helper sees the installed one as outdated.
      const newer = mkdtempSync(join(tmpdir(), 'vigil-newer-'));
      cpSync(dev, newer, { recursive: true });
      writeFileSync(join(newer, 'helper.mjs'), '// a newer helper\n', { flag: 'a' });
      expect(helperMatch(newer, 'linux').installed).toBe('outdated');

      // Installing again replaces the running copy.
      expect(sh('install.sh').status).toBe(0);

      // The launcher re-verifies the staged files as root before anything is
      // run: a stage built the way the app stages installs cleanly, and a
      // tampered one is refused with nothing changed.
      const files = helperScriptFiles('install', 'linux');
      const stage = mkdtempSync(join(tmpdir(), 'vigil-launcher-'));
      cpSync(dev, stage, { recursive: true });
      const digest = helperDigest(dev, files);
      const argv = (from: string) => [
        '/usr/libexec/vigil-helper-launcher',
        from,
        files[0]!,
        digest,
        '',
        ...files,
      ];
      const launched = spawnSync(argv(stage)[0]!, argv(stage).slice(1), { encoding: 'utf8' });
      expect(launched.status, launched.stderr).toBe(0);
      writeFileSync(join(stage, 'linux', 'install.sh'), '# tampered\n', { flag: 'a' });
      const tampered = spawnSync(argv(stage)[0]!, argv(stage).slice(1), { encoding: 'utf8' });
      expect(tampered.status).not.toBe(0);
      expect(tampered.stderr).toContain('changed while installing');
      expect(spawnSync('systemctl', ['is-active', '--quiet', 'vigil-helper.service']).status).toBe(
        0,
      );

      const remove = sh('uninstall.sh');
      expect(remove.status).toBe(0);
      expect(existsSync('/usr/libexec/vigil-helper')).toBe(false);
      expect(existsSync('/usr/libexec/vigil-helper.d')).toBe(false);
      expect(existsSync('/usr/libexec/vigil-helper-launcher')).toBe(false);
      expect(existsSync('/etc/systemd/system/vigil-helper.service')).toBe(false);
      expect(existsSync('/usr/share/polkit-1/actions/com.vigilathome.helper.policy')).toBe(false);
      expect(
        spawnSync('systemctl', ['is-active', '--quiet', 'vigil-helper.service']).status,
      ).not.toBe(0);
    },
    5 * 60_000,
  );
});
