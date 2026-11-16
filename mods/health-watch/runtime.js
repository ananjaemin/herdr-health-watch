import { shared, setShared, machines } from 'herdr';
import { defaultConfig, normalizeConfig, initialState, advance } from './engine.js';
import { collect } from './collector.js';
import { deliver } from './notifications.js';
import { resolveLocale, t, issue, errorMessage } from './i18n.js';
import { systemEnvironment } from './environment.js';

const CONFIG = 'health-watch.config';
const STATE = 'health-watch.state';
const CONTROL = 'health-watch.control';
const DELIVERY = 'health-watch.delivery';
const ERROR = 'health-watch.error';
const copy = (value) => JSON.parse(JSON.stringify(value));
export function snapshot() {
  const stored = shared(CONFIG);
  let config, error = '', configValid = true;
  const systemLocale = systemEnvironment().language;
  const locale = resolveLocale(stored?.language, systemLocale);
  try { config = normalizeConfig(stored ?? defaultConfig()); }
  catch (e) { config = defaultConfig(); config.targets = []; configValid = false; error = t(locale, 'error.config', { error: errorMessage(locale, e) }); }
  const storedState = shared(STATE) ?? initialState();
  let localizedMachines;
  for (const [id, machine] of Object.entries(storedState.machines ?? {})) {
    if (!machine.errorDescriptor) continue;
    localizedMachines ??= { ...storedState.machines };
    localizedMachines[id] = { ...machine, error: t(locale, machine.errorDescriptor.key, machine.errorDescriptor.params) };
  }
  const state = localizedMachines ? { ...storedState, machines: localizedMachines } : storedState;
  const delivery = shared(DELIVERY) ?? { status: 'idle', error: '' };
  const live = machines();
  const machineOptions = [{ id: 'local', label: t(locale, 'machine.local'), available: true },
    ...live.filter((m) => m.name).map((m) => ({ id: m.name, label: m.name, available: m.layout !== 'unavailable' }))];
  for (const id of config.targets) if (!machineOptions.some((m) => m.id === id)) machineOptions.push({ id, label: id, available: false });
  return { config, configValid, locale, state, machineOptions, runtimeError: error || shared(ERROR) || '',
    delivery: delivery.errorKey ? { ...delivery, error: t(locale, delivery.errorKey, delivery.errorParams) } : delivery };
}
export function saveConfig(value) {
  const config = normalizeConfig(value);
  setShared(CONFIG, config);
  setShared(ERROR, '');
  // Retain the in-flight owner, but make the next tick eligible immediately.
  const control = shared(CONTROL) ?? {};
  setShared(CONTROL, { ...control, nextAt: 0 });
  return config;
}
export function acknowledge(machine, key) {
  const state = copy(shared(STATE) ?? initialState());
  const alert = state.machines[machine]?.alerts?.[key];
  if (alert) { alert.acknowledged = true; setShared(STATE, state); }
}
export function addExclusion(value) {
  const { config } = snapshot();
  const reason = String(value.reason ?? '').trim();
  if (!reason && value.until === 0) throw issue('error.reason');
  config.exclusions.push({ ...value, reason, id: `exception-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` });
  saveConfig(config);
}
export function removeExclusion(id) {
  const { config } = snapshot();
  config.exclusions = config.exclusions.filter((e) => e.id !== id);
  saveConfig(config);
}
function groupEvents(events) {
  const grouped = new Map();
  for (const e of events) {
    const group = `${e.machine}:${e.level === 'recovery' ? 'recovery' : 'alert'}`;
    if (!grouped.has(group)) grouped.set(group, []);
    grouped.get(group).push(e);
  }
  return [...grouped.values()].map((es) => es.length === 1 ? es[0] : ({ ...es[0], key: `${es[0].machine}:summary`,
    level: es.some((e) => e.level === 'critical') ? 'critical' : es[0].level,
    items: es }));
}
// All copies share a persisted lease. No cx is retained; removed/reloaded copies cannot
// commit a late read after another copy has taken ownership. App crashes expire the lease.
export async function tick(force = false) {
  const now = Date.now();
  const previous = shared(CONTROL) ?? {};
  if (previous.until > now || (!force && previous.nextAt > now)) return;
  const { config, configValid, locale } = snapshot();
  if (!configValid) return;
  const token = `${now}-${Math.random()}`;
  const revision = JSON.stringify(config);
  setShared(CONTROL, { token, until: now + 15000, nextAt: now + config.intervalSeconds * 1000 });
  try {
    const results = await Promise.all(config.targets.map((machine) => collect(machine, config, locale)));
    if (shared(CONTROL)?.token !== token || JSON.stringify(snapshot().config) !== revision) return;
    let state = shared(STATE) ?? initialState();
    const events = [];
    for (const result of results) {
      const next = advance(state, config, result, Date.now());
      state = next.state;
      events.push(...next.events);
    }
    setShared(STATE, state);
    setShared(ERROR, '');
    // Release collection before notification tools run; they never own health state.
    setShared(CONTROL, { token, until: 0, nextAt: now + config.intervalSeconds * 1000 });
    for (const event of groupEvents(events)) setShared(DELIVERY, await deliver(event, config, locale));
  } catch (error) {
    if (shared(CONTROL)?.token === token) setShared(ERROR, errorMessage(locale, error));
  } finally {
    const current = shared(CONTROL);
    if (current?.token === token && current.until) setShared(CONTROL, { ...current, until: 0 });
  }
}
export async function testNotification(machine = 'local') {
  const { config, locale } = snapshot();
  const event = { id: `test-${Date.now()}`, key: 'test', machine, rule: 'connection', resource: '', level: 'warning',
    message: { title: 'event.test.title' }, at: Date.now() };
  const result = await deliver(event, { ...config, desktop: true }, locale);
  setShared(DELIVERY, result);
  return result;
}
