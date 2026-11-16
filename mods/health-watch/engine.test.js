import test from 'node:test';
import assert from 'node:assert/strict';
import { advance, defaultConfig, initialState, isExcluded, normalizeConfig } from './engine.js';

const BASE = 1_700_000_000_000;
const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const at = (seconds) => BASE + seconds * 1000;
const disk = (mount = '/', pct = 40, freeGiB = 100) => ({ mount, pct, freeBytes: freeGiB * GiB });
const process = (name, cpu, pid = 1) => ({ name, cpu, pid, memoryBytes: MiB });
const sample = (seconds, patch = {}) => ({
  at: at(seconds), os: 'darwin', host: 'test-host', cpu: 10, memoryPct: 50,
  pressure: 'normal', swapUsedBytes: 0, disks: [disk()], processes: [], collectionMs: 12,
  ...patch,
});
const quickConfig = (patch = {}) => normalizeConfig({
  ...patch,
  thresholds: {
    cpuHoldSec: 20, memoryHoldSec: 20, swapHoldSec: 20,
    diskHoldSec: 20, recoverySec: 20, processCpuHoldSec: 20,
    ...patch.thresholds,
  },
});
function harness(config = quickConfig(), machine = 'local') {
  return {
    state: initialState(), config, events: [],
    tick(seconds, patch = {}, options = {}) {
      const output = advance(this.state, this.config, { machine, sample: sample(seconds, patch) }, at(options.now ?? seconds));
      this.state = output.state;
      this.events.push(...output.events);
      return output.events;
    },
    fail(seconds, error = 'offline') {
      const output = advance(this.state, this.config, { machine, error }, at(seconds));
      this.state = output.state;
      this.events.push(...output.events);
      return output.events;
    },
    alerts(rule) {
      return Object.values(this.state.machines[machine]?.alerts ?? {}).filter((alert) => !rule || alert.rule === rule);
    },
    reload() { this.state = JSON.parse(JSON.stringify(this.state)); },
  };
}
const exclusion = (patch = {}) => ({ id: 'test-exclusion', machine: 'local', rule: 'cpu', resource: '', until: 0, reason: '개발 작업', ...patch });
const freeze = (value) => {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
};

test('defaults are fresh and the initial public state is empty', () => {
  const a = defaultConfig();
  const b = defaultConfig();
  a.targets.push('remote');
  a.thresholds.cpuWarn = 99;
  a.exclusions.push(exclusion());
  assert.deepEqual(b.targets, ['local']);
  assert.equal(b.thresholds.cpuWarn, 90);
  assert.deepEqual(b.exclusions, []);
  assert.deepEqual(initialState(), { machines: {}, history: [] });
  assert.deepEqual(normalizeConfig({}), b);
});

test('configuration supplies only missing defaults and copies caller-owned lists', () => {
  const input = { targets: [' local ', 'remote', 'remote'], watchedProcesses: [' node ', 'node'], thresholds: { cpuWarn: 92 }, exclusions: [exclusion()] };
  const normalized = normalizeConfig(input);
  assert.deepEqual(normalized.targets, ['local', 'remote']);
  assert.deepEqual(normalized.watchedProcesses, ['node']);
  assert.equal(normalized.thresholds.cpuWarn, 92);
  assert.equal(normalized.thresholds.cpuClear, 80);
  normalized.exclusions[0].reason = 'changed';
  assert.equal(input.exclusions[0].reason, '개발 작업');
  assert.deepEqual(normalizeConfig({ targets: [] }).targets, []);
});

test('invalid explicit numeric configuration never silently becomes a default', () => {
  for (const value of [null, undefined, '', '90', NaN, Infinity, -1]) {
    assert.throws(() => normalizeConfig({ thresholds: { cpuWarn: value } }), undefined, String(value));
    assert.throws(() => normalizeConfig({ intervalSeconds: value }), undefined, String(value));
  }
  for (const thresholds of [
    { cpuClear: 90 }, { memWarn: 97 }, { diskWarnPct: 97 }, { diskCriticalFreeGiB: 20 },
    { cpuWarn: 101 }, { failures: 1.5 }, { failures: 0 }, { failures: 1001 },
    { memoryHoldSec: -1 }, { recoverySec: 86401 }, { swapGrowthMiBMin: 0 },
  ]) assert.throws(() => normalizeConfig({ thresholds }));
  for (const intervalSeconds of [4, 5.5, 301]) assert.throws(() => normalizeConfig({ intervalSeconds }));
  for (const intervalSeconds of [5, 300]) assert.equal(normalizeConfig({ intervalSeconds }).intervalSeconds, intervalSeconds);
  assert.equal(normalizeConfig({ thresholds: { cpuHoldSec: 0, failures: 1 } }).thresholds.cpuHoldSec, 0);
});

