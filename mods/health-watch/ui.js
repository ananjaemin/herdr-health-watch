import { div } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { theme } from "herdr";
import { defaultConfig, normalizeConfig, isExcluded } from "./engine.js";
import { t as translate, eventText, errorMessage } from "./i18n.js";

const RULES = [["*", "ui.allRules"], ["cpu", "ui.cpu"], ["memory", "ui.memory"], ["swap", "ui.swap"], ["disk", "ui.disk"], ["connection", "ui.connection"], ["process", "ui.process"]];
const TABS = [["overview", "ui.overview"], ["settings", "ui.settings"], ["exceptions", "ui.exceptions"], ["history", "ui.history"]];
const LANGUAGES = [["auto", "ui.auto"], ["en", "English"], ["ko", "한국어"], ["ja", "日本語"], ["zh-CN", "简体中文"]];
const FIELDS = [
  ["intervalSeconds", "ui.intervalSeconds", 5, 300, true, "ui.collection"],
  ["cpuWarn", "ui.cpuWarn", 0, 100, false, "ui.cpu", true],
  ["cpuClear", "ui.cpuClear", 0, 100, false, "ui.cpu"],
  ["cpuHoldSec", "ui.cpuHoldSec", 0, 86400, false, "ui.cpu"],
  ["memWarn", "ui.memWarn", 0, 100, false, "ui.memory", true],
  ["memCritical", "ui.memCritical", 0, 100, false, "ui.memory", true],
  ["memoryHoldSec", "ui.memoryHoldSec", 0, 86400, false, "ui.memory"],
  ["swapGrowthMiBMin", "ui.swapGrowthMiBMin", 0, 1024 ** 3, false, "ui.swap", true],
  ["swapHoldSec", "ui.swapHoldSec", 0, 86400, false, "ui.swap"],
  ["diskWarnPct", "ui.diskWarnPct", 0, 100, false, "ui.disk", true],
  ["diskCriticalPct", "ui.diskCriticalPct", 0, 100, false, "ui.disk", true],
  ["diskWarnFreeGiB", "ui.diskWarnFreeGiB", 0, 1024 ** 3, false, "ui.disk", true],
  ["diskCriticalFreeGiB", "ui.diskCriticalFreeGiB", 0, 1024 ** 3, false, "ui.disk", true],
  ["diskHoldSec", "ui.diskHoldSec", 0, 86400, false, "ui.disk"],
  ["recoverySec", "ui.recoverySec", 0, 86400, false, "ui.connectionRecovery"],
  ["failures", "ui.failures", 1, 1000, true, "ui.connectionRecovery"],
  ["processCpuWarn", "ui.processCpuWarn", 0, 100, false, "ui.process", true],
  ["processCpuHoldSec", "ui.processCpuHoldSec", 0, 86400, false, "ui.process"],
];
const PLACEHOLDERS = { watchedProcess: "ui.processPlaceholder", alertReason: "ui.alertReasonPlaceholder", exceptionResource: "ui.resourcePlaceholder", exceptionReason: "ui.reasonPlaceholder" };
function tr(view, key, params) { return translate(view.locale, key, params); }
function message(key, params) { return { key, params }; }
function messageText(value, locale) { return value && typeof value === "object" && value.key ? translate(locale, value.key, value.params) : String(value ?? ""); }

function text(value, color, size = 12) {
  return div().min_w(0).whitespace_normal().text_size(size).text_color(color).child(String(value));
}

function button(id, label, callback, t, selected = false) {
  return div().id(id).flex_none().h(30).px(11).flex().items_center().justify_center().whitespace_nowrap()
    .rounded(7).border(1).border_color(selected ? t.accent : t.border)
    .bg(selected ? t.selected : t.surface).text_color(selected ? t.foreground : t.muted).text_size(12)
    .cursor_pointer().hover((el) => el.bg(t.hover))
    .on_mouse_down("left", (_event, cx) => cx.stop_propagation())
    .on_click((_event, cx) => { cx.stop_propagation(); callback(cx); })
    .child(label);
}

