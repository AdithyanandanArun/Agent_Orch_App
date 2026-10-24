import { spawnSync } from 'node:child_process';

const DBUS_DESTINATION = 'org.freedesktop.DBus';
const DBUS_OBJECT = '/org/freedesktop/DBus';
const DBUS_INTERFACE = 'org.freedesktop.DBus';
const KNOWN_SERVICES = new Set([
  'org.freedesktop.secrets',
  'org.kde.kwalletd',
  'org.kde.kwalletd5',
  'org.kde.kwalletd6',
]);
const PROBE_TIMEOUT_MS = 300;
const PROBE_BUDGET_MS = 800;

export function hasExplicitPasswordStore(argv = process.argv) {
  return argv.some(argument => argument === '--password-store' || argument.startsWith('--password-store='));
}

function readServiceNames(output) {
  const tokens = output.match(/"[^"]*"|'[^']*'|[A-Za-z0-9_.-]+/g) ?? [];
  const names = new Set();
  for (const token of tokens) {
    const name = token.replace(/^['"]|['"]$/g, '');
    if (KNOWN_SERVICES.has(name)) names.add(name);
  }
  return names;
}

function invoke(run, command, args, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return null;
  let result;
  try {
    result = run(command, args, {
      encoding: 'utf8',
      timeout: Math.min(PROBE_TIMEOUT_MS, remaining),
      maxBuffer: 8192,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
  } catch {
    return null;
  }
  if (!result || result.error || result.status !== 0 || typeof result.stdout !== 'string') return null;
  return result.stdout;
}

function queryServices(run, command, makeArgs, deadline) {
  const list = method => invoke(run, command, makeArgs(method), deadline);
  const ownedOutput = list('Names');
  const activatableOutput = list('ActivatableNames');
  if (ownedOutput === null || activatableOutput === null) return null;
  return {
    owned: readServiceNames(ownedOutput),
    activatable: readServiceNames(activatableOutput),
  };
}

function probeSessionServices(run = spawnSync) {
  const deadline = Date.now() + PROBE_BUDGET_MS;
  const busctl = queryServices(run, 'busctl', method => [
    '--user', '--no-pager', 'call', DBUS_DESTINATION, DBUS_OBJECT, DBUS_INTERFACE, `List${method}`,
  ], deadline);
  if (busctl) return busctl;
  return queryServices(run, 'dbus-send', method => [
    '--session', '--print-reply=literal', `--dest=${DBUS_DESTINATION}`, DBUS_OBJECT, `${DBUS_INTERFACE}.List${method}`,
  ], deadline);
}

function walletBackend(names) {
  if (names.has('org.kde.kwalletd6')) return 'kwallet6';
  if (names.has('org.kde.kwalletd5')) return 'kwallet5';
  if (names.has('org.kde.kwalletd')) return 'kwallet';
  return null;
}

function desktopHint(environment) {
  const values = [environment.XDG_CURRENT_DESKTOP, environment.XDG_SESSION_DESKTOP, environment.DESKTOP_SESSION];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const tokens = value.toLowerCase().split(/[^a-z0-9_-]+/).filter(Boolean);
    for (const token of tokens) {
      if (token === 'gnome' || token === 'gnome-classic' || token === 'gnome-flashback') return 'gnome';
      if (
        token === 'kde' || token === 'plasma' || token === 'kde-plasma' ||
        token === 'kdewayland' || token === 'kdex11' ||
        token === 'plasmawayland' || token === 'plasmax11' ||
        token.startsWith('plasma-')
      ) return 'kde';
    }
  }
  return 'unknown';
}

function chooseBackend(services, hint = 'unknown') {
  const activeWallet = walletBackend(services.owned);
  const activatableWallet = walletBackend(services.activatable);
  const secretServiceAvailable = services.owned.has('org.freedesktop.secrets')
    || services.activatable.has('org.freedesktop.secrets');
  const walletAvailable = activeWallet ?? activatableWallet;

  // Desktop hints break ties only when both candidate providers were observed on
  // this session bus. A hint can never select an absent service.
  if (secretServiceAvailable && walletAvailable) {
    if (hint === 'kde') return walletAvailable;
    if (hint === 'gnome') return 'gnome-libsecret';
  }

  // Preserve the existing default ordering for unknown compositors and single-provider systems.
  if (services.owned.has('org.freedesktop.secrets')) return 'gnome-libsecret';
  if (activeWallet) return activeWallet;
  if (services.activatable.has('org.freedesktop.secrets')) return 'gnome-libsecret';
  return activatableWallet;
}

/**
 * Select Electron's Linux safeStorage provider from actual session-bus services.
 * Recognized desktop hints only break ties between providers evidenced on that bus.
 */
export function selectLinuxPasswordStore({
  platform = process.platform,
  argv = process.argv,
  environment = process.env,
  run = spawnSync,
} = {}) {
  if (platform !== 'linux') return { status: 'unchanged', backend: null, explicit: false };
  if (hasExplicitPasswordStore(argv)) return { status: 'explicit', backend: null, explicit: true };

  const services = probeSessionServices(run);
  if (!services) return { status: 'unavailable', backend: null, explicit: false };
  const backend = chooseBackend(services, desktopHint(environment));
  return backend
    ? { status: 'selected', backend, explicit: false }
    : { status: 'unavailable', backend: null, explicit: false };
}

export function configureLinuxPasswordStore({ app, ...options }) {
  const selection = selectLinuxPasswordStore(options);
  if (selection.status === 'selected') app.commandLine.appendSwitch('password-store', selection.backend);
  return selection;
}