test('invalid structural settings and non-basename process rules are rejected', () => {
  for (const input of [null, [], { thresholds: null }, { desktop: 'yes' }, { recovery: null },
    { targets: 'local' }, { targets: [''] }, { watchedProcesses: ['bin/node'] },
    { watchedProcesses: ['bin\\node'] }, { watchedProcesses: [null] },
    { exclusions: null }, { exclusions: [exclusion({ until: -1 })] },
    { exclusions: [exclusion({ rule: 'unknown' })] }]) assert.throws(() => normalizeConfig(input));
  const inherited = Object.create({ intervalSeconds: -5, thresholds: { cpuWarn: NaN } });
  assert.equal(normalizeConfig(inherited).intervalSeconds, 10);
});

test('default CPU threshold requires two minutes of uninterrupted evidence', () => {
  const h = harness(defaultConfig());
  for (let time = 0; time < 120; time += 10) {
    assert.deepEqual(h.tick(time, { cpu: 95 }), []);
    assert.equal(h.alerts().length, 0);
  }
  assert.equal(h.tick(120, { cpu: 95 })[0].rule, 'cpu');
  assert.equal(h.alerts('cpu')[0].since, at(0));
  assert.deepEqual(h.tick(130, { cpu: 99 }), []);
});

test('transient CPU spikes and threshold-band samples reset pending confirmation', () => {
  const h = harness();
  h.tick(0, { cpu: 95 });
  h.tick(10, { cpu: 85 });
  h.tick(20, { cpu: 95 });
  h.tick(30, { cpu: 95 });
  assert.equal(h.alerts().length, 0);
  assert.equal(h.tick(40, { cpu: 95 }).length, 1);
});

test('timed rules need distinct observations even with a zero hold', () => {
  const h = harness(quickConfig({ thresholds: { cpuHoldSec: 0 } }));
  assert.deepEqual(h.tick(0, { cpu: 95 }), []);
  assert.deepEqual(h.tick(0, { cpu: 95 }), []);
  assert.equal(h.tick(1, { cpu: 95 }).length, 1);
});

test('warming CPU and missing values break candidates rather than counting as healthy data', () => {
  const h = harness();
  h.tick(0, { cpu: null });
  h.tick(10, { cpu: 95 });
  h.tick(20, { cpu: undefined });
  h.tick(30, { cpu: 95 }); h.tick(40, { cpu: 95 });
  assert.equal(h.alerts('cpu').length, 0);
  assert.equal(h.tick(50, { cpu: 95 })[0].rule, 'cpu');
});

test('gap tolerance follows three configured intervals above the thirty-second floor', () => {
  const h = harness(quickConfig({ intervalSeconds: 20 }));
  h.tick(0, { cpu: 95 });
  assert.equal(h.tick(40, { cpu: 95 })[0].rule, 'cpu');
  const restarted = harness(quickConfig({ intervalSeconds: 20 }));
  restarted.tick(0, { cpu: 95 });
  assert.deepEqual(restarted.tick(61, { cpu: 95 }), []);
  assert.equal(restarted.alerts('cpu').length, 0);
});

test('CPU acknowledgement does not resolve an incident or repeat notifications after reload', () => {
  const h = harness();
  h.tick(0, { cpu: 95 }); h.tick(10, { cpu: 95 }); h.tick(20, { cpu: 95 });
  const alert = h.alerts('cpu')[0];
  alert.acknowledged = true;
  h.reload();
  assert.deepEqual(h.tick(30, { cpu: 95 }), []);
  assert.equal(h.alerts('cpu')[0].acknowledged, true);
  assert.equal(h.state.history.length, 1);
  h.tick(40, { cpu: 10 }); h.tick(50, { cpu: 10 });
  assert.equal(h.alerts('cpu').length, 1);
  assert.equal(h.tick(60, { cpu: 10 })[0].level, 'recovery');
  assert.equal(h.alerts('cpu').length, 0);
});