function row() { return h_flex().gap(8).items_center(); }
function section(title, t) {
  return v_flex().min_w(0).gap(12).p(16).rounded(12).border(1).border_color(t.border).bg(t.background)
    .child(text(title, t.foreground, 13).font_semibold());
}
function chip(label, color, t) {
  return h_flex().flex_none().h(24).px(9).gap(6).items_center().rounded(12).bg(t.raised)
    .child(div().size(5).rounded(3).bg(color)).child(text(label, color, 11).font_semibold());
}
function emptyState(title, detail, t, color = t.muted) {
  return h_flex().gap(12).items_center().p(16).rounded(10).bg(t.background)
    .child(div().w(3).h(32).rounded(2).bg(color))
    .child(v_flex().flex_1().min_w(0).gap(5).child(text(title, t.foreground, 13).font_semibold()).child(text(detail, t.muted, 11)));
}
function errorText(value, t, locale) { return text(messageText(value, locale), t.ansi1); }
function pct(value, locale) { return Number.isFinite(value) ? `${value.toFixed(1)}%` : translate(locale, "ui.preparing"); }
function bytes(value) {
  if (!Number.isFinite(value)) return "—";
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GiB`;
  return `${(value / 1024 ** 2).toFixed(0)} MiB`;
}
function date(value, locale) {
  const stamp = new Date(value);
  if (!value || !Number.isFinite(stamp.getTime())) return translate(locale, "ui.notYet");
  const pad = (part) => String(part).padStart(2, "0");
  return `${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())} ${pad(stamp.getHours())}:${pad(stamp.getMinutes())}:${pad(stamp.getSeconds())}`;
}
function ruleLabel(rule, locale) { const key = RULES.find(([id]) => id === rule)?.[1]; return key ? translate(locale, key) : rule; }
function machineLabel(view, machine) { return machine === "*" ? tr(view, "ui.allMachines") : machine === "local" ? tr(view, "ui.thisComputer") : (view.machineOptions ?? []).find((item) => item.id === machine)?.label ?? machine; }
function machineOptions(view) {
  const options = new Map([["local", { id: "local", label: tr(view, "ui.thisComputer"), available: true }]]);
  for (const option of view.machineOptions ?? []) options.set(option.id, { ...option, label: option.id === "local" ? tr(view, "ui.thisComputer") : option.label });
  for (const id of view.config?.targets ?? []) if (!options.has(id)) options.set(id, { id, label: id, available: false });
  return [...options.values()];
}
function untilFor(duration) {
  const now = Date.now();
  if (duration === "permanent") return 0;
  if (duration === "today") { const end = new Date(now); end.setHours(24, 0, 0, 0); return end.getTime(); }
  return now + (duration === "30m" ? 30 : 60) * 60_000;
}
function validProcess(name) { return name.length > 0 && name !== "." && name !== ".." && !/[\/\\\u0000-\u001f\u007f]/.test(name); }
function numericError(field, raw) {
  const [, , min, max, integer, , exclusive] = field;
  const value = Number(raw);
  if (!raw.trim() || !Number.isFinite(value)) return message("ui.numberRequired");
  if (value < min || (exclusive && value === min) || value > max) return message(exclusive ? "ui.exclusiveRange" : "ui.range", { min, max });
  if (integer && !Number.isInteger(value)) return message("ui.integerRequired");
  return "";
}
function input(view, key, t, width) {
  const ui = view.healthUI;
  return Input.new(ui.inputs[key]).id(`hw-input-${key}`).h(34).when(Boolean(width), (el) => el.w(width))
    .px(10).rounded(7).border(1).border_color(ui.errors[key] ? t.ansi1 : t.input)
    .bg(t.surface).text_color(t.foreground).text_size(13)
    .on_mouse_down("left", (_event, cx) => cx.stop_propagation());
}
function makeInput(view, key, value, placeholder, numeric) {
  const ui = view.healthUI;
  const state = InputState.new({ value: String(value ?? ""), placeholder: tr(view, placeholder) });
  state.on("change", (_event, cx) => {
    ui.errors[key] = numeric ? numericError(numeric, state.value()) : "";
    ui.message = "";
    ui.saveError = "";
    if (numeric) ui.dirty = true;
    cx.notify();
  });
  ui.inputs[key] = state;
}

export function initUI(view, _cx) {
  const config = view.config ?? defaultConfig();
  view.selectedMachine = view.selectedMachine ?? "local";
  view.healthUI = {
    tab: "overview", inputs: {}, errors: {}, dirty: false, saveError: "", message: "", inputLocale: null,
    language: config.language ?? "auto", desktop: config.desktop, recovery: config.recovery, criticalSound: config.criticalSound,
    targets: [...config.targets], watchedProcesses: [...config.watchedProcesses],
    exceptionMachine: view.selectedMachine, exceptionRule: "cpu", exceptionDuration: "permanent",
    historyMachine: "*", processesMachine: null,
  };
  syncUILocale(view);
}

export function syncUILocale(view) {
  const ui = view.healthUI;
  if (!ui) return;
  const config = view.config ?? defaultConfig();
  if (!ui.dirty) ui.language = config.language ?? "auto";
  if (ui.inputLocale === view.locale) return;
  for (const field of FIELDS) {
    const old = ui.inputs[field[0]];
    const value = old ? old.value() : field[0] === "intervalSeconds" ? config.intervalSeconds : config.thresholds[field[0]];
    makeInput(view, field[0], value, "ui.numberPlaceholder", field);
    old?.release();
  }
  for (const [key, placeholder] of Object.entries(PLACEHOLDERS)) {
    const old = ui.inputs[key];
    makeInput(view, key, old?.value() ?? "", placeholder);
    old?.release();
  }
  ui.inputLocale = view.locale;
}

function act(view, kind, payload, cx) {
  try {
    const result = view.action(kind, payload, cx);
    view.healthUI.saveError = result?.ok === false ? result.error : "";
  } catch (error) {
    view.healthUI.saveError = errorMessage(view.locale, error);
  }
  cx.notify();
}

function selectMachine(view, machine, cx) {
  view.selectedMachine = machine;
  view.healthUI.processesMachine = null;
  act(view, "selectMachine", { machine }, cx);
}

function resetDraft(view, cx) {
  const ui = view.healthUI;
  const config = view.config;
  for (const field of FIELDS) ui.inputs[field[0]].set_value(String(field[0] === "intervalSeconds" ? config.intervalSeconds : config.thresholds[field[0]]));
  ui.language = config.language ?? "auto";
  ui.desktop = config.desktop;
  ui.recovery = config.recovery;
  ui.criticalSound = config.criticalSound;
  ui.targets = [...config.targets];
  ui.watchedProcesses = [...config.watchedProcesses];
  ui.errors = {};
  ui.dirty = false;
  ui.saveError = "";
  ui.message = "ui.settingsReloaded";
  cx.notify();
}

function saveDraft(view, cx) {
  const ui = view.healthUI;
  const config = { ...view.config, thresholds: { ...view.config.thresholds }, language: ui.language, desktop: ui.desktop, recovery: ui.recovery, criticalSound: ui.criticalSound, targets: [...ui.targets], watchedProcesses: [...ui.watchedProcesses] };
  let invalid = false;
  for (const field of FIELDS) {
    const key = field[0];
    ui.errors[key] = numericError(field, ui.inputs[key].value());
    if (ui.errors[key]) invalid = true;
    else if (key === "intervalSeconds") config.intervalSeconds = Number(ui.inputs[key].value());
    else config.thresholds[key] = Number(ui.inputs[key].value());
  }
  const pairs = [["cpuClear", "cpuWarn", "ui.cpuOrder"], ["memWarn", "memCritical", "ui.memoryOrder"], ["diskWarnPct", "diskCriticalPct", "ui.diskPctOrder"], ["diskCriticalFreeGiB", "diskWarnFreeGiB", "ui.diskFreeOrder"]];
  for (const [lower, upper, key] of pairs) {
    if (!ui.errors[lower] && !ui.errors[upper] && config.thresholds[lower] >= config.thresholds[upper]) {
      ui.errors[lower] = message(key);
      invalid = true;
    }
  }
  if (invalid) { ui.saveError = message("ui.fixErrors"); ui.message = ""; cx.notify(); return; }
  try {
    const normalized = normalizeConfig(config);
    const result = view.action("saveConfig", normalized, cx);
    if (result?.ok === false) {
      ui.saveError = result.error;
      ui.message = "";
    } else {
      ui.dirty = false;
      ui.saveError = "";
      ui.message = "ui.settingsSaved";
      syncUILocale(view);
    }
  } catch (error) {
    ui.saveError = errorMessage(view.locale, error);
    for (const field of FIELDS) if (ui.saveError.includes(field[0])) ui.errors[field[0]] = ui.saveError;
  }
  cx.notify();
}

function addWatched(view, cx) {
  const ui = view.healthUI;
  const name = ui.inputs.watchedProcess.value().trim();
  if (!validProcess(name)) ui.errors.watchedProcess = message("ui.processBasename");
  else if (ui.watchedProcesses.includes(name)) ui.errors.watchedProcess = message("ui.processDuplicate");
  else {
    ui.watchedProcesses.push(name);
    ui.inputs.watchedProcess.set_value("");
    ui.errors.watchedProcess = "";
    ui.dirty = true;
    ui.message = "ui.saveToWatch";
  }
  cx.notify();
}

function addExclusion(view, target, duration, reasonKey, cx) {
  const ui = view.healthUI;
  const reason = ui.inputs[reasonKey].value().trim();
  if (duration === "permanent" && !reason) {
    ui.errors[reasonKey] = message("ui.reasonRequired");
    cx.notify();
    return;
  }
  if (target.rule === "process" && target.resource && !validProcess(target.resource)) {
    ui.errors.exceptionResource = message("ui.processBasename");
    cx.notify();
    return;
  }
  ui.errors[reasonKey] = "";
  act(view, "exclude", { ...target, until: untilFor(duration), reason }, cx);
}

function stale(view, state) {
  return Boolean(state?.sample) && Date.now() - (state.lastSuccess || 0) > Math.max(3 * view.config.intervalSeconds, 30) * 1000;
}

function status(view, machine) {
  const state = view.state?.machines?.[machine];
  const alerts = Object.values(state?.alerts ?? {});
  if (!(view.config?.targets ?? []).includes(machine)) return [tr(view, "ui.monitoringOff"), "muted"];
  if ((view.machineOptions ?? []).some((option) => option.id === machine && option.available === false)) return [tr(view, "ui.unavailable"), "ansi1"];
  if (state?.error) return [tr(view, "ui.collectionError"), "ansi1"];
  if (alerts.some((alert) => alert.level === "critical" && !isExcluded(view.config, machine, alert.rule, alert.resource, Date.now()))) return [tr(view, "ui.critical"), "ansi1"];
  if (alerts.some((alert) => !isExcluded(view.config, machine, alert.rule, alert.resource, Date.now()))) return [tr(view, "ui.warning"), "ansi3"];
  if (alerts.length) return [tr(view, "ui.excluded"), "muted"];
  if (stale(view, state)) return [tr(view, "ui.stale"), "ansi3"];
  if (!state?.sample) return [tr(view, "ui.waiting"), "muted"];
  return [tr(view, "ui.normal"), "ansi2"];
}

export function renderBar(view, _cx) {
  const t = theme();
  const machine = view.selectedMachine ?? "local";
  const sample = view.state?.machines?.[machine]?.sample;
  const statuses = (view.config.targets ?? []).map((id) => status(view, id));
  const rank = { ansi1: 3, ansi3: 2, muted: 1, ansi2: 0 };
  const worst = statuses.reduce((a, b) => rank[b[1]] > rank[a[1]] ? b : a, statuses[0] ?? [tr(view, "ui.monitoringOff"), "muted"]);
  const [label, color] = view.runtimeError ? [tr(view, "ui.error"), "ansi1"] : worst;
  const count = (view.config.targets ?? []).reduce((sum, id) => sum + Object.keys(view.state?.machines?.[id]?.alerts ?? {}).length, 0);
  return h_flex().id("health-watch-bar").h(28).w(270).px(10).gap(8).items_center()
    .bg(t.chrome).text_size(11).text_color(t.foreground).cursor_pointer()
    .hover((el) => el.bg(t.hover)).on_click((_event, cx) => { cx.stop_propagation(); view.open(); })
    .child(div().size(6).rounded(3).bg(t[color]))
    .child(text(tr(view, "ui.barTitle"), t.foreground, 11).font_semibold())
    .child(text(label, t[color], 10))
    .child(div().w(1).h(12).bg(t.border))
    .child(div().flex_1().min_w(0).truncate().text_size(10).child(sample ? tr(view, "ui.barMetrics", { cpu: sample.cpu === null ? "…" : Math.round(sample.cpu) + "%", memory: Math.round(sample.memoryPct), count: count ? tr(view, "ui.barCount", { count }) : "" }) : tr(view, "ui.viewStatus")));
}

function machinePicker(view, t) {
  return h_flex().id("hw-machine-picker").gap(6).flex_wrap().items_center()
    .child(text(tr(view, "ui.machine"), t.muted))
    .children(machineOptions(view).map((option) => button(`hw-machine-${option.id}`, `${option.label}${option.available === false ? ` · ${tr(view, "ui.unavailable")}` : ""}`, (cx) => selectMachine(view, option.id, cx), t, view.selectedMachine === option.id)));
}

function meter(label, value, amount, t, danger) {
  const fraction = Number.isFinite(amount) ? Math.min(100, Math.max(0, amount)) : 0;
  return v_flex().min_w(0).gap(10).p(14).rounded(10).bg(t.background).border(1).border_color(t.border)
    .child(row().justify_between().child(text(label, t.muted, 11)).child(text(value, danger ? t.ansi3 : t.foreground, 13).font_semibold()))
    .child(div().h(4).w_full().rounded(2).bg(t.raised).child(div().h(4).w(`${fraction}%`).rounded(2).bg(danger ? t.ansi3 : t.accent)));
}
function metricCard(label, value, detail, amount, t, color = t.accent) {
  const fraction = Number.isFinite(amount) ? Math.min(100, Math.max(0, amount)) : 0;
  return v_flex().flex_1().min_w(0).min_h(146).gap(10).p(16).rounded(12).border(1).border_color(t.border).bg(t.background)
    .child(row().justify_between().child(text(label, t.muted, 11).font_semibold()).child(div().size(5).rounded(3).bg(color)))
    .child(text(value, t.foreground, 28).font_semibold())
    .child(text(detail, t.muted, 11))
    .when(Number.isFinite(amount), (el) => el.child(div().h(3).w_full().rounded(2).bg(t.raised)
      .child(div().h(3).w(`${fraction}%`).rounded(2).bg(color))));
}

function alertCard(view, alert, t) {
  const excluded = isExcluded(view.config, alert.machine, alert.rule, alert.resource, Date.now());
  const target = { machine: alert.machine, rule: alert.rule, resource: alert.resource };
  const localized = eventText(view.locale, alert);
  return v_flex().gap(10).p(14).rounded(10).border(1).border_color(excluded ? t.border : alert.level === "critical" ? t.ansi1 : t.ansi3).bg(t.background)
    .child(row().flex_wrap().justify_between().child(text(localized.title, t.foreground, 14).flex_1().font_semibold()).child(chip(`${excluded ? `${tr(view, "ui.excluded")} · ` : ""}${tr(view, alert.level === "critical" ? "ui.critical" : "ui.warning")}${alert.acknowledged ? ` · ${tr(view, "ui.acknowledged")}` : ""}`, excluded ? t.muted : alert.level === "critical" ? t.ansi1 : t.ansi3, t)))
    .child(text(localized.body, t.foreground))
    .child(text(`${ruleLabel(alert.rule, view.locale)}${alert.resource ? ` · ${alert.resource}` : ""} · ${tr(view, "ui.since", { date: date(alert.since, view.locale) })}`, t.muted, 11))
    .child(h_flex().gap(6).flex_wrap()
      .child(button(`hw-ack-${alert.key}`, tr(view, alert.acknowledged ? "ui.acknowledged" : "ui.acknowledge"), (cx) => act(view, "ack", { machine: alert.machine, key: alert.key }, cx), t, alert.acknowledged))
      .children(["30m", "1h", "today", "permanent"].map((duration) => button(`hw-snooze-${alert.key}-${duration}`, tr(view, `ui.snooze.${duration}`), (cx) => addExclusion(view, target, duration, "alertReason", cx), t))));
}

function delivery(view, t) {
  const item = view.delivery ?? {};
  const status = ["success", "delivered"].includes(item.status) ? "sent" : ["idle", "sending", "sent", "error", "disabled", "unavailable"].includes(item.status) ? item.status : "idle";
  return v_flex().gap(8).px(2).py(10)
    .child(row().flex_wrap().justify_between()
      .child(row().child(div().size(5).rounded(3).bg(item.error ? t.ansi1 : t.muted)).child(text(tr(view, "ui.notificationConnection"), t.foreground, 12).font_semibold()))
      .child(button("hw-test-notification", tr(view, "ui.testNotification"), (cx) => act(view, "testNotification", {}, cx), t)))
    .child(text(tr(view, `ui.delivery.${status}`), item.error ? t.ansi1 : t.muted, 11))
    .when(Boolean(item.error), (el) => el.child(errorText(item.error, t, view.locale)))
    .child(text(tr(view, "ui.notificationHelp"), t.muted, 11));
}

function overview(view, t) {
  const ui = view.healthUI;
  const machine = view.selectedMachine;
  const state = view.state?.machines?.[machine];
  const sample = state?.sample;
  const [label, color] = status(view, machine);
  const alerts = Object.values(state?.alerts ?? {}).sort((a, b) => (a.level === "critical" ? 0 : 1) - (b.level === "critical" ? 0 : 1));
  const content = v_flex().gap(14);
  content.child(v_flex().gap(7).py(4)
    .child(row().flex_wrap().justify_between()
      .child(row().flex_wrap().gap(10).child(text(machineLabel(view, machine), t.foreground, 20).font_semibold()).child(chip(label, t[color], t)))
      .child(text(sample ? tr(view, "ui.systemCores", { os: sample.os === "darwin" ? "macOS" : "Linux", count: sample.cores ?? "?" }) : tr(view, "ui.preparing"), t.muted, 11)))
    .child(text(`${tr(view, "ui.lastCollection", { date: date(state?.lastSuccess, view.locale) })}${sample ? ` · ${sample.collectionMs}ms` : ""}`, t.muted, 11))
    .when(stale(view, state), (el) => el.child(text(tr(view, "ui.staleHelp"), t.ansi3)))
    .when(Boolean(state?.error), (el) => el.child(errorText(tr(view, "ui.collectionFailures", { error: state.error, count: state.failures ?? 0 }), t, view.locale)))
    .when(Boolean(sample && (state?.error || !(view.config?.targets ?? []).includes(machine))), (el) => el.child(text(tr(view, "ui.lastSuccessHelp"), t.ansi3)))
    .when(!(view.config?.targets ?? []).includes(machine), (el) => el.child(text(tr(view, "ui.monitoringOffHelp"), t.muted))));
  if (alerts.length) content.child(section(tr(view, "ui.alertsCount", { count: alerts.length }), t)
    .child(text(tr(view, "ui.alertHelp"), t.muted, 11))
    .child(input(view, "alertReason", t))
    .when(Boolean(ui.errors.alertReason), (el) => el.child(errorText(ui.errors.alertReason, t, view.locale)))
    .children(alerts.map((alert) => alertCard(view, alert, t))));
  if (sample) {
    const pressure = tr(view, ["normal", "warning", "critical"].includes(sample.pressure) ? `ui.${sample.pressure}` : "ui.notAvailable");
    const memoryColor = sample.os === "darwin" ? (sample.pressure === "critical" ? t.ansi1 : sample.pressure === "warning" ? t.ansi3 : t.accent)
      : sample.memoryPct >= view.config.thresholds.memCritical ? t.ansi1 : sample.memoryPct >= view.config.thresholds.memWarn ? t.ansi3 : t.accent;
    content.child(h_flex().gap(10).items_start()
      .child(metricCard(tr(view, "ui.cpu"), pct(sample.cpu, view.locale), tr(view, "ui.allCores"), sample.cpu, t, sample.cpu >= view.config.thresholds.cpuWarn ? t.ansi3 : t.accent))
      .child(metricCard(tr(view, "ui.memory"), pct(sample.memoryPct, view.locale), tr(view, "ui.memoryPressure", { pressure }), sample.memoryPct, t, memoryColor))
      .child(metricCard(tr(view, "ui.swap"), bytes(sample.swapUsedBytes), tr(view, "ui.swapHelp"), null, t, t.muted)));
    content.children((sample.disks ?? []).map((disk) => meter(`${tr(view, "ui.storage")} · ${disk.mount}`, tr(view, "ui.diskUsage", { used: pct(disk.pct, view.locale), free: bytes(disk.freeBytes) }), disk.pct, t,
      disk.pct >= view.config.thresholds.diskWarnPct || disk.freeBytes <= view.config.thresholds.diskWarnFreeGiB * 1024 ** 3)));
  } else content.child(emptyState(tr(view, "ui.waitFirstSample"), tr(view, "ui.firstSampleHelp"), t));
  if (!alerts.length) content.child(emptyState(tr(view, "ui.noAlerts"), tr(view, "ui.noAlertsHelp"), t, color === "ansi2" ? t.ansi2 : t.muted));
  const processSection = section(tr(view, "ui.process"), t)
    .child(row().flex_wrap().justify_between().child(text(tr(view, "ui.processHelp"), t.muted, 11))
      .child(button("hw-load-processes", tr(view, "ui.loadProcesses"), (cx) => { ui.processesMachine = machine; act(view, "processes", { machine }, cx); }, t)));
  if (ui.processesMachine === machine) {
    if (view.processError) processSection.child(errorText(view.processError, t, view.locale));
    if (!(view.processes ?? []).length && !view.processError) processSection.child(text(tr(view, "ui.noProcesses"), t.muted));
    for (const proc of view.processes ?? []) processSection.child(row().justify_between().py(5)
      .child(v_flex().flex_1().min_w(0).gap(3).child(text(proc.name, t.foreground)).child(text(`PID ${proc.pid}`, t.muted, 10)))
      .child(text(`${pct(proc.cpu, view.locale)} CPU · ${bytes(proc.memoryBytes)}`, t.muted)));
  }
  return content.child(processSection).child(delivery(view, t));
}

function settings(view, t) {
  const ui = view.healthUI;
  const changed = (cx) => { ui.dirty = true; ui.message = ""; ui.saveError = ""; cx.notify(); };
  const content = v_flex().gap(12);
  content.child(section(tr(view, "ui.settingsTitle"), t)
    .child(text(tr(view, "ui.settingsHelp"), t.muted, 11))
    .child(text(tr(view, "ui.language"), t.muted, 11).font_semibold())
    .child(h_flex().gap(6).flex_wrap().children(LANGUAGES.map(([id, label]) => button(`hw-language-${id}`, id === "auto" ? tr(view, label) : label, (cx) => { ui.language = id; changed(cx); }, t, ui.language === id))))
    .child(text(tr(view, "ui.languageHelp"), t.muted, 11))
    .child(h_flex().gap(6).flex_wrap().children(["desktop", "recovery", "criticalSound"].map((key) => button(`hw-flag-${key}`, `${ui[key] ? "✓" : "○"} ${tr(view, `ui.${key}`)}`, (cx) => { ui[key] = !ui[key]; changed(cx); }, t, ui[key])))));
  content.child(section(tr(view, "ui.monitoredMachines"), t)
    .child(text(tr(view, "ui.remoteHelp"), t.muted, 11))
    .child(h_flex().gap(6).flex_wrap().children(machineOptions(view).map((option) => button(`hw-target-${option.id}`, `${ui.targets.includes(option.id) ? "✓" : "○"} ${option.label}${option.available === false ? ` · ${tr(view, "ui.unavailable")}` : ""}`, (cx) => {
      ui.targets = ui.targets.includes(option.id) ? ui.targets.filter((id) => id !== option.id) : [...ui.targets, option.id];
      changed(cx);
    }, t, ui.targets.includes(option.id)))))
    .when(!ui.targets.length, (el) => el.child(text(tr(view, "ui.disableAllHelp"), t.ansi3))));
  const groups = [...new Set(FIELDS.map((field) => field[5]))];
  const fieldGroup = (group) => {
    const block = section(tr(view, "ui.thresholdGroup", { group: tr(view, group) }), t).flex_1().min_w(0);
    for (const field of FIELDS.filter((item) => item[5] === group)) block.child(v_flex().min_w(0).gap(5)
      .child(text(tr(view, field[1]), t.muted, 11))
      .child(input(view, field[0], t))
      .when(Boolean(ui.errors[field[0]]), (el) => el.child(errorText(ui.errors[field[0]], t, view.locale))));
    return block;
  };
  for (let i = 0; i < groups.length; i += 2) {
    const pair = h_flex().gap(12).items_start().child(fieldGroup(groups[i]));
    if (groups[i + 1]) pair.child(fieldGroup(groups[i + 1]));
    else pair.child(div().flex_1());
    content.child(pair);
  }
  const watched = section(tr(view, "ui.watchedProcesses"), t)
    .child(text(tr(view, "ui.watchedHelp"), t.muted, 11))
    .child(row().child(input(view, "watchedProcess", t).flex_1().min_w(0)).child(button("hw-add-process", tr(view, "ui.addName"), (cx) => addWatched(view, cx), t)))
    .when(Boolean(ui.errors.watchedProcess), (el) => el.child(errorText(ui.errors.watchedProcess, t, view.locale)));
  for (const name of ui.watchedProcesses) watched.child(row().justify_between().child(text(name, t.foreground).flex_1())
    .child(button(`hw-remove-process-${name}`, tr(view, "ui.delete"), (cx) => { ui.watchedProcesses = ui.watchedProcesses.filter((item) => item !== name); changed(cx); }, t)));
  if (!ui.watchedProcesses.length) watched.child(text(tr(view, "ui.noWatchedProcesses"), t.muted));
  return content.child(watched).child(delivery(view, t));
}

function exceptions(view, t) {
  const ui = view.healthUI;
  const form = section(tr(view, "ui.addException"), t)
    .child(text(tr(view, "ui.exceptionHelp"), t.muted, 11))
    .child(text(tr(view, "ui.targetMachine"), t.muted, 11).font_semibold())
    .child(h_flex().gap(6).flex_wrap().children([{ id: "*", label: tr(view, "ui.allMachines") }, ...machineOptions(view)].map((option) => button(`hw-ex-machine-${option.id}`, option.label, (cx) => { ui.exceptionMachine = option.id; cx.notify(); }, t, ui.exceptionMachine === option.id))))
    .child(text(tr(view, "ui.excludedRule"), t.muted, 11).font_semibold())
    .child(h_flex().gap(6).flex_wrap().children(RULES.map(([id, key]) => button(`hw-ex-rule-${id}`, tr(view, key), (cx) => { ui.exceptionRule = id; ui.errors.exceptionResource = ""; cx.notify(); }, t, ui.exceptionRule === id))))
    .when(ui.exceptionRule === "disk" || ui.exceptionRule === "process", (el) => el
      .child(text(tr(view, ui.exceptionRule === "disk" ? "ui.mountHelp" : "ui.processResourceHelp"), t.foreground))
      .child(input(view, "exceptionResource", t))
      .when(Boolean(ui.errors.exceptionResource), (child) => child.child(errorText(ui.errors.exceptionResource, t, view.locale))))
    .child(text(tr(view, "ui.duration"), t.muted, 11).font_semibold())
    .child(h_flex().gap(6).flex_wrap().children(["30m", "1h", "today", "permanent"].map((id) => button(`hw-ex-duration-${id}`, tr(view, `ui.duration.${id}`), (cx) => { ui.exceptionDuration = id; cx.notify(); }, t, ui.exceptionDuration === id))))
    .child(text(tr(view, "ui.exceptionReason"), t.muted, 11).font_semibold())
    .child(input(view, "exceptionReason", t))
    .when(Boolean(ui.errors.exceptionReason), (el) => el.child(errorText(ui.errors.exceptionReason, t, view.locale)))
    .child(row().justify_end().child(button("hw-create-exception", tr(view, "ui.addException"), (cx) => addExclusion(view, { machine: ui.exceptionMachine, rule: ui.exceptionRule, resource: ["disk", "process"].includes(ui.exceptionRule) ? ui.inputs.exceptionResource.value().trim() : "" }, ui.exceptionDuration, "exceptionReason", cx), t, true)));
  const list = section(tr(view, "ui.exceptionsCount", { count: (view.config.exclusions ?? []).length }), t);
  for (const exclusion of view.config.exclusions ?? []) {
    const expired = exclusion.until > 0 && exclusion.until <= Date.now();
    list.child(v_flex().gap(5).p(9).border(1).border_color(t.border).rounded(6)
      .child(row().justify_between().child(text(`${machineLabel(view, exclusion.machine)} · ${ruleLabel(exclusion.rule, view.locale)} · ${exclusion.resource || tr(view, "ui.allResources")}`, t.foreground).flex_1())
        .child(button(`hw-delete-ex-${exclusion.id}`, tr(view, "ui.delete"), (cx) => act(view, "removeExclusion", { id: exclusion.id }, cx), t)))
      .child(text(tr(view, "ui.reasonValue", { reason: exclusion.reason || tr(view, "ui.none") }), t.foreground))
      .child(text(exclusion.until === 0 ? tr(view, "ui.permanentHelp") : tr(view, expired ? "ui.expiredAt" : "ui.expiresAt", { date: date(exclusion.until, view.locale) }), expired ? t.muted : t.accent, 11)));
  }
  if (!(view.config.exclusions ?? []).length) list.child(emptyState(tr(view, "ui.noExceptions"), tr(view, "ui.noExceptionsHelp"), t));
  return v_flex().gap(12).child(form).child(list);
}

function history(view, t) {
  const ui = view.healthUI;
  const events = (view.state?.history ?? []).filter((event) => ui.historyMachine === "*" || event.machine === ui.historyMachine);
  const content = v_flex().gap(12)
    .child(h_flex().gap(6).flex_wrap().children([{ id: "*", label: tr(view, "ui.allMachines") }, ...machineOptions(view)].map((option) => button(`hw-history-machine-${option.id}`, option.label, (cx) => { ui.historyMachine = option.id; cx.notify(); }, t, ui.historyMachine === option.id))))
    .child(text(tr(view, "ui.historyCount", { count: events.length }), t.muted));
  for (const event of events) {
    const color = event.level === "recovery" ? t.ansi2 : event.level === "critical" ? t.ansi1 : t.ansi3;
    const localized = eventText(view.locale, event);
    content.child(h_flex().gap(12).items_start()
      .child(v_flex().w(12).items_center().pt(7).gap(6).child(div().size(7).rounded(4).bg(color)).child(div().w(1).h(60).bg(t.border)))
      .child(section(localized.title, t).flex_1()
        .child(row().flex_wrap().justify_between().child(chip(tr(view, event.level === "recovery" ? "ui.recovered" : event.level === "critical" ? "ui.critical" : "ui.warning"), color, t)).child(text(date(event.at, view.locale), t.muted, 11)))
        .child(text(localized.body, t.foreground))
        .child(text(`${machineLabel(view, event.machine)} · ${ruleLabel(event.rule, view.locale)}${event.resource ? ` · ${event.resource}` : ""}`, t.muted, 11))));
  }
  if (!events.length) content.child(emptyState(tr(view, "ui.noHistory"), tr(view, "ui.noHistoryHelp"), t, t.accent));
  return content;
}

export function renderPanel(view, _cx) {
  const t = theme();
  const ui = view.healthUI;
  const body = ui.tab === "settings" ? settings(view, t) : ui.tab === "exceptions" ? exceptions(view, t) : ui.tab === "history" ? history(view, t) : overview(view, t);
  return v_flex().id("health-watch-panel").w(780).h(680).p(20).gap(14).bg(t.surface).text_color(t.foreground).text_size(12)
    .child(row().flex_none().justify_between()
      .child(row().min_w(0).gap(12)
        .child(h_flex().size(38).gap(3).items_center().justify_center().rounded(10).bg(t.selected)
          .children([10, 22, 15].map((height) => div().w(3).h(height).rounded(2).bg(t.accent))))
        .child(v_flex().min_w(0).gap(3).child(text(tr(view, "ui.title"), t.foreground, 21).font_semibold()).child(text(tr(view, "ui.subtitle"), t.muted, 11))))
      .child(row().flex_none().child(button("hw-refresh", tr(view, "ui.refresh"), (cx) => act(view, "refresh", {}, cx), t))
        .child(button("hw-close", tr(view, "ui.close"), () => view.closePanel(), t))))
    .child(v_flex().flex_none().gap(8)
      .child(h_flex().flex_wrap().p(4).gap(4).rounded(10).bg(t.background).children(TABS.map(([id, key]) => button(`hw-tab-${id}`, tr(view, key), (cx) => { ui.tab = id; cx.notify(); }, t, ui.tab === id))))
      .child(machinePicker(view, t)))
    .child(div().h(1).w_full().flex_none().bg(t.border))
    .when(Boolean(view.runtimeError), (el) => el.child(errorText(view.runtimeError, t, view.locale).flex_none()))
    .when(Boolean(view.actionError), (el) => el.child(errorText(view.actionError, t, view.locale).flex_none()))
    .when(Boolean(ui.saveError), (el) => el.child(errorText(ui.saveError, t, view.locale).flex_none()))
    .when(Boolean(ui.message), (el) => el.child(text(tr(view, ui.message), t.accent).flex_none()))
    .child(v_flex().id(`hw-scroll-${ui.tab}`).h(474).flex_1().min_h(0).overflow_y_scrollbar().gap(14).pr(4).child(body.flex_none()))
    .child(row().flex_none().h(ui.tab === "settings" ? 34 : 20).justify_between()
      .child(text(ui.tab === "settings" ? tr(view, ui.dirty ? "ui.unsaved" : "ui.allSaved") : tr(view, "ui.monitoringSummary", { seconds: view.config.intervalSeconds, count: view.config.targets.length }), ui.dirty && ui.tab === "settings" ? t.ansi3 : t.muted, 11).flex_1())
      .when(ui.tab === "settings", (el) => el.child(row()
        .child(button("hw-reset-settings", tr(view, "ui.cancelChanges"), (cx) => resetDraft(view, cx), t))
        .child(button("hw-save-settings", tr(view, "ui.saveSettings"), (cx) => saveDraft(view, cx), t, true)))));
}
