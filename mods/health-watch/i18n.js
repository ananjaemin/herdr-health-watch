import { uiMessages } from './ui-messages.js';
import { systemMessages } from './system-messages.js';

export const SUPPORTED_LOCALES = ['en', 'ko', 'ja', 'zh-CN'];
export function resolveLocale(requested, systemLocale = 'en') {
  const value = String(!requested || requested === 'auto' ? systemLocale : requested).trim().replace(/_/g, '-').split(/[.@]/)[0].toLowerCase();
  if (/^ko(?:-|$)/.test(value)) return 'ko';
  if (/^ja(?:-|$)/.test(value)) return 'ja';
  if (value === 'zh' || /^zh-(?:cn|sg|hans)(?:-|$)/.test(value)) return 'zh-CN';
  return 'en';
}
export function t(locale, key, params = {}) {
  const language = resolveLocale(locale);
  const template = uiMessages[language]?.[key] ?? systemMessages[language]?.[key]
    ?? uiMessages.en[key] ?? systemMessages.en[key];
  if (typeof template !== 'string') throw new Error(`Unknown translation key: ${key}`);
  return template.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? `{${name}}`));
}
export function issue(key, params = {}, Kind = Error) {
  const error = new Kind(t('en', key, params));
  error.messageKey = key;
  error.messageParams = params;
  return error;
}
export function errorMessage(locale, error) {
  return error?.messageKey ? t(locale, error.messageKey, error.messageParams) : String(error?.message ?? error);
}
export function eventText(locale, event) {
  if (event.items) {
    return {
      title: t(locale, event.level === 'recovery' ? 'event.recoveries' : 'event.alerts', { count: event.items.length }),
      body: event.items.map((item) => { const text = eventText(locale, item); return `${text.title}: ${text.body}`; }).join('\n'),
    };
  }
  if (event.message?.title === 'event.test.title') {
    return { title: t(locale, 'event.test.title'), body: t(locale, 'event.test.body') };
  }
  const title = t(locale, `event.${event.rule}.title`);
  if (event.level === 'recovery') return {
    title: t(locale, 'event.recovery.title', { title }),
    body: t(locale, 'event.recovery.body', { resource: event.resource || (event.machine === 'local' ? t(locale, 'machine.local') : event.machine) }),
  };
  // Historical pre-localization records retain their original measured description.
  if (!event.message) return { title, body: event.body ?? '' };
  const params = { ...event.message.params };
  if (event.message.cause) params.error = t(locale, event.message.cause.key, event.message.cause.params);
  if (params.pressure) params.pressure = t(locale, `pressure.${params.pressure}`);
  return { title, body: t(locale, event.message.body, params) };
}