test('CPU recovery requires cpuClear continuously, not merely below cpuWarn', () => {
  const h = harness();
  for (const time of [0, 10, 20]) h.tick(time, { cpu: 95 });
  h.tick(30, { cpu: 70 });
  h.tick(40, { cpu: 85 });
  h.tick(50, { cpu: 70 }); h.tick(60, { cpu: 70 });
  assert.equal(h.alerts('cpu').length, 1);
  assert.equal(h.tick(70, { cpu: 80 })[0].level, 'recovery');
});

test('macOS memory uses pressure rather than harmless high resident percentage', () => {
  const h = harness();
  for (const time of [0, 10, 20]) h.tick(time, { memoryPct: 99, pressure: 'normal' });
  assert.equal(h.alerts('memory').length, 0);
  for (const time of [30, 40, 50]) h.tick(time, { memoryPct: 30, pressure: 'warning' });
  assert.equal(h.alerts('memory')[0].level, 'warning');
  assert.equal(h.events.filter((event) => event.rule === 'memory').length, 1);
});

test('mixed warning and critical pressure still confirms sustained memory pressure', () => {
  const h = harness();
  h.tick(0, { pressure: 'warning' });
  h.tick(10, { pressure: 'critical' });
  assert.equal(h.tick(20, { pressure: 'warning' })[0].level, 'warning');
  assert.equal(h.alerts('memory')[0].level, 'warning');
});

test('critical escalation is sustained, delivered once, and resets acknowledgement', () => {
  const h = harness();
  for (const time of [0, 10, 20]) h.tick(time, { pressure: 'warning' });
  h.alerts('memory')[0].acknowledged = true;
  assert.deepEqual(h.tick(30, { pressure: 'critical' }), []);
  assert.deepEqual(h.tick(40, { pressure: 'critical' }), []);
  assert.equal(h.tick(50, { pressure: 'critical' })[0].level, 'critical');
  assert.equal(h.alerts('memory')[0].acknowledged, false);
  h.reload();
  assert.deepEqual(h.tick(60, { pressure: 'critical' }), []);
  assert.deepEqual(h.tick(70, { pressure: 'warning' }), []);
  assert.equal(h.alerts('memory')[0].level, 'critical');
  assert.equal(h.state.history.length, 2);
});

test('sustained critical pressure can start directly as critical', () => {
  const h = harness();
  for (const time of [0, 10]) assert.deepEqual(h.tick(time, { pressure: 'critical' }), []);
  assert.equal(h.tick(20, { pressure: 'critical' })[0].level, 'critical');
});

test('Linux memory uses percentage, with an explicit recovery margin', () => {
  const h = harness();
  for (const time of [0, 10, 20]) h.tick(time, { os: 'linux', memoryPct: 98, pressure: 'normal' });
  assert.equal(h.alerts('memory')[0].level, 'critical');
  for (const time of [30, 40, 50]) h.tick(time, { os: 'linux', memoryPct: 89 });
  assert.equal(h.alerts('memory').length, 1);
  for (const time of [60, 70, 80]) h.tick(time, { os: 'linux', memoryPct: 85 });
  assert.equal(h.alerts('memory').length, 0);
  assert.equal(h.events.at(-1).level, 'recovery');
});

test('unknown macOS pressure never falls back to percentage or falsely clears memory', () => {
  const h = harness();
  for (const time of [0, 10, 20]) h.tick(time, { pressure: 'critical' });
  for (const time of [30, 40, 50]) assert.deepEqual(h.tick(time, { pressure: null, memoryPct: 1 }), []);
  assert.equal(h.alerts('memory').length, 1);
});

