import { issue } from './i18n.js';

// Vitals stays a one-shot reader: no sampler, account lookup, updater or TUI notifications.
export const VITALS_CONFIG = '{"background":false,"alerts":false,"ai_alerts":false,"herdr_machines":false,"local":true,"interval_seconds":10}';
export const PROBE = String.raw`set -eu
export LC_ALL=C
base="$HOME/.local/share/herdr-health-watch"
bin="$base/vitals/0.3.1/herdr-vitals"
[ -x "$bin" ] || { echo 'Health Watch: Vitals 0.3.1 is not installed; install the pinned collector explicitly.' >&2; exit 41; }
[ "$(cat "$base/config/config.json" 2>/dev/null)" = "$1" ] || { echo 'Health Watch: isolated Vitals configuration is missing or changed.' >&2; exit 42; }
printf '__VITALS__\n'
env -i HOME="$base/home" PATH=/usr/bin:/bin:/usr/sbin:/sbin LC_ALL=C HERDR_PLUGIN_CONFIG_DIR="$base/config" HERDR_PLUGIN_STATE_DIR="$base/state" "$bin" app '{"op":"now"}'
printf '__PRESSURE__\n'
case "$(uname -s)" in
Darwin) sysctl -n kern.memorystatus_vm_pressure_level; printf '__SWAP__\n'; sysctl -n vm.swapusage ;;
Linux) printf 'none\n'; printf '__SWAP__\n'; awk '/^SwapTotal:|^SwapFree:/ {print}' /proc/meminfo ;;
*) echo 'Health Watch: unsupported OS' >&2; exit 43 ;;
esac
printf '__DISKS__\n'
df -Pk
printf '__PROCESSES__\n'
if [ "$2" = 1 ]; then ps -axo pid=,pcpu=,rss=,comm=; fi
`;
export const PROCESS_PROBE = 'LC_ALL=C ps -axo pid=,pcpu=,rss=,comm=';

function finite(value, name, min = 0, max = Infinity) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw issue('error.metric', { name });
  return value;
}
export function parseProcesses(text, cores) {
  finite(cores, 'CPU cores', 1);
  return text.split('\n').flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/);
    if (!match) return [];
    const name = match[4].trim().split('/').pop();
    const cpu = Number(match[2]) / cores;
    if (!Number.isFinite(cpu)) return [];
    return [{ pid: Number(match[1]), name, cpu, memoryBytes: Number(match[3]) * 1024 }];
  }).sort((a, b) => b.cpu - a.cpu || b.memoryBytes - a.memoryBytes);
}
export function parseProbe(text, at, collectionMs) {
  const parts = text.match(/^__VITALS__\n([\s\S]*?)\n__PRESSURE__\n([\s\S]*?)\n__SWAP__\n([\s\S]*?)\n__DISKS__\n([\s\S]*?)\n__PROCESSES__\n([\s\S]*)$/);
  if (!parts) throw issue('error.incomplete');
  const raw = JSON.parse(parts[1]);
  if (raw.error) throw new Error(String(raw.error));
  if (!['darwin', 'linux'].includes(raw.os)) throw issue('error.os');
  finite(raw.cores, 'CPU cores', 1);
  finite(raw.memTotal, 'memTotal', 1);
  finite(raw.mem, 'memory', 0, 100);
  finite(raw.cpu, 'CPU', 0, 100);
  let pressure = null;
  let swapUsedBytes;
  if (raw.os === 'darwin') {
    pressure = ({ 1: 'normal', 2: 'warning', 4: 'critical' })[parts[2].trim()];
    if (!pressure) throw issue('error.pressure');
    const swap = parts[3].match(/used\s*=\s*([\d.]+)([KMGT])/);
    if (!swap) throw issue('error.swap');
    swapUsedBytes = Number(swap[1]) * ({ K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 })[swap[2]];
  } else {
    const total = parts[3].match(/^SwapTotal:\s+(\d+)/m);
    const free = parts[3].match(/^SwapFree:\s+(\d+)/m);
    if (!total || !free || Number(free[1]) > Number(total[1])) throw issue('error.swap');
    swapUsedBytes = (Number(total[1]) - Number(free[1])) * 1024;
  }
  const diskFree = new Map();
  for (const line of parts[4].split('\n')) {
    const match = line.match(/^\S+\s+\d+\s+\d+\s+(\d+)\s+\d+%\s+(.+)$/);
    if (match) diskFree.set(match[2].trim(), Number(match[1]) * 1024);
  }
  if (!Array.isArray(raw.disks) || !raw.disks.length) throw issue('error.disks');
  const disks = raw.disks.map((d) => {
    if (typeof d.mount !== 'string' || !diskFree.has(d.mount)) throw issue('error.diskFree');
    return { mount: d.mount, pct: finite(d.pct, 'disk', 0, 100), freeBytes: finite(diskFree.get(d.mount), 'diskFree') };
  });
  return { at, os: raw.os, host: String(raw.host), cores: raw.cores, cpu: raw.warming ? null : raw.cpu,
    memoryPct: raw.mem, pressure, swapUsedBytes: finite(swapUsedBytes, 'swap'), disks,
    processes: parseProcesses(parts[5], raw.cores), collectionMs };
}
