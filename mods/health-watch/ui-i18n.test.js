import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uiMessages } from './ui-messages.js';
import { SUPPORTED_LOCALES, resolveLocale, t } from './i18n.js';

const parameters = (value) => [...value.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)].map((match) => match[1]).sort();

test('localized text preserves interpolation parameters without leaking Korean into other locales', () => {
  assert.deepEqual(Object.keys(uiMessages), SUPPORTED_LOCALES);
  for (const locale of SUPPORTED_LOCALES) {
    assert.deepEqual(Object.keys(uiMessages[locale]).sort(), Object.keys(uiMessages.en).sort());
    for (const key of Object.keys(uiMessages.en)) {
      assert.equal(typeof uiMessages[locale][key], 'string', `${locale}: ${key}`);
      assert.ok(uiMessages[locale][key].trim(), `${locale}: ${key} must not be empty`);
      assert.deepEqual(parameters(uiMessages[locale][key]), parameters(uiMessages.en[key]), `${locale}: ${key} parameters`);
      if (locale !== 'ko') assert.doesNotMatch(uiMessages[locale][key], /[가-힣]/, `${locale}: ${key} leaks Korean`);
    }
  }
});

test('unsupported and automatic locales use the same UI fallback policy', () => {
  assert.equal(t(resolveLocale('auto', 'de-DE'), 'ui.thisComputer'), 'This computer');
  assert.equal(t('de-DE', 'ui.settingsSaved'), uiMessages.en['ui.settingsSaved']);
  for (const locale of SUPPORTED_LOCALES) {
    assert.equal(t(resolveLocale('auto', locale), 'ui.settingsSaved'), uiMessages[locale]['ui.settingsSaved']);
    assert.equal(t(locale, 'ui.reasonValue', { reason: 'user {reason} 日本語 한글' }), uiMessages[locale]['ui.reasonValue'].replace('{reason}', 'user {reason} 日本語 한글'));
  }
});