test('swap alarm needs sustained rapid growth AND memory pressure', () => {
  const h = harness();
  for (const time of [0, 10, 20, 30]) h.tick(time, { swapUsedBytes: time * 10 * MiB });
  assert.equal(h.alerts('swap').length, 0);
  for (const time of [40, 50, 60]) h.tick(time, { pressure: 'warning', swapUsedBytes: time * 10 * MiB });
  assert.equal(h.alerts('swap').length, 1);
  assert.equal(h.events.filter((event) => event.rule === 'swap').length, 1);
});

test('Linux high memory can corroborate swap while macOS normal pressure cannot', () => {
  const h = harness();
  for (const time of [0, 10, 20, 30]) h.tick(time, { os: 'linux', memoryPct: 95, swapUsedBytes: time * 10 * MiB });
  assert.equal(h.alerts('swap').length, 1);
  for (const time of [40, 50, 60]) h.tick(time, { os: 'linux', memoryPct: 50, swapUsedBytes: time * 10 * MiB });
  assert.equal(h.alerts('swap').length, 0);
});

test('stable or decreasing swap recovers only after the recovery duration', () => {
  const h = harness();
  for (const time of [0, 10, 20, 30]) h.tick(time, { pressure: 'warning', swapUsedBytes: time * 10 * MiB });
  h.tick(40, { pressure: 'warning', swapUsedBytes: 300 * MiB });
  h.tick(50, { pressure: 'warning', swapUsedBytes: 200 * MiB });
  assert.equal(h.alerts('swap').length, 1);
  h.tick(60, { pressure: 'warning', swapUsedBytes: 200 * MiB });
  assert.equal(h.alerts('swap').length, 0);
});

test('disk percentage OR absolute free space can independently raise alarms', () => {
  const h = harness();
  for (const time of [0, 10, 20]) h.tick(time, {
    disks: [disk('/large', 91, 1000), disk('/small', 40, 4), disk('/healthy', 50, 100)],
  });
  assert.deepEqual(h.alerts('disk').map((alert) => [alert.resource, alert.level]).sort(), [['/large', 'warning'], ['/small', 'critical']]);
});

test('disk free-space-only and percent-only evidence can raise but cannot recover', () => {
  const h = harness();
  const partial = [{ mount: '/free-only', pct: null, freeBytes: GiB }, { mount: '/pct-only', pct: 99, freeBytes: null }];
  for (const time of [0, 10, 20]) h.tick(time, { disks: partial });
  assert.equal(h.alerts('disk').length, 2);
  for (const time of [30, 40, 50]) h.tick(time, { disks: partial.map((entry) => ({ ...entry, pct: 20 })) });
  assert.equal(h.alerts('disk').length, 2);
});

test('disk recovery requires both measurements and margins, not disappearance', () => {
  const h = harness();
  for (const time of [0, 10, 20]) h.tick(time, { disks: [disk('/data', 95, 10)] });
  for (const time of [30, 40, 50]) h.tick(time, { disks: [] });
  assert.equal(h.alerts('disk').length, 1);
  for (const time of [60, 70, 80]) h.tick(time, { disks: [disk('/data', 89, 21)] });
  assert.equal(h.alerts('disk').length, 1);
  for (const time of [90, 100, 110]) h.tick(time, { disks: [disk('/data', 87, 23)] });
  assert.equal(h.alerts('disk').length, 0);
  assert.equal(h.events.at(-1).level, 'recovery');
});

test('repeated disk rows cannot count as separate confirming samples', () => {
  const h = harness(quickConfig({ thresholds: { diskHoldSec: 0 } }));
  assert.deepEqual(h.tick(0, { disks: [disk('/', 99, 1), disk('/', 99, 1)] }), []);
  assert.equal(h.tick(10, { disks: [disk('/', 99, 1)] }).length, 1);
});

test('errors immediately mark unavailable but connection notifications require consecutive failures', () => {
  const h = harness();
  h.tick(0);
  assert.deepEqual(h.fail(10), []);
  assert.equal(h.state.machines.local.error, 'offline');
  assert.equal(h.state.machines.local.lastSuccess, at(0));
  assert.equal(h.state.machines.local.failures, 1);
  h.fail(20);
  assert.equal(h.alerts('connection').length, 0);
  assert.equal(h.fail(30)[0].rule, 'connection');
  assert.deepEqual(h.fail(40), []);
  h.reload();
  assert.deepEqual(h.fail(50), []);
  h.tick(60); h.tick(70);
  assert.equal(h.alerts('connection').length, 1);
  assert.equal(h.tick(80)[0].level, 'recovery');
  assert.equal(h.state.machines.local.error, null);
  assert.equal(h.state.machines.local.failures, 0);
});

