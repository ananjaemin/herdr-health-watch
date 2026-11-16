import { View } from 'gpui-kit';
import { checking, props, openOverlay, closeOverlay, nextCommand } from 'herdr';
import { snapshot, tick, saveConfig, acknowledge, addExclusion, removeExclusion, testNotification } from './runtime.js';
import { listProcesses } from './collector.js';
import { initUI, syncUILocale, renderBar, renderPanel } from './ui.js';
import { loadEnvironment } from './environment.js';
import { t, issue, errorMessage } from './i18n.js';

export default class HealthWatch extends View {
  init(_props, cx) {
    this.panel = props()?.view !== 'bar';
    this.selectedMachine = props()?.machine ?? 'local';
    this.processes = [];
    this.processError = '';
    this.processRequest = 0;
    this.actionError = '';
    this.closed = false;
    Object.assign(this, snapshot());
    initUI(this, cx);
    if (['overview', 'settings', 'exceptions', 'history'].includes(props()?.tab)) this.healthUI.tab = props().tab;
    if (checking()) return;
    cx.spawn(async (cx) => {
      await loadEnvironment();
      if (this.closed) return;
      Object.assign(this, snapshot());
      syncUILocale(this, cx);
      this.poll(cx);
      cx.notify();
    });
    // Five-second scheduling supports configurable >=5s reads. The shared due time
    // prevents additional reads from panel copies; no high-frequency redraw loop.
    cx.timer.every(5000, (cx) => this.poll(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (!this.panel && (command === 'open' || command.startsWith('open~'))) {
          const machine = command.startsWith('open~') ? decodeURIComponent(command.slice(5)) : this.selectedMachine;
          this.open(machine);
        } else if (!this.panel && ['overview', 'settings', 'exceptions', 'history'].includes(command)) this.open(this.selectedMachine, command);
        else if (command === 'close' && this.panel) this.closePanel();
        else if (command === 'test-notification' && !this.panel) this.action('testNotification', {}, cx);
        else if (command === 'refresh' && !this.panel) this.poll(cx, true);
        cx.notify();
      }
    });
  }
  poll(cx, force = false) {
    cx.spawn(async (cx) => {
      await tick(force);
      if (!this.closed) {
        Object.assign(this, snapshot());
        syncUILocale(this, cx);
        cx.notify();
      }
    });
  }
  open(machine = this.selectedMachine, tab = 'overview') {
    if (this.dialog) closeOverlay(this.dialog);
    this.dialog = openOverlay({ mod: 'health-watch', kind: 'dialog', width: 780, height: 680,
      props: { view: 'panel', machine, tab } });
  }
  closePanel() {
    if (props()?.overlay) closeOverlay(props().overlay);
  }
  close() { this.closed = true; this.processRequest++; }
  action(kind, payload, cx) {
    this.actionError = '';
    try {
      if (kind === 'saveConfig') { saveConfig(payload); this.poll(cx, true); }
      else if (kind === 'ack') acknowledge(payload.machine, payload.key);
      else if (kind === 'exclude') { addExclusion(payload); this.poll(cx, true); }
      else if (kind === 'removeExclusion') { removeExclusion(payload.id); this.poll(cx, true); }
      else if (kind === 'refresh') this.poll(cx, true);
      else if (kind === 'selectMachine') {
        this.selectedMachine = payload.machine;
        this.processRequest++;
        this.processes = [];
        this.processError = '';
      } else if (kind === 'processes') {
        const request = ++this.processRequest;
        const machine = payload.machine;
        const sample = snapshot().state.machines[machine]?.sample;
        if (!sample?.cores) throw issue('error.cores');
        this.processes = [];
        this.processError = t(this.locale, 'process.loading');
        cx.spawn(async (cx) => {
          try {
            const processes = await listProcesses(machine, sample.cores);
            if (this.closed || request !== this.processRequest || this.selectedMachine !== machine) return;
            this.processes = processes;
            this.processError = '';
          } catch (error) {
            if (request === this.processRequest && !this.closed) this.processError = errorMessage(this.locale, error);
          }
          cx.notify();
        });
      } else if (kind === 'testNotification') {
        cx.spawn(async (cx) => { await testNotification(this.selectedMachine); if (!this.closed) cx.notify(); });
      } else throw issue('error.action', { action: kind });
      Object.assign(this, snapshot());
      syncUILocale(this, cx);
      cx.notify();
      return { ok: true };
    } catch (error) {
      this.actionError = errorMessage(this.locale, error);
      cx.notify();
      return { ok: false, error: this.actionError };
    }
  }
  render(cx) {
    Object.assign(this, snapshot());
    return this.panel ? renderPanel(this, cx) : renderBar(this, cx);
  }
}
