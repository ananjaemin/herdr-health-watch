import { exec } from 'herdr';
import { PROBE, PROCESS_PROBE, VITALS_CONFIG, parseProbe, parseProcesses } from './probe.js';
import { issue, errorMessage } from './i18n.js';

export async function collect(machine, config, locale = 'en') {
  const started = Date.now();
  try {
    const r = await exec('sh', ['-c', PROBE, 'health-watch', VITALS_CONFIG, config.watchedProcesses.length ? '1' : '0'],
      { on: machine === 'local' ? null : machine, timeout: 8000 });
    if (r.code !== 0) {
      const key = { 41: 'error.vitalsMissing', 42: 'error.vitalsConfig', 43: 'error.os' }[r.code];
      throw key ? issue(key) : r.stderr.trim() ? new Error(r.stderr.trim()) : issue('error.collectorExit', { code: r.code });
    }
    return { machine, sample: parseProbe(r.stdout, Date.now(), Date.now() - started) };
  } catch (error) {
    return { machine, error: errorMessage(locale, error).slice(0, 400),
      errorDescriptor: error?.messageKey ? { key: error.messageKey, params: error.messageParams } : null };
  }
}
export async function listProcesses(machine, cores) {
  const r = await exec('sh', ['-c', PROCESS_PROBE], { on: machine === 'local' ? null : machine, timeout: 5000 });
  if (r.code !== 0) throw r.stderr.trim() ? new Error(r.stderr.trim()) : issue('error.processes');
  return parseProcesses(r.stdout, cores).slice(0, 20);
}