test('successful samples reset consecutive failures and configured one-failure alarms work', () => {
  const h = harness();
  h.fail(0); h.fail(10); h.tick(20); h.fail(30); h.fail(40);
  assert.equal(h.alerts('connection').length, 0);
  const immediate = harness(quickConfig({ thresholds: { failures: 1 } }));
  assert.equal(immediate.fail(0)[0].rule, 'connection');
});

test('fetch failure breaks pending CPU, swap baselines and recovery without clearing active health', () => {
  const h = harness();
  h.tick(0, { cpu: 95 }); h.tick(10, { cpu: 95 }); h.fail(20);
  h.tick(30, { cpu: 95 }); h.tick(40, { cpu: 95 });
  assert.equal(h.alerts('cpu').length, 0);
  h.tick(50, { cpu: 95 });
  h.tick(60, { cpu: 10 }); h.fail(70); h.tick(80, { cpu: 10 }); h.tick(90, { cpu: 10 });
  assert.equal(h.alerts('cpu').length, 1);
  h.tick(100, { cpu: 10 });
  assert.equal(h.alerts('cpu').length, 0);

  const swap = harness();
  swap.tick(0, { pressure: 'warning', swapUsedBytes: 0 });
  swap.tick(10, { pressure: 'warning', swapUsedBytes: 100 * MiB });
  swap.fail(20);
  swap.tick(30, { pressure: 'warning', swapUsedBytes: 1000 * MiB });
  swap.tick(40, { pressure: 'warning', swapUsedBytes: 1100 * MiB });
  assert.equal(swap.alerts('swap').length, 0);
});

test('long sample gaps reset pending and recovery clocks but retain active dedup state', () => {
  const h = harness();
  h.tick(0, { cpu: 95 }); h.tick(10, { cpu: 95 });
  assert.deepEqual(h.tick(50, { cpu: 95 }), []);
  h.tick(60, { cpu: 95 }); h.tick(70, { cpu: 95 });
  assert.equal(h.alerts('cpu').length, 1);
  h.tick(80, { cpu: 10 });
  assert.deepEqual(h.tick(120, { cpu: 10 }), []);
  h.tick(130, { cpu: 10 });
  assert.equal(h.alerts('cpu').length, 1);
  h.tick(140, { cpu: 10 });
  assert.equal(h.alerts('cpu').length, 0);

  const active = harness();
  for (const time of [0, 10, 20]) active.tick(time, { cpu: 95 });
  assert.deepEqual(active.tick(100, { cpu: 95 }), []);
  assert.equal(active.alerts('cpu').length, 1);
  assert.equal(active.state.history.length, 1);
});

test('out-of-order and duplicate samples are ignored without changing errors or timers', () => {
  const h = harness();
  h.tick(10, { cpu: 95 }); h.tick(20, { cpu: 95 });
  const before = h.state;
  assert.deepEqual(h.tick(15, { cpu: 1 }, { now: 25 }), []);
  assert.equal(h.state, before);
  assert.deepEqual(h.tick(20, { cpu: 1 }, { now: 26 }), []);
  assert.equal(h.state, before);
  assert.equal(h.tick(30, { cpu: 95 }).length, 1);
  h.fail(40);
  const failed = h.state;
  assert.deepEqual(h.tick(30, { cpu: 1 }, { now: 50 }), []);
  assert.equal(h.state, failed);
  assert.equal(h.state.machines.local.error, 'offline');
});

