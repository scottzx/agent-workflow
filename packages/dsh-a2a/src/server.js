import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { createA2AServer } from '@1agents/acp-service/a2a-standalone';
import { HeadlessDshBackend } from './executor.js';
import { createWorkbench, WORKBENCH_UI_PATH } from './workbench.js';

export async function startA2AService(config = {}) {
  const { host = '127.0.0.1', port = 3080, runtime = {}, workbench, tokenEnv = 'DSH_A2A_TOKEN', tokenFile, workbenchConfigFile, token: configuredToken, stateDirectory = join(homedir(), '.1agents', 'state', 'dsh-a2a'), publicUrl = `http://${host}:${port}`, ...options } = config;
  let token = configuredToken ?? process.env[tokenEnv];
  if (!token && tokenFile) {
    const fileInfo = await stat(tokenFile);
    if ((fileInfo.mode & 0o077) !== 0) throw new Error('A2A token file must not be accessible by group or other users');
    const file = await readFile(tokenFile, 'utf8');
    token = file.trim();
    if (!token || Buffer.byteLength(file) > 4096) throw new Error('A2A token file is empty or exceeds 4096 bytes');
  }
  if (workbenchConfigFile) {
    const fileInfo = await stat(workbenchConfigFile);
    if ((fileInfo.mode & 0o077) !== 0) throw new Error('Workbench config file must not be accessible by group or other users');
    const gateway = JSON.parse(await readFile(workbenchConfigFile, 'utf8'));
    if (workbench?.url) workbench.token = gateway.workbench?.token;
    if (workbench) workbench.pageRelaySecret ??= gateway.workbench?.pageRelaySecret;
  }
  const backend = new HeadlessDshBackend({ ...runtime, workbench, directory: join(stateDirectory, 'sessions') });
  const a2a = await createA2AServer({ ...options, backend, token, stateDirectory, publicUrl });
  const workbenchHandler = createWorkbench(workbench, token);
  const server = createServer((req, res) => { void (async () => {
    const url = new URL(req.url ?? '/', 'http://localhost'), path = url.pathname;
    if (path === WORKBENCH_UI_PATH || path.startsWith(`${WORKBENCH_UI_PATH}/`)) await workbenchHandler(req, res, url);
    else if (path === '/.well-known/agent-card.json') await a2a.cardHandler(req, res);
    else if (path === a2a.path || path.startsWith(`${a2a.path}/`)) await a2a.handler(req, res);
    else { res.writeHead(404); res.end(); }
  })().catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); }); });
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); }); }
  catch (error) { await a2a.close(); throw error; }
  let closing;
  return { server, backend, close: () => closing ??= (async () => {
    const stopped = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await a2a.close(); server.closeAllConnections(); await stopped;
  })() };
}
