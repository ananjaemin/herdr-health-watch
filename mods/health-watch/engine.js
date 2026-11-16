import { SUPPORTED_LOCALES, issue, eventText } from './i18n.js';

const RULES = new Set(['cpu', 'memory', 'swap', 'disk', 'connection', 'process']);
const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const own = (value, key) => value != null && Object.hasOwn(value, key);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value, min = 0, max = Infinity) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const metric = (value, max = Infinity) => finite(value, 0, max) ? value : null;
const keyFor = (machine, rule, resource) => JSON.stringify([machine, rule, resource]);

export function defaultConfig() {
  return {
    language: 'auto', intervalSeconds: 10, desktop: true, criticalSound: false, recovery: true,
    targets: ['local'], watchedProcesses: [], exclusions: [],
    thresholds: {
      cpuWarn: 90, cpuClear: 80, cpuHoldSec: 120,
      memWarn: 90, memCritical: 97, memoryHoldSec: 30,
      swapGrowthMiBMin: 256, swapHoldSec: 60,
      diskWarnPct: 90, diskCriticalPct: 97, diskWarnFreeGiB: 20,
      diskCriticalFreeGiB: 5, diskHoldSec: 30, recoverySec: 30,
      failures: 3, processCpuWarn: 50, processCpuHoldSec: 120,
    },
  };
}

function strings(value, field, basename = false) {
  if (!Array.isArray(value)) throw issue('error.array', { field }, TypeError);
  const result = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry.trim() || (basename && /[/\\]/.test(entry))) {
      throw issue('error.name', { field }, TypeError);
    }
    const name = entry.trim();
    if (!result.includes(name)) result.push(name);
  }
  return result;
}

export function normalizeConfig(input = {}) {
  if (!object(input)) throw issue('error.object', { field: 'config' }, TypeError);
  const config = defaultConfig();
  if (own(input, 'language')) {
    if (input.language !== 'auto' && !SUPPORTED_LOCALES.includes(input.language)) throw issue('error.language', {}, TypeError);
    config.language = input.language;
  }
  if (own(input, 'intervalSeconds')) {
    if (!finite(input.intervalSeconds, 5, 300) || !Number.isInteger(input.intervalSeconds)) throw issue('error.interval', {}, RangeError);
    config.intervalSeconds = input.intervalSeconds;
  }
  for (const field of ['desktop', 'criticalSound', 'recovery']) {
    if (!own(input, field)) continue;
    if (typeof input[field] !== 'boolean') throw issue('error.boolean', { field }, TypeError);
    config[field] = input[field];
  }
  for (const field of ['targets', 'watchedProcesses']) {
    if (own(input, field)) config[field] = strings(input[field], field, field === 'watchedProcesses');
  }
  if (own(input, 'thresholds')) {
    if (!object(input.thresholds)) throw issue('error.object', { field: 'thresholds' }, TypeError);
    for (const field of Object.keys(config.thresholds)) {
      if (!own(input.thresholds, field)) continue;
      const value = input.thresholds[field];
      const maximum = field.endsWith('Sec') ? 86400
        : field === 'failures' ? 1000
        : /Pct$|^cpuWarn$|^cpuClear$|^memWarn$|^memCritical$|^processCpuWarn$/.test(field) ? 100
        : 1024 ** 3;
      const minimum = field.endsWith('Sec') || field === 'cpuClear' ? 0 : Number.MIN_VALUE;
      if (!finite(value, minimum, maximum) || (field === 'failures' && !Number.isInteger(value))) {
        throw issue('error.range', { field }, RangeError);
      }
      config.thresholds[field] = value;
    }
  }
  const t = config.thresholds;
  if (t.cpuClear >= t.cpuWarn || t.memWarn >= t.memCritical || t.diskWarnPct >= t.diskCriticalPct || t.diskCriticalFreeGiB >= t.diskWarnFreeGiB) {
    throw issue('error.thresholdOrder', {}, RangeError);
  }
  if (own(input, 'exclusions')) {
    if (!Array.isArray(input.exclusions)) throw issue('error.array', { field: 'exclusions' }, TypeError);
    config.exclusions = input.exclusions.map((entry) => {
      if (!object(entry) || typeof entry.id !== 'string' || !entry.id || typeof entry.machine !== 'string' || !entry.machine ||
        typeof entry.rule !== 'string' || (entry.rule !== '*' && !RULES.has(entry.rule)) ||
        typeof entry.resource !== 'string' || typeof entry.reason !== 'string' || !finite(entry.until)) {
        throw issue('error.exclusion', {}, TypeError);
      }
      return { id: entry.id, machine: entry.machine, rule: entry.rule, resource: entry.resource, until: entry.until, reason: entry.reason };
    });
  }
  return config;
}

