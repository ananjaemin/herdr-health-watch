import { eventText, t } from './i18n.js';

const quote = (value) => `'${String(value).replace(/'/g, `'"'"'`)}'`;
export function notificationArgs(event, config, locale, os, appFolder, cli) {
  const text = eventText(locale, event);
  const machine = event.machine === 'local' ? t(locale, 'machine.local') : event.machine;
  const title = `Health Watch · ${t(locale, `level.${event.level}`)}`;
  if (os === 'Linux') return ['--app-name=Health Watch', `--urgency=${event.level === 'critical' ? 'critical' : 'normal'}`,
    '--', `${title} · ${machine}`, `${text.title}\n${text.body}`];
  const args = ['-title', title, '-subtitle', machine, '-message', `${text.title}\n${text.body}`,
    '-group', `herdr-health-watch:${event.key}`];
  // A missing CLI must not turn a click into a broken shell command.
  if (cli) args.push('-execute', `/usr/bin/open -b dev.herdr.app; /usr/bin/env HERDR_APP_HOME=${quote(appFolder)} ${quote(cli)} do ${quote(`health-watch.open~${encodeURIComponent(event.machine)}`)}`);
  else args.push('-activate', 'dev.herdr.app');
  if (event.level === 'critical' && config.criticalSound) args.push('-sound', 'default');
  return args;
}

// Discovery only; no download, shell profile loading or Ruby/version-manager execution.
export const DISCOVER_NOTIFIER = String.raw`set -eu
os=$(uname -s)
printf '%s\n' "$os"
if [ "$os" = Darwin ]; then
  tool=''
  for candidate in "$HOME/.local/share/herdr-health-watch/terminal-notifier" /opt/homebrew/bin/terminal-notifier /usr/local/bin/terminal-notifier /Applications/terminal-notifier.app/Contents/MacOS/terminal-notifier; do
    if [ -x "$candidate" ]; then tool=$candidate; break; fi
  done
  if [ -z "$tool" ]; then tool=$(command -v terminal-notifier || true); fi
elif [ "$os" = Linux ]; then
  tool=$(command -v notify-send || true)
else
  exit 43
fi
[ -n "$tool" ] && [ -x "$tool" ] || exit 44
# Cocoa resolves its application bundle from the executable path, not our optional link.
while [ -L "$tool" ]; do
  link=$(readlink "$tool")
  case "$link" in
    /*) tool=$link ;;
    *) tool="$(dirname "$tool")/$link" ;;
  esac
done
tool="$(cd -P "$(dirname "$tool")" && pwd)/$(basename "$tool")"
printf '%s\n' "$tool"
cli=$(command -v herdr-app || true)
if [ -z "$cli" ] && [ -x "$HOME/.local/bin/herdr-app" ]; then cli="$HOME/.local/bin/herdr-app"; fi
printf '%s\n' "$cli"
`;
