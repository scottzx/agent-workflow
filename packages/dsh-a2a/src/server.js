import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { createA2AServer } from '@1agents/acp-service/a2a-standalone';
import { HeadlessDshBackend } from './executor.js';
import { createWorkbench, WORKBENCH_UI_PATH } from './workbench.js';

// A second profile often asks for 3080 while `dsh web` or another A2A already
// holds it. Walk forward and listen, instead of failing the plugin.
const PORT_ATTEMPTS = 32;

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
  const workbenchHandler = createWorkbench(workbench, token);
  let a2a;
  const server = createServer((req, res) => { void (async () => {
    const url = new URL(req.url ?? '/', 'http://localhost'), path = url.pathname;
    if (!a2a && path !== WORKBENCH_UI_PATH && !path.startsWith(`${WORKBENCH_UI_PATH}/`)) {
      res.writeHead(503); res.end(); return;
    }
    if (path === WORKBENCH_UI_PATH || path.startsWith(`${WORKBENCH_UI_PATH}/`)) await workbenchHandler(req, res, url);
    else if (path === '/.well-known/agent-card.json') await a2a.cardHandler(req, res);
    else if (path === a2a.path || path.startsWith(`${a2a.path}/`)) await a2a.handler(req, res);
    else { res.writeHead(404); res.end(); }
  })().catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); }); });
  const actualPort = await listenForward(server, host, port);
  const resolvedPublicUrl = advertisedOrigin(publicUrl, port, actualPort);
  if (port !== 0 && actualPort !== port) console.error(`[dsh-a2a] ${host}:${port} is already in use; listening at ${resolvedPublicUrl}`);
  try {
    a2a = await createA2AServer({ ...options, backend, token, stateDirectory, publicUrl: resolvedPublicUrl });
  } catch (error) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(() => resolve()));
    throw error;
  }
  let closing;
  return { server, backend, port: actualPort, publicUrl: resolvedPublicUrl, close: () => closing ??= (async () => {
    const stopped = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await a2a.close(); server.closeAllConnections(); await stopped;
  })() };
}

/** Bind `port`, or the next free port when it is taken. `0` stays an OS assignment. */
async function listenForward(server, host, port) {
  if (port === 0) {
    await listenOnce(server, host, 0);
    return server.address().port;
  }
  let candidate = port;
  let lastError;
  for (let attempt = 0; attempt < PORT_ATTEMPTS && candidate <= 65535; attempt += 1, candidate += 1) {
    try {
      await listenOnce(server, host, candidate);
      return candidate;
    } catch (error) {
      if (!error || error.code !== 'EADDRINUSE') throw error;
      lastError = error;
    }
  }
  const end = Math.min(port + PORT_ATTEMPTS - 1, 65535);
  throw Object.assign(new Error(`[dsh-a2a] no free port from ${port} through ${end} on ${host}`), { code: 'EADDRINUSE', cause: lastError });
}

function listenOnce(server, host, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    try { server.listen(port, host); }
    catch (error) {
      server.off('error', onError);
      server.off('listening', onListening);
      reject(error);
    }
  });
}

/** Keep an external origin. A publicUrl that named the taken listen port follows the port we actually bound. */
function advertisedOrigin(publicUrl, requestedPort, actualPort) {
  const url = new URL(publicUrl);
  const named = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  const follows = requestedPort === 0 ? named === 0 : named === requestedPort && requestedPort !== actualPort;
  if (!follows) return publicUrl;
  url.port = String(actualPort);
  return url.origin;
}