export function initialState() {
  return { machines: {}, history: [] };
}

export function isExcluded(config, machine, rule, resource, now) {
  return (Array.isArray(config?.exclusions) ? config.exclusions : []).some((entry) =>
    object(entry) && (entry.machine === '*' || entry.machine === machine) &&
    (entry.rule === '*' || entry.rule === rule) &&
    (entry.resource === '' || entry.resource === resource) &&
    finite(entry.until) && (entry.until === 0 || entry.until > now));
}

function normalizeSample(value) {
  if (!object(value) || !finite(value.at) || !['darwin', 'linux'].includes(value.os)) return null;
  const disks = new Map();
  for (const disk of Array.isArray(value.disks) ? value.disks : []) {
    if (!object(disk) || typeof disk.mount !== 'string' || !disk.mount || disks.has(disk.mount)) continue;
    disks.set(disk.mount, { mount: disk.mount, pct: metric(disk.pct, 100), freeBytes: metric(disk.freeBytes) });
  }
  const processes = [];
  for (const process of Array.isArray(value.processes) ? value.processes : []) {
    if (!object(process) || typeof process.name !== 'string' || !process.name) continue;
    processes.push({ name: process.name, pid: metric(process.pid), cpu: metric(process.cpu, 100), memoryBytes: metric(process.memoryBytes) });
  }
  return {
    at: value.at, os: value.os, host: typeof value.host === 'string' ? value.host : '',
    cpu: metric(value.cpu, 100), memoryPct: metric(value.memoryPct, 100),
    pressure: ['normal', 'warning', 'critical'].includes(value.pressure) ? value.pressure : null,
    swapUsedBytes: metric(value.swapUsedBytes), disks, processes,
    collectionMs: metric(value.collectionMs),
    cores: Number.isSafeInteger(value.cores) && value.cores >= 1 ? value.cores : null,
    processesAvailable: Array.isArray(value.processes) && value.processes.every((process) => object(process) && typeof process.name === 'string' && process.name.length > 0),
  };
}

function cloneRecord(value) {
  return Object.fromEntries(Object.entries(object(value) ? value : {}).map(([key, item]) => [key, { ...item }]));
}

function newMachine(previous) {
  return {
    sample: null, lastSuccess: 0, error: null, failures: 0,
    lastSampleAt: null, lastResultAt: null, swapPoint: null, sequence: 0,
    ...previous,
    alerts: cloneRecord(previous?.alerts), candidates: cloneRecord(previous?.candidates),
  };
}

function describe(rule, resource, value) {
  let body = `event.${rule}.body`, params;
  switch (rule) {
    case 'cpu': case 'swap': case 'process': params = { resource, value: value.toFixed(1) }; break;
    case 'memory':
      body = typeof value === 'number' ? 'event.memory.percent' : 'event.memory.pressure';
      params = typeof value === 'number' ? { value: value.toFixed(1) } : { pressure: value }; break;
    case 'disk': params = { resource, percent: value.pct === null ? '?' : value.pct.toFixed(1), free: value.freeBytes === null ? '?' : (value.freeBytes / GiB).toFixed(1) }; break;
    default: params = { error: String(value) };
  }
  const message = { body, params };
  return { message, ...eventText('en', { rule, resource, message }) };
}

