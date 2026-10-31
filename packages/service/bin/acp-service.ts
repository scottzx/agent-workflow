#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const rawArgs = process.argv.slice(2);
const invokedBin = 'acp-service';

function getAcpxCliPath(): string {
  return require.resolve('@1agents/acp-service/runtime-cli');
}

function getPackageVersion(): string {
  try {
    const candidates = [
      new URL('../../package.json', import.meta.url),
      new URL('../package.json', import.meta.url),
    ];
    for (const url of candidates) {
      try {
        const content = fs.readFileSync(url, 'utf-8');
        const pkg = JSON.parse(content);
        if (pkg.version) return pkg.version;
      } catch {}
    }
  } catch {}
  return '0.2.0';
}

function printServeHelp(binName: string) {
  console.log(`用法: ${binName} serve [选项]

启动 DreamMate Network ACP Agent 运行时常驻服务（HTTP + WebSocket）

选项:
  --port, -p <n>    指定监听端口（默认: 36812）
  --host <ip>       指定绑定 IP（默认: 0.0.0.0）
  --no-report       不向本机 node agent (36908) 报备
  -h, --help        显示帮助信息
`);
}

function printUnifiedHelp(binName: string) {
  let baseHelp = '';
  try {
    const cliPath = getAcpxCliPath();
    baseHelp = execFileSync(process.execPath, [cliPath, '--help'], { encoding: 'utf-8' });
  } catch (err) {
    baseHelp = String(err);
  }

  let help = baseHelp
    .replace(/^Usage:\s+acpx/m, `Usage: ${binName}`)
    .replace(
      /Headless CLI client for the Agent Client Protocol/,
      'Headless CLI client & DreamMate Network runtime service for the Agent Client Protocol (ACP)'
    );

  const serverCommands = `Commands:
  roles sync --profile <file>            Resolve current network skills into a versioned task lock
  a2a gateway --config <file>             Start persistent remote-agent tools and completion inbox
  a2a invoke <method>                     Invoke local remote-agent tools (JSON params on stdin)
  rsi run --role <dir> --case <id> ...    Run a role case: executor, program checks, send failures back
  ticket show|events|proposal --job <id>  Read a job's task ticket and its events, or settle a proposal
  process list|answer --job <id>          Read a job's process requests, or answer one as the coach or a person
  serve [options]                         Start DreamMate Network ACP runtime daemon (HTTP + WS)`;

  help = help.replace(/^Commands:/m, serverCommands);

  const serverOptions = `Options:
  --skill <action>                        List, show, export or install bundled agent skills
  --port, -p <n>                          Server listen port (for serve, default: 36812)
  --host <ip>                             Server bind IP (for serve, default: 0.0.0.0)
  --no-report                             Do not report to local dreammate-node (36908)`;

  help = help.replace(/^Options:/m, serverOptions);

  help = help.replaceAll(/acpx /g, `${binName} `);
  help = help.replace(/^Examples:\n/m, `Examples:\n  ${binName} serve --port 36812\n`);

  console.log(help);
}

function forwardToCli(args: string[]) {
  const cliPath = getAcpxCliPath();
  const child = spawn(process.execPath, [cliPath, ...args], {
    stdio: 'inherit',
    env: process.env,
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
    } else {
      process.exit(code ?? 0);
    }
  });

  child.on('error', (err) => {
    console.error(`[${invokedBin}] 进程启动失败:`, err.message);
    process.exit(1);
  });
}

function parseServerArgs(args: string[]): {
  port?: number;
  host?: string;
  report?: boolean;
} {
  const options: { port?: number; host?: string; report?: boolean } = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--port' || arg === '-p') {
      const val = args[++i];
      if (val) options.port = Number.parseInt(val, 10);
    } else if (arg === '--host') {
      options.host = args[++i];
    } else if (arg === '--no-report') {
      options.report = false;
    }
  }
  return options;
}

async function runServer(options: { port?: number; host?: string; report?: boolean }) {
  const { serveAcpService } = await import('../src/server.js');
  const { attachProcessSignalHandlers } = await import('../src/bridge.js');
  attachProcessSignalHandlers();
  try {
    await serveAcpService(options);
  } catch (error) {
    console.error(`[${invokedBin}] 启动失败:`, error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

async function main() {
  if (rawArgs[0] === 'roles') {
    const { runRolesCli } = await import('./roles.js');
    await runRolesCli(rawArgs.slice(1));
    return;
  }
  if (rawArgs.includes('--skill')) {
    const { maybeHandleSkillflag } = await import('skillflag');
    const packageRoot = path.dirname(require.resolve('@1agents/acp-service/package.json'));
    await maybeHandleSkillflag(process.argv, {
      skillsRoot: [path.join(packageRoot, 'skills'), path.join(packageRoot, 'vendor/runtime/skills')],
      includeBundledSkill: false,
    });
    return;
  }
  if (rawArgs[0] === 'a2a') {
    const { runA2ACli } = await import('./a2a.js');
    await runA2ACli(rawArgs.slice(1));
    return;
  }
  if (rawArgs[0] === 'ticket') {
    const { runTicketCli } = await import('./ticket.js');
    await runTicketCli(rawArgs.slice(1));
    return;
  }
  if (rawArgs[0] === 'process') {
    const { runProcessCli } = await import('./process.js');
    await runProcessCli(rawArgs.slice(1));
    return;
  }
  if (rawArgs[0] === 'rsi') {
    const { runRsiCli } = await import('./rsi.js');
    await runRsiCli(rawArgs.slice(1));
    return;
  }
  const isServe = rawArgs[0] === 'serve' || rawArgs[0] === 'run';
  const hasServerExplicitFlag =
    rawArgs[0] === '--port' ||
    rawArgs[0] === '-p' ||
    rawArgs[0] === '--host' ||
    rawArgs[0] === '--no-report';

  // 1. Version
  if (rawArgs[0] === '-V' || rawArgs[0] === '--version') {
    const version = getPackageVersion();
    console.log(`@1agents/acp-service v${version}`);
    return;
  }

  // 2. Help
  if (
    rawArgs[0] === '--help' ||
    (rawArgs[0] === '-h' && rawArgs.length === 1) ||
    rawArgs[0] === 'help'
  ) {
    printUnifiedHelp(invokedBin);
    return;
  }

  // 3. Serve command explicit
  if (isServe) {
    const serveArgs = rawArgs.slice(1);
    if (serveArgs.includes('--help') || serveArgs.includes('-h')) {
      printServeHelp(invokedBin);
      return;
    }
    const options = parseServerArgs(serveArgs);
    await runServer(options);
    return;
  }

  // 4. Server explicit flags e.g. `acp-service --port 36812`
  if (hasServerExplicitFlag) {
    const options = parseServerArgs(rawArgs);
    await runServer(options);
    return;
  }

  // 5. No arguments: default to running the server!
  if (rawArgs.length === 0) {
    await runServer({});
    return;
  }

  // 6. Any other subcommand or arguments -> forward directly to the embedded runtime CLI
  forwardToCli(rawArgs);
}

await main();
