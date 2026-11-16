import { exec } from 'herdr';

let environment = { os: '', language: 'en' };
let loading;
export function systemEnvironment() { return environment; }
export function loadEnvironment() {
  if (!loading) loading = (async () => {
    try {
      const result = await exec('sh', ['-c', 'os=$(uname -s); printf "%s\\n" "$os"; if [ "$os" = Darwin ]; then /usr/bin/defaults read -g AppleLanguages; else printf "%s\\n" "${LC_ALL:-${LC_MESSAGES:-${LANG:-en}}}"; fi'], { timeout: 2000 });
      const [os, ...lines] = result.stdout.trim().split('\n');
      const raw = lines.join('\n').trim();
      const language = os === 'Darwin' ? raw.match(/"([^"\n]+)"/)?.[1] ?? raw.match(/\(\s*([a-zA-Z][\w-]*)/)?.[1] : raw;
      environment = { os, language: language || 'en' };
    } catch { /* No locale access: documented English fallback, no monitoring failure. */ }
    return environment;
  })();
  return loading;
}