test('missing and malformed metrics are unknown, never artificial zeros or recovery', () => {
  const h = harness();
  for (const time of [0, 10, 20]) h.tick(time, { cpu: 95, disks: [disk('/data', 99, 1)] });
  for (const time of [30, 40, 50]) assert.deepEqual(h.tick(time, {
    cpu: null, disks: [{ mount: '/data', pct: NaN, freeBytes: undefined }], pressure: null,
  }), []);
  assert.equal(h.alerts('cpu').length, 1);
  assert.equal(h.alerts('disk').length, 1);
  assert.equal(h.state.machines.local.sample.disks[0].pct, null);
  for (const time of [60, 70, 80]) h.tick(time, { cpu: '0', disks: [], pressure: null });
  assert.equal(h.alerts('cpu').length, 1);
});

test('malformed whole samples count as collection errors and nonfinite time is rejected', () => {
  const h = harness();
  const output = advance(h.state, h.config, { machine: 'local', sample: { at: NaN } }, at(0));
  assert.equal(output.state.machines.local.failures, 1);
  assert.equal(typeof output.state.machines.local.error, 'string');
  assert.throws(() => advance(h.state, h.config, { machine: 'local', sample: sample(0) }, NaN));
});

test('process monitoring is opt-in, exact-basename and aggregate across instances', () => {
  const processes = [process('node', 30, 1), process('node', 30, 2), process('node-helper', 99, 3)];
  const off = harness();
  for (const time of [0, 10, 20]) off.tick(time, { processes });
  assert.equal(off.alerts('process').length, 0);
  const on = harness(quickConfig({ watchedProcesses: ['node'] }));
  for (const time of [0, 10, 20]) on.tick(time, { processes });
  assert.equal(on.alerts('process').length, 1);
  assert.equal(on.alerts('process')[0].resource, 'node');
  assert.match(on.alerts('process')[0].body, /60\.0%/);
  for (const time of [30, 40, 50]) on.tick(time, { processes: [process('node-helper', 99)] });
  assert.equal(on.alerts('process').length, 0);
});

test('missing process metrics do not clear active alarms and disabling the watch removes it silently', () => {
  const h = harness(quickConfig({ watchedProcesses: ['node'] }));
  for (const time of [0, 10, 20]) h.tick(time, { processes: [process('node', 80)] });
  for (const time of [30, 40, 50]) h.tick(time, { processes: undefined });
  assert.equal(h.alerts('process').length, 1);
  for (const time of [60, 70, 80]) h.tick(time, { processes: [process('node', NaN)] });
  assert.equal(h.alerts('process').length, 1);
  h.config.watchedProcesses = [];
  assert.deepEqual(h.tick(90), []);
  assert.equal(h.alerts('process').length, 0);
});

test('process-only exclusions never suppress CPU or memory system alarms', () => {
  const h = harness(quickConfig({ watchedProcesses: ['node'], exclusions: [exclusion({ rule: 'process', resource: 'node' })] }));
  for (const time of [0, 10, 20]) h.tick(time, { cpu: 95, pressure: 'warning', processes: [process('node', 80)] });
  assert.equal(h.alerts().length, 3);
  assert.deepEqual(h.events.map((event) => event.rule).sort(), ['cpu', 'memory']);
});

test('exclusions match exact resource, machine and rule with exclusive expiry', () => {
  const config = quickConfig({ exclusions: [exclusion({ machine: '*', rule: 'disk', resource: '/data', until: at(30) })] });
  assert.equal(isExcluded(config, 'remote', 'disk', '/data', at(29)), true);
  assert.equal(isExcluded(config, 'remote', 'disk', '/database', at(29)), false);
  assert.equal(isExcluded(config, 'local', 'cpu', '', at(29)), false);
  assert.equal(isExcluded(config, 'remote', 'disk', '/data', at(30)), false);
  config.exclusions = [exclusion({ rule: '*', resource: '' })];
  assert.equal(isExcluded(config, 'local', 'process', 'node', at(1000)), true);
  assert.equal(isExcluded(config, 'other', 'process', 'node', at(1000)), false);
});

test('excluded incidents remain active and emit exactly once when the exclusion expires', () => {
  const h = harness(quickConfig({ exclusions: [exclusion({ until: at(40) })] }));
  for (const time of [0, 10, 20, 30]) assert.deepEqual(h.tick(time, { cpu: 95 }), []);
  assert.equal(h.alerts('cpu').length, 1);
  assert.equal(h.state.history.length, 0);
  h.reload();
  assert.equal(h.tick(40, { cpu: 95 }).length, 1);
  assert.deepEqual(h.tick(50, { cpu: 95 }), []);
  assert.equal(h.state.history.length, 1);
});