function signalsFor(sample, machine, config) {
  const t = config.thresholds;
  const signals = [];
  const add = (rule, resource, level, clear, hold, value) => {
    signals.push({ rule, resource, level, clear, hold: hold * 1000, ...describe(rule, resource, value) });
  };
  if (sample.cpu !== null) add('cpu', '', sample.cpu >= t.cpuWarn ? 'warning' : null, sample.cpu <= t.cpuClear, t.cpuHoldSec, sample.cpu);
  let memoryBad = null;
  let memoryClear = null;
  if (sample.os === 'darwin' && sample.pressure !== null) {
    memoryBad = sample.pressure !== 'normal';
    memoryClear = !memoryBad;
    add('memory', '', sample.pressure === 'critical' ? 'critical' : memoryBad ? 'warning' : null, memoryClear, t.memoryHoldSec, sample.pressure);
  } else if (sample.os === 'linux' && sample.memoryPct !== null) {
    memoryBad = sample.memoryPct >= t.memWarn;
    memoryClear = sample.memoryPct <= Math.max(0, t.memWarn - 5);
    add('memory', '', sample.memoryPct >= t.memCritical ? 'critical' : memoryBad ? 'warning' : null, memoryClear, t.memoryHoldSec, sample.memoryPct);
  }
  const point = machine.swapPoint;
  if (sample.swapUsedBytes !== null && point && sample.at > point.at && memoryBad !== null) {
    const growth = Math.max(0, sample.swapUsedBytes - point.bytes) * 60000 / (sample.at - point.at) / MiB;
    add('swap', '', growth >= t.swapGrowthMiBMin && memoryBad ? 'warning' : null,
      growth < t.swapGrowthMiBMin * 0.75 || memoryClear === true, t.swapHoldSec, growth);
  }
  machine.swapPoint = sample.swapUsedBytes === null ? null : { at: sample.at, bytes: sample.swapUsedBytes };
  for (const disk of sample.disks.values()) {
    if (disk.pct === null && disk.freeBytes === null) continue;
    const free = disk.freeBytes === null ? null : disk.freeBytes / GiB;
    const critical = (disk.pct !== null && disk.pct >= t.diskCriticalPct) || (free !== null && free <= t.diskCriticalFreeGiB);
    const warning = (disk.pct !== null && disk.pct >= t.diskWarnPct) || (free !== null && free <= t.diskWarnFreeGiB);
    add('disk', disk.mount, critical ? 'critical' : warning ? 'warning' : null,
      disk.pct !== null && free !== null && disk.pct <= Math.max(0, t.diskWarnPct - 3) && free >= t.diskWarnFreeGiB * 1.1, t.diskHoldSec, disk);
  }
  for (const name of sample.processesAvailable ? config.watchedProcesses : []) {
    const matching = sample.processes.filter((process) => process.name === name);
    if (matching.some((process) => process.cpu === null)) continue;
    const cpu = Math.min(100, matching.reduce((sum, process) => sum + process.cpu, 0));
    add('process', name, cpu >= t.processCpuWarn ? 'warning' : null,
      cpu <= Math.max(0, t.processCpuWarn - 5), t.processCpuHoldSec, cpu);
  }
  return signals;
}

