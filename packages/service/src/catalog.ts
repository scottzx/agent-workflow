/** Local harness discovery shared by HTTP consumers and the service launcher. No processes or downloads are started by a scan. */
import { accessSync, closeSync, constants, openSync, readSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { createAgentRegistry } from '@1agents/acp-service/runtime';
import { catalogDescriptors } from './catalog-descriptors.js';

export interface DiscoveryOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Package search roots, nearest first. Defaults to the runtime's ancestor directories. */
  packageRoots?: string[];
}

export interface AgentStatus {
  id: string;
  type: string;
  label: string;
  binary: string;
  installed: boolean;
  path?: string;
  acp_capable: boolean;
  cli_capable: boolean;
  cc_transport: string;
  integrated: boolean;
  install_command?: string;
  chat_ready: boolean;
}

const registry = createAgentRegistry();
const require = createRequire(import.meta.url);
const runtimeRoot = dirname(dirname(require.resolve('@1agents/acp-service/runtime-cli')));

/** Resolve an executable on PATH, then in user-local harness directories. */
export function findAgentBinary(binary: string, options: DiscoveryOptions = {}): string | undefined {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const dirs = (env.PATH ?? '').split(platform === 'win32' ? ';' : delimiter).filter(Boolean);
  dirs.push(join(home, '.local', 'bin'), join(home, '.grok', 'bin'));
  const extensions = platform === 'win32' ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')] : [''];
  for (const dir of isAbsolute(binary) ? [''] : dirs) {
    for (const ext of extensions) {
      const candidate = resolve(dir, binary + ext);
      try {
        if (!statSync(candidate).isFile()) continue;
        accessSync(candidate, platform === 'win32' ? constants.F_OK : constants.X_OK);
        return candidate;
      } catch { /* Missing or non-executable candidate: continue the search. */ }
    }
  }
  return undefined;
}

function packageRoots(): string[] {
  const roots: string[] = [];
  for (let dir = runtimeRoot; ; dir = dirname(dir)) {
    roots.push(dir);
    if (dirname(dir) === dir) return roots;
  }
}

function isNodeLauncher(bin: string): boolean {
  if (/\.[cm]?js$/.test(bin)) return true;
  const fd = openSync(bin, 'r');
  try {
    const buffer = Buffer.alloc(200);
    const size = readSync(fd, buffer, 0, buffer.length, 0);
    return /^#!.*\bnode\b/.test(buffer.toString('utf8', 0, size));
  } finally { closeSync(fd); }
}

function packageLaunch(spec: string, extraArgs: string[], options: DiscoveryOptions): string[] | undefined {
  const name = spec.replace(/@[^/]*$/, '');
  for (const root of options.packageRoots ?? packageRoots()) {
    try {
      const dir = join(root, 'node_modules', name);
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      if (manifest.name !== name) continue;
      const bins = typeof manifest.bin === 'string' ? [manifest.bin] : Object.values(manifest.bin ?? {});
      if (bins.length !== 1 || typeof bins[0] !== 'string') continue;
      const bin = resolve(dir, bins[0]);
      if (!statSync(bin).isFile()) continue;
      // JS launchers need not be executable when run by Node; native bins do.
      if (isNodeLauncher(bin)) {
        return [process.execPath, bin, ...extraArgs];
      }
      const executable = findAgentBinary(bin, options);
      if (executable) return [executable, ...extraArgs];
    } catch { /* Package absent or incomplete: it is not locally launchable. */ }
  }
  return undefined;
}

function localLaunch(id: string, options: DiscoveryOptions): string[] | undefined {
  const argv = registry.resolve(id);
  if (!Array.isArray(argv)) return undefined;
  if (argv[0] === 'npx') {
    const index = argv.findIndex((arg, i) => i > 0 && !arg.startsWith('-'));
    if (index < 0) return undefined;
    const extraArgs = argv.slice(index + 1);
    const packaged = packageLaunch(argv[index], extraArgs, options);
    if (packaged) return packaged;
    // Use the runtime's adapter entrypoint, rather than the display/native CLI.
    // Package lookup above honors the service's explicit search roots.
    const inspection = createAgentRegistry({
      resolveExecutable: command => findAgentBinary(command, options),
      resolvePackageRoot: () => undefined,
    }).inspect(id);
    if (inspection?.launch.kind !== 'installed') return undefined;
    const [binary, ...args] = inspection.launch.argv;
    return isNodeLauncher(binary)
      ? [process.execPath, binary, ...args]
      : [binary, ...args];
  }
  // A package runner alone does not demonstrate an installed harness.
  if (argv[0] === 'uvx') return undefined;
  const binary = findAgentBinary(argv[0], options);
  return binary ? [binary, ...argv.slice(1)] : undefined;
}

/** Antigravity's ACP runtime is a separate download from the `agy` CLI. */
function discoveryBinary(id: string, descriptor: { binary: string } | undefined, argv: string[] | string | undefined, platform: NodeJS.Platform): string {
  if (id === 'antigravity') return platform === 'win32' ? 'agy_acp_server.exe' : 'agy_acp_server.par';
  return descriptor?.binary ?? (Array.isArray(argv) && !['npx', 'uvx'].includes(argv[0]) ? argv[0] : id);
}

/** Fresh filesystem snapshot. An installed CLI may use the runtime's adapter download fallback on launch; scanning never downloads or authenticates. */
export function discoverAgents(options: DiscoveryOptions = {}): AgentStatus[] {
  const descriptors = new Map(catalogDescriptors.map(d => [d.type === 'claudecode' ? 'claude' : d.type, d]));
  const supportedAgents = new Set(registry.list());
  const platform = options.platform ?? process.platform;
  return [...new Set([...supportedAgents, ...descriptors.keys()])].map(id => {
    const descriptor = descriptors.get(id);
    const argv = registry.resolve(id);
    const binary = discoveryBinary(id, descriptor, argv, platform);
    const path = findAgentBinary(binary, options);
    const supported = supportedAgents.has(id);
    return {
      id, type: descriptor?.type ?? id, label: descriptor?.label ?? id, binary,
      installed: !!path, ...(path ? { path } : {}),
      acp_capable: supported || descriptor?.acp_capable === true,
      cli_capable: descriptor?.cli_capable ?? true,
      cc_transport: descriptor?.cc_transport ?? '', integrated: descriptor?.integrated ?? false,
      ...(descriptor?.install_command ? { install_command: descriptor.install_command } : {}),
      chat_ready: supported && (!!localLaunch(id, options) || (!!path && Array.isArray(argv) && argv[0] === 'npx' && !!findAgentBinary('npx', options))),
    };
  });
}

/** Use the same resolved local commands as discovery, including binaries outside PATH. Explicit launches retain runtime fallback behavior. */
export function createServiceAgentRegistry(options: DiscoveryOptions = {}) {
  return {
    list: () => registry.list(),
    resolve: (name: string) => {
      const local = localLaunch(name, options);
      if (local) return local;
      const fallback = registry.resolve(name);
      if (Array.isArray(fallback) && fallback[0] === 'npx') {
        const runner = findAgentBinary('npx', options);
        if (runner) return [runner, ...fallback.slice(1)];
      }
      return fallback;
    },
  };
}