test('snoozing an already delivered incident rearms it once, and acknowledgement stays distinct', () => {
  const h = harness();
  for (const time of [0, 10, 20]) h.tick(time, { cpu: 95 });
  h.alerts('cpu')[0].acknowledged = true;
  h.config.exclusions = [exclusion({ until: at(50) })];
  assert.deepEqual(h.tick(30, { cpu: 95 }), []);
  h.reload();
  assert.deepEqual(h.tick(40, { cpu: 95 }), []);
  assert.equal(h.tick(50, { cpu: 95 }).length, 1);
  assert.equal(h.alerts('cpu')[0].acknowledged, false);
  assert.deepEqual(h.tick(60, { cpu: 95 }), []);
});

test('never-delivered incidents do not create orphan recoveries after exclusions expire', () => {
  const h = harness(quickConfig({ exclusions: [exclusion({ until: at(50) })] }));
  for (const time of [0, 10, 20]) h.tick(time, { cpu: 95 });
  for (const time of [30, 40, 50]) assert.deepEqual(h.tick(time, { cpu: 10 }), []);
  assert.equal(h.alerts('cpu').length, 0);
  assert.equal(h.state.history.length, 0);
});

test('recovery notifications are optional without changing health resolution', () => {
  const h = harness(quickConfig({ recovery: false }));
  for (const time of [0, 10, 20]) h.tick(time, { cpu: 95 });
  for (const time of [30, 40, 50]) assert.deepEqual(h.tick(time, { cpu: 10 }), []);
  assert.equal(h.alerts('cpu').length, 0);
  assert.equal(h.state.history.length, 1);
});

test('resolved incidents can recur under the same key but distinct persistent event IDs', () => {
  const h = harness();
  for (const time of [0, 10, 20]) h.tick(time, { cpu: 95 });
  const first = h.events[0];
  for (const time of [30, 40, 50]) h.tick(time, { cpu: 10 });
  h.reload();
  for (const time of [60, 70, 80]) h.tick(time, { cpu: 95 });
  const second = h.events.at(-1);
  assert.equal(second.key, first.key);
  assert.notEqual(second.id, first.id);
  assert.equal(new Set(h.events.map((event) => event.id)).size, h.events.length);
});

test('remote monitoring requires explicit target opt-in and machines remain independent', () => {
  let state = initialState();
  const ignored = advance(state, defaultConfig(), { machine: 'remote', error: 'offline' }, at(0));
  assert.equal(ignored.state, state);
  assert.deepEqual(ignored.events, []);
  const config = quickConfig({ targets: ['local', 'remote'] });
  for (const time of [0, 10, 20]) {
    state = advance(state, config, { machine: 'local', sample: sample(time, { cpu: 95 }) }, at(time)).state;
    state = advance(state, config, { machine: 'remote', sample: sample(time) }, at(time)).state;
  }
  assert.equal(Object.values(state.machines.local.alerts).length, 1);
  assert.equal(Object.values(state.machines.remote.alerts).length, 0);
});

test('machine names and mount paths cannot pollute prototypes, including after serialization', () => {
  const before = Object.getOwnPropertyNames(Object.prototype);
  for (const name of ['__proto__', 'constructor', 'toString']) {
    const h = harness(quickConfig({ targets: [name] }), name);
    for (const time of [0, 10, 20]) h.tick(time, { disks: [disk('__proto__', 99, 1), disk('constructor', 91, 100)] });
    assert.equal(Object.hasOwn(h.state.machines, name), true);
    assert.equal(h.alerts('disk').length, 2);
    assert.equal(h.events.every((event) => event.machine === name), true);
    h.reload();
    assert.deepEqual(h.tick(30, { disks: [disk('__proto__', 99, 1), disk('constructor', 91, 100)] }), []);
  }
  assert.deepEqual(Object.getOwnPropertyNames(Object.prototype), before);
  assert.equal(Object.prototype.polluted, undefined);
});

