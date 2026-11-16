import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProbe, parseProcesses } from './probe.js';
const data = { host: 'test', os: 'darwin', cores: 10, memTotal: 64 * 1024 ** 3, mem: 95, cpu: 21.5, warming: false,
  disks: [{ mount: '/System/Volumes/Data', pct: 85.3, size: 994662584320, used: 827351711744 }] };
const response = (raw = data, pressure = '1', swap = 'total = 1024.00M used = 256.00M free = 768.00M', df = '/dev/disk3s5 971350180 807960656 138735496 86% /System/Volumes/Data') =>
  `__VITALS__\n${JSON.stringify(raw)}\n__PRESSURE__\n${pressure}\n__SWAP__\n${swap}\n__DISKS__\nFilesystem 1024-blocks Used Available Capacity Mounted on\n${df}\n__PROCESSES__\n`;
test('macOS pressure stays normal at high memory use; free disk uses df available, not size minus used', () => {
  const s = parseProbe(response(), 1000, 15);
  assert.equal(s.pressure, 'normal'); assert.equal(s.memoryPct, 95);
  assert.equal(s.swapUsedBytes, 256 * 1024 ** 2);
  assert.equal(s.disks[0].freeBytes, 138735496 * 1024);
  assert.notEqual(s.disks[0].freeBytes, data.disks[0].size - data.disks[0].used);
});
test('missing pressure, disk, truncated output or invalid metric fails closed', () => {
  assert.throws(() => parseProbe(response(data, ''), 1000, 1));
  assert.throws(() => parseProbe(response(data, '1', 'used = 0.00M', ''), 1000, 1));
  assert.throws(() => parseProbe(response().slice(0, -18), 1000, 1));
  assert.throws(() => parseProbe(response({ ...data, cpu: null }), 1000, 1));
});
test('Linux warmup CPU is unknown and swap is measured in bytes', () => {
  const s = parseProbe(response({ ...data, os: 'linux', warming: true }, 'none', 'SwapTotal: 1048576 kB\nSwapFree: 524288 kB'), 1000, 1);
  assert.equal(s.cpu, null); assert.equal(s.pressure, null); assert.equal(s.swapUsedBytes, 512 * 1024 ** 2);
});
test('processes normalize CPU to whole machine and preserve executable names with spaces', () => {
  const p = parseProcesses(' 12 180.5 4096 /Applications/Example App.app/Contents/MacOS/Example App\n 13 0.0 12 /usr/bin/sh\n', 10);
  assert.equal(p[0].name, 'Example App'); assert.equal(p[0].cpu, 18.05); assert.equal(p[0].memoryBytes, 4194304);
});
