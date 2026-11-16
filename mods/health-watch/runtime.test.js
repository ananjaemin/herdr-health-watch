import { test, expect, mock, beforeEach } from 'bun:test';
const store = new Map();
let requests = [], delivered = [];
mock.module('herdr', () => ({ shared: (k) => store.get(k), setShared: (k, v) => store.set(k, v), machines: () => [], exec: async () => ({ code: 0, stdout: 'Linux\nen_US.UTF-8\n', stderr: '' }) }));
mock.module('./collector.js', () => ({ collect: (machine) => new Promise((resolve) => requests.push({ machine, resolve })) }));
mock.module('./notifications.js', () => ({ deliver: async (event) => { delivered.push(event); return { status: 'sent', error: '' }; } }));
const { tick, saveConfig, snapshot, addExclusion } = await import('./runtime.js');
const { defaultConfig } = await import('./engine.js');
const sample = (cpu = 20) => ({ at: Date.now(), os: 'darwin', host: 'test', cores: 10, cpu, memoryPct: 50, pressure: 'normal', swapUsedBytes: 0,
  disks: [{ mount: '/', pct: 50, freeBytes: 100 * 1024 ** 3 }], processes: [], collectionMs: 1 });
beforeEach(() => { store.clear(); requests = []; delivered = []; });
test('two visible copies share one collection and do not duplicate notifications', async () => {
  const a = tick(); const b = tick();
  expect(requests.length).toBe(1);
  requests[0].resolve({ machine: 'local', sample: sample() });
  await Promise.all([a, b]);
  expect(snapshot().state.machines.local.sample.cpu).toBe(20);
  await tick(); expect(requests.length).toBe(1);
});
test('changing targets during a read never commits a disabled target or sends its warning', async () => {
  const pending = tick();
  saveConfig({ ...defaultConfig(), targets: [] });
  requests[0].resolve({ machine: 'local', error: 'offline' });
  await pending;
  expect(Object.keys(snapshot().state.machines)).toEqual([]);
  expect(delivered).toEqual([]);
});
test('expired old owner cannot overwrite the new owner result', async () => {
  const old = tick();
  store.set('health-watch.control', { token: 'expired', until: 0, nextAt: 0 });
  const current = tick();
  requests[1].resolve({ machine: 'local', sample: sample(25) });
  await current;
  requests[0].resolve({ machine: 'local', sample: sample(99) });
  await old;
  expect(snapshot().state.machines.local.sample.cpu).toBe(25);
});
test('invalid persisted config visibly stops sampling instead of silently using defaults', async () => {
  store.set('health-watch.config', { intervalSeconds: -1 });
  await tick();
  expect(requests).toEqual([]);
  expect(snapshot().configValid).toBe(false);
  expect(snapshot().config.targets).toEqual([]);
});

test('language changes preserve existing readings and relabel the local machine', () => {
  store.set('health-watch.state', { machines: { local: { sample: sample(42), alerts: {} } }, history: [] });
  for (const language of ['en', 'ko', 'ja', 'zh-CN']) {
    saveConfig({ ...defaultConfig(), language });
    const view = snapshot();
    expect(view.locale).toBe(language);
    expect(view.state.machines.local.sample.cpu).toBe(42);
    expect(view.configValid).toBe(true);
  }
  expect(snapshot().machineOptions[0].label).toBe('本机');
});

test('temporary exclusions allow an empty user reason but permanent ones require it', () => {
  const exclusion = { machine: 'local', rule: 'cpu', resource: '', reason: '', until: Date.now() + 60000 };
  addExclusion(exclusion);
  expect(snapshot().config.exclusions[0].reason).toBe('');
  expect(snapshot().config.exclusions[0].until).toBe(exclusion.until);
  expect(() => addExclusion({ ...exclusion, until: 0 })).toThrow();
  expect(snapshot().config.exclusions).toHaveLength(1);
});

test('persisted collector and notification failures relocalize without another external call', () => {
  store.set('health-watch.state', { machines: { local: { error: '기존 오류', errorDescriptor: { key: 'error.vitalsMissing' } } }, history: [] });
  store.set('health-watch.delivery', { status: 'error', error: '기존 오류', errorKey: 'error.notifier' });
  saveConfig({ ...defaultConfig(), language: 'en' });
  const view = snapshot();
  expect(view.state.machines.local.error).not.toMatch(/[가-힣]/);
  expect(view.delivery.error).not.toMatch(/[가-힣]/);
  expect(view.delivery.status).toBe('error');
  expect(requests).toEqual([]);
});