test('advance does not mutate frozen caller state, configuration, results or historical events', () => {
  const h = harness();
  for (const time of [0, 10, 20]) h.tick(time, { cpu: 95 });
  const state = freeze(h.state);
  const config = freeze(h.config);
  const result = freeze({ machine: 'local', sample: sample(30, { cpu: 70 }) });
  const output = advance(state, config, result, at(30));
  assert.notEqual(output.state, state);
  assert.notEqual(output.state.machines.local, state.machines.local);
  assert.equal(Object.values(state.machines.local.alerts)[0].recoverySince, null);
  assert.equal(Object.values(output.state.machines.local.alerts)[0].recoverySince, at(30));
  assert.equal(state.history.length, 1);
});

test('history stays newest-first and bounded to 200 real events', () => {
  const h = harness(quickConfig({ thresholds: { cpuHoldSec: 0, recoverySec: 0 } }));
  let time = 0;
  for (let incident = 0; incident < 105; incident += 1) {
    h.tick(time++, { cpu: 95 }); h.tick(time++, { cpu: 95 });
    h.tick(time++, { cpu: 10 }); h.tick(time++, { cpu: 10 });
  }
  assert.equal(h.events.length, 210);
  assert.equal(h.state.history.length, 200);
  assert.equal(h.state.history[0].id, h.events.at(-1).id);
  assert.equal(h.state.history.at(-1).id, h.events[10].id);
  for (let index = 1; index < h.state.history.length; index += 1) assert.ok(h.state.history[index - 1].at >= h.state.history[index].at);
});

test('validated core counts survive normalized samples and persisted state for process consumers', () => {
  const h = harness();
  h.tick(0, { cores: 8 });
  h.reload();
  assert.equal(h.state.machines.local.sample.cores, 8);
  let time = 10;
  for (const cores of [0, -1, 1.5, NaN, Infinity, '8', null, undefined]) {
    h.tick(time, { cores });
    assert.equal(h.state.machines.local.sample.cores, null);
    time += 10;
  }
});

test('expired exclusions defer CPU and disk delivery during failure or missing relevant metrics', () => {
  const h = harness(quickConfig({ exclusions: [exclusion({ rule: '*', until: at(30) })] }));
  for (const time of [0, 10, 20]) assert.deepEqual(h.tick(time, { cpu: 95, disks: [disk('/data', 99, 1)] }), []);
  assert.equal(h.alerts().length, 2);
  assert.deepEqual(h.fail(30), []);
  h.reload();
  assert.deepEqual(h.tick(40, { cpu: null, disks: [] }), []);
  assert.equal(h.alerts().length, 2);
  assert.equal(h.state.history.length, 0);
  assert.deepEqual(h.tick(50, { cpu: 95, disks: [] }).map((event) => event.rule), ['cpu']);
  assert.deepEqual(h.tick(60, { cpu: 95, disks: [disk('/data', 99, 1)] }).map((event) => event.rule), ['disk']);
  assert.deepEqual(h.tick(70, { cpu: 95, disks: [disk('/data', 99, 1)] }), []);
});

test('expired exclusions do not raise stale incidents while currently healthy recovery is pending', () => {
  const h = harness(quickConfig({ exclusions: [exclusion({ rule: '*', until: at(30) })] }));
  for (const time of [0, 10, 20]) h.tick(time, { cpu: 95, disks: [disk('/data', 99, 1)] });
  for (const time of [30, 40, 50]) assert.deepEqual(h.tick(time, { cpu: 10, disks: [disk('/data', 40, 100)] }), []);
  assert.equal(h.alerts().length, 0);
  assert.equal(h.state.history.length, 0);
});

test('connection incidents may deliver after exclusion expiry on a current failed collection', () => {
  const h = harness(quickConfig({ thresholds: { failures: 1 }, exclusions: [exclusion({ rule: 'connection', until: at(40) })] }));
  for (const time of [0, 10, 20, 30]) assert.deepEqual(h.fail(time), []);
  h.reload();
  assert.deepEqual(h.fail(40).map((event) => event.rule), ['connection']);
  assert.deepEqual(h.fail(50), []);
});
