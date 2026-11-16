import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DISCOVER_NOTIFIER } from './notification-command.js';

test('macOS notifier discovery resolves optional links back into their application bundle', { skip: process.platform !== 'darwin' }, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'health-watch notifier ')));
  try {
    const data = join(root, '.local/share/herdr-health-watch');
    const bundle = join(root, 'Helper App.app/Contents/MacOS');
    mkdirSync(data, { recursive: true });
    mkdirSync(bundle, { recursive: true });
    const native = join(bundle, 'terminal-notifier');
    writeFileSync(native, '#!/bin/sh\nexit 99\n', { mode: 0o755 });
    symlinkSync(native, join(data, 'relative-target'));
    symlinkSync('relative-target', join(data, 'terminal-notifier'));
    const result = spawnSync('/bin/sh', ['-c', DISCOVER_NOTIFIER], { env: { HOME: root, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const [os, executable] = result.stdout.split('\n');
    assert.equal(os, 'Darwin');
    assert.equal(executable, native);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
