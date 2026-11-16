import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { SUPPORTED_LOCALES, resolveLocale, t, eventText, errorMessage } from './i18n.js';
import { defaultConfig, normalizeConfig, advance, initialState } from './engine.js';
import { notificationArgs } from './notification-command.js';

const sample = (at, cpu = 95) => ({ at, os: 'darwin', host: 'test', cores: 8, cpu, memoryPct: 40,
  pressure: 'normal', swapUsedBytes: 0, disks: [{ mount: '/', pct: 50, freeBytes: 100 * 1024 ** 3 }], processes: [], collectionMs: 1 });

test('system locale normalization handles POSIX, region variants, unsupported scripts and explicit overrides', () => {
  for (const value of ['ko_KR.UTF-8', 'ko-KR', 'ko']) assert.equal(resolveLocale('auto', value), 'ko');
  for (const value of ['zh_CN.UTF-8', 'zh-Hans-SG', 'zh-SG', 'zh']) assert.equal(resolveLocale(value), 'zh-CN');
  assert.equal(resolveLocale('ja_JP.UTF-8'), 'ja');
  for (const value of ['de-DE', 'fr_FR.UTF-8', 'zh-TW', 'zh-Hant', 'C', 'POSIX', '', null]) assert.equal(resolveLocale(value), 'en');
  assert.equal(resolveLocale('en', 'ko-KR'), 'en');
  assert.equal(resolveLocale('auto', 'auto'), 'en');
});

test('saved language survives normalization and invalid settings remain invalid', () => {
  for (const language of ['auto', ...SUPPORTED_LOCALES]) assert.equal(normalizeConfig({ language }).language, language);
  assert.throws(() => normalizeConfig({ language: 'de' }), { messageKey: 'error.language' });
  assert.throws(() => normalizeConfig({ language: 'en', intervalSeconds: -1 }), { messageKey: 'error.interval' });
});

test('recorded alerts and recovery retain values while changing display language after reload', () => {
  const config = defaultConfig();
  config.thresholds.cpuHoldSec = 0;
  config.thresholds.recoverySec = 0;
  let state = advance(initialState(), config, { machine: 'local', sample: sample(1000) }, 1000).state;
  const raised = advance(state, config, { machine: 'local', sample: sample(2000) }, 2000);
  const event = JSON.parse(JSON.stringify(raised.events[0]));
  assert.equal(event.rule, 'cpu');
  assert.equal(event.message.params.value, '95.0');
  for (const locale of SUPPORTED_LOCALES) {
    const text = eventText(locale, event);
    assert.equal(text.title, t(locale, 'event.cpu.title'));
    assert.match(text.body, /95\.0%/);
    if (locale !== 'ko') assert.doesNotMatch(text.title + text.body, /[가-힣]/);
  }
  state = advance(raised.state, config, { machine: 'local', sample: sample(3000, 10) }, 3000).state;
  const recovered = advance(state, config, { machine: 'local', sample: sample(4000, 10) }, 4000).events[0];
  assert.equal(recovered.level, 'recovery');
  assert.equal(eventText('ja', recovered).body, t('ja', 'event.recovery.body', { resource: t('ja', 'machine.local') }));
});

test('localized validation errors keep their typed error and untrusted parameters literal', () => {
  let error;
  try { normalizeConfig({ intervalSeconds: 4 }); } catch (caught) { error = caught; }
  assert.ok(error instanceof RangeError);
  for (const locale of SUPPORTED_LOCALES) assert.equal(errorMessage(locale, error), t(locale, 'error.interval'));
  const resource = '${HOME} {value} <disk> 日本語 한글';
  const text = eventText('en', { rule: 'disk', message: { body: 'event.disk.body', params: { resource, percent: '95.0', free: '3.5' } } });
  assert.ok(text.body.startsWith(resource + ':'));
});

test('desktop arguments preserve non-ASCII and shell metacharacters without executing them', () => {
  const event = { machine: "remote'; printf PWNED; # 日本語", key: 'key', rule: 'cpu', level: 'critical', message: { body: 'event.cpu.body', params: { value: '99.0' } } };
  const appHome = "/tmp/app folder ' $(printf PWNED)";
  const cli = "/tmp/CLI folder ' $(printf PWNED)/herdr-app";
  const args = notificationArgs(event, { criticalSound: false }, 'ja', 'Darwin', appHome, cli);
  assert.equal(args[args.indexOf('-subtitle') + 1], event.machine);
  assert.equal(args.includes('-sound'), false);
  const command = args[args.indexOf('-execute') + 1];
  // Replace only fixed executable tokens with shell builtins; evaluate real argument quoting.
  const safe = command.replace('/usr/bin/open -b dev.herdr.app; /usr/bin/env ', 'printf \'%s\\n\' ');
  const result = spawnSync('/bin/sh', ['-c', safe], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.deepEqual(result.stdout.trimEnd().split('\n'), [`HERDR_APP_HOME=${appHome}`, cli, 'do', `health-watch.open~${encodeURIComponent(event.machine)}`]);
  const linux = notificationArgs(event, {}, 'zh-CN', 'Linux', '', '');
  assert.equal(linux[2], '--');
  assert.equal(linux[3], `Health Watch · ${t('zh-CN', 'level.critical')} · ${event.machine}`);
});

test('owned connection failures relocalize after being recorded in another language', () => {
  const config = defaultConfig();
  config.thresholds.failures = 1;
  const event = advance(initialState(), config, { machine: 'local', error: t('ko', 'error.vitalsMissing'),
    errorDescriptor: { key: 'error.vitalsMissing', params: {} } }, 1000).events[0];
  for (const locale of SUPPORTED_LOCALES) assert.equal(eventText(locale, event).body, t(locale, 'error.vitalsMissing'));
});