/** Pure transition. Internal timers and delivery markers are JSON-serializable. */
export function advance(previous, inputConfig, result, now) {
  if (!finite(now)) throw issue('error.time', {}, TypeError);
  const config = normalizeConfig(inputConfig);
  const state = object(previous) ? previous : initialState();
  if (!object(result) || typeof result.machine !== 'string' || !config.targets.includes(result.machine)) return { state, events: [] };
  const id = result.machine;
  const previousMachine = own(state.machines, id) ? state.machines[id] : undefined;
  const machine = newMachine(previousMachine);
  if (machine.lastResultAt !== null && now < machine.lastResultAt) return { state, events: [] };
  const hasError = own(result, 'error') && result.error !== undefined;
  const sample = hasError ? null : normalizeSample(result.sample);
  if (sample && machine.lastSampleAt !== null && sample.at <= machine.lastSampleAt) return { state, events: [] };
  const events = [];
  const emit = (alert, level, at) => {
    machine.sequence += 1;
    const event = { id: `${alert.key}:${machine.sequence}`, key: alert.key, machine: id,
      rule: alert.rule, resource: alert.resource, level, message: alert.message, at };
    events.push({ ...event, ...eventText('en', { ...alert, ...event }) });
  };
  const resetContinuity = () => {
    machine.candidates = {};
    machine.swapPoint = null;
    for (const alert of Object.values(machine.alerts)) {
      alert.recoverySince = null;
      alert.recoveryCount = 0;
    }
  };
  const gapLimit = Math.max(3 * config.intervalSeconds, 30) * 1000;
  if ((machine.lastResultAt !== null && now - machine.lastResultAt > gapLimit) ||
      (sample && machine.lastSampleAt !== null && sample.at - machine.lastSampleAt > gapLimit)) resetContinuity();
  machine.lastResultAt = now;

  const observe = (signal, time, confirmed = false) => {
    const key = keyFor(id, signal.rule, signal.resource);
    const alert = own(machine.alerts, key) ? machine.alerts[key] : null;
    if (!signal.level) {
      delete machine.candidates[key];
      if (!alert) return;
      if (!signal.clear) {
        alert.recoverySince = null;
        alert.recoveryCount = 0;
        return;
      }
      if (alert.recoverySince === null || alert.recoverySince === undefined) {
        alert.recoverySince = time;
        alert.recoveryCount = 0;
      }
      alert.recoveryCount += 1;
      if (alert.recoveryCount >= 2 && time - alert.recoverySince >= config.thresholds.recoverySec * 1000) {
        if (config.recovery && alert.deliveredRaise && !isExcluded(config, id, alert.rule, alert.resource, now)) emit(alert, 'recovery', now);
        delete machine.alerts[key];
      }
      return;
    }
    if (alert) {
      alert.recoverySince = null;
      alert.recoveryCount = 0;
      alert.title = signal.title;
      alert.body = signal.body;
      alert.message = signal.message;
      if (alert.level === 'critical' || signal.level === alert.level) {
        delete machine.candidates[key];
        return;
      }
    }
    let candidate = own(machine.candidates, key) ? machine.candidates[key] : null;
    if (!candidate) candidate = { since: time, count: 0, level: signal.level, levelSince: time, levelCount: 0 };
    if (candidate.level !== signal.level) {
      candidate.level = signal.level;
      candidate.levelSince = time;
      candidate.levelCount = 0;
    }
    candidate.count += 1;
    candidate.levelCount += 1;
    machine.candidates[key] = candidate;
    if (!confirmed && (candidate.count < 2 || time - candidate.since < signal.hold)) return;
    const level = signal.level === 'critical' && candidate.levelCount >= 2 && time - candidate.levelSince >= signal.hold ? 'critical' : 'warning';
    if (alert) {
      alert.level = level;
      alert.acknowledged = false;
    } else {
      machine.alerts[key] = { key, machine: id, rule: signal.rule, resource: signal.resource,
        level, title: signal.title, body: signal.body, message: signal.message, since: candidate.since,
        acknowledged: false, deliveredRaise: false, deliveredLevel: null, suppressed: false,
        recoverySince: null, recoveryCount: 0 };
    }
    if (level === 'warning' && signal.level === 'critical') {
      machine.candidates[key] = { since: candidate.levelSince, count: candidate.levelCount, level: 'critical', levelSince: candidate.levelSince, levelCount: candidate.levelCount };
    } else {
      delete machine.candidates[key];
    }
  };

  const measuredBad = new Set();
  if (!sample) {
    resetContinuity();
    machine.error = hasError && typeof result.error === 'string' && result.error ? result.error : issue('error.sample').message;
    machine.errorDescriptor = result?.errorDescriptor ?? (!hasError ? { key: 'error.sample' } : null);
    machine.failures += 1;
    const description = describe('connection', '', machine.error);
    if (machine.errorDescriptor) description.message.cause = machine.errorDescriptor;
    measuredBad.add(keyFor(id, 'connection', ''));
    observe({ rule: 'connection', resource: '', level: 'warning', clear: false, hold: 0, ...description }, now,
      machine.failures >= config.thresholds.failures);
    // A failure count is the connection rule's confirmation, not a duration.
    if (machine.failures < config.thresholds.failures) delete machine.candidates[keyFor(id, 'connection', '')];
  } else {
    machine.error = null;
    machine.errorDescriptor = null;
    machine.failures = 0;
    machine.lastSuccess = sample.at;
    machine.lastSampleAt = sample.at;
    const signals = signalsFor(sample, machine, config);
    signals.push({ rule: 'connection', resource: '', level: null, clear: true, hold: 0, ...describe('connection', '', '') });
    const seen = new Set(signals.map((signal) => keyFor(id, signal.rule, signal.resource)));
    for (const key of Object.keys(machine.candidates)) if (!seen.has(key)) delete machine.candidates[key];
    for (const alert of Object.values(machine.alerts)) {
      if (alert.rule === 'process' && !config.watchedProcesses.includes(alert.resource)) {
        delete machine.alerts[alert.key];
      } else if (!seen.has(alert.key)) {
        alert.recoverySince = null;
        alert.recoveryCount = 0;
      }
    }
    for (const signal of signals) {
      observe(signal, sample.at);
      if (signal.level) measuredBad.add(keyFor(id, signal.rule, signal.resource));
    }
    machine.sample = { ...sample, disks: [...sample.disks.values()] };
  }
  for (const alert of Object.values(machine.alerts)) {
    if (isExcluded(config, id, alert.rule, alert.resource, now)) {
      alert.suppressed = true;
    } else if (measuredBad.has(alert.key) && (alert.suppressed || alert.deliveredLevel !== alert.level)) {
      if (alert.suppressed) alert.acknowledged = false;
      emit(alert, alert.level, now);
      alert.suppressed = false;
      alert.deliveredLevel = alert.level;
      alert.deliveredRaise = true;
    }
  }
  return {
    state: { ...state, machines: { ...state.machines, [id]: machine }, history: [...events].reverse().concat(Array.isArray(state.history) ? state.history : []).slice(0, 200) },
    events,
  };
}
