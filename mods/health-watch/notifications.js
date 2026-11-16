import { exec, appHome, notify } from 'herdr';
import { eventText, t, issue, errorMessage } from './i18n.js';
import { notificationArgs, DISCOVER_NOTIFIER } from './notification-command.js';

export async function deliver(event, config, locale = 'en') {
  const text = eventText(locale, event);
  notify({ title: `Health Watch · ${text.title}`, body: `${event.machine === 'local' ? t(locale, 'machine.local') : event.machine}: ${text.body}`,
    level: event.level === 'critical' ? 'error' : event.level === 'recovery' ? 'success' : 'warning', timeout: 10000,
    action: { name: `health-watch.open~${encodeURIComponent(event.machine)}` } });
  if (!config.desktop) return { status: 'disabled', error: '' };
  try {
    const found = await exec('sh', ['-c', DISCOVER_NOTIFIER], { timeout: 2000 });
    if (found.code === 43) throw issue('error.hostOS');
    if (found.code !== 0) throw issue('error.notifier');
    const [os, tool, cli] = found.stdout.trim().split('\n');
    if (!tool) throw issue('error.notifier');
    const r = await exec(tool, notificationArgs(event, config, locale, os, appHome(), cli), { timeout: 5000 });
    if (r.code !== 0) throw r.stderr.trim() ? new Error(r.stderr.trim()) : issue('error.notifierExit', { code: r.code });
    return { status: 'sent', error: '' };
  } catch (error) {
    return { status: 'error', error: errorMessage(locale, error), errorKey: error?.messageKey, errorParams: error?.messageParams };
  }
}
