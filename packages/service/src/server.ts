/**
 * acp-service HTTP 与 WebSocket 复合服务。
 *
 * 单端口复用：
 *  - GET /health: 供 dreammate-node 与探活方检查运行状态
 *  - GET /agents: 返回本机 harness 安装状态与 ACP 可用性
 *  - GET /manifest: 返回符合 DreamMate Network 规范的节点能力清单
 *  - WebSocket: 处理与客户端（Web Chat、IM 机器人等）的全双工 ACP 会话
 */
import http from 'node:http';
import { discoverAgents } from './catalog.js';
import { loadAgentProfiles } from './agent-profiles.js';
import type { AddressInfo } from 'node:net';
import { nodeIdentity } from '@1agents/dreammate-node';
import { reportAndHoldRegistration } from '@1agents/dreammate-node/client';
import { buildManifest, ACP_CAPABILITIES, DEFAULT_ACP_PORT, type Reachability } from './manifest.js';
import { attachBridgeServer, activeSessions, sessionBackgroundTasks, killAllManagedAgents } from './bridge.js';

export interface ServerOptions {
  port?: number;
  host?: string;
  report?: boolean;
}

const json = (res: http.ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
};

export function createAcpServer(): {
  server: http.Server;
  bridge: ReturnType<typeof attachBridgeServer>;
} {
  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        const { pathname } = url;
        if (req.method === 'GET' && pathname === '/agents') {
          res.setHeader('Cache-Control', 'no-store');
          const { profiles } = loadAgentProfiles();
          return json(res, 200, { agents: discoverAgents({ profiles }).map(({ path: _path, ...agent }) => agent) });
        }
        const identity = await nodeIdentity();

        if (req.method === 'GET' && pathname === '/health') {
          return json(res, 200, {
            status: 'ok',
            node_id: identity.node_id,
            service: 'acp-service',
            kind: 'agent_runtime',
            sessions: activeSessions.size,
            background_tasks: sessionBackgroundTasks.size,
            uptime: process.uptime(),
          });
        }

        if (req.method === 'GET' && pathname === '/manifest') {
          const baseUrl = `http://${req.headers.host ?? 'localhost'}`;
          const manifest = await buildManifest(baseUrl);
          return json(res, 200, manifest);
        }

        if (req.method === 'GET' && pathname === '/services') {
          return json(res, 200, {
            service: 'acp-service',
            active_sessions: activeSessions.size,
            background_tasks: sessionBackgroundTasks.size,
          });
        }

        json(res, 404, { error: `no route: ${req.method} ${pathname}` });
      } catch (error: unknown) {
        json(res, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    })();
  });

  const bridge = attachBridgeServer(server);
  return { server, bridge };
}

export async function serveAcpService(options: ServerOptions = {}): Promise<{
  server: http.Server;
  bridge: ReturnType<typeof attachBridgeServer>;
  port: number;
  close: () => Promise<void>;
}> {
  const { server, bridge } = createAcpServer();
  const host = options.host ?? '0.0.0.0';
  const wantedPort = options.port ?? DEFAULT_ACP_PORT;

  await new Promise<void>((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(
          new Error(
            `端口 ${wantedPort} 已被占用。可换端口：--port <n>；或检查占用进程：lsof -nP -iTCP:${wantedPort} -sTCP:LISTEN`,
          ),
        );
      } else {
        reject(err);
      }
    });
    server.listen(wantedPort, host, resolve);
  });

  const { port } = server.address() as AddressInfo;
  const identity = await nodeIdentity();

  const reachability: Reachability =
    host === '127.0.0.1' || host === 'localhost' || host === '::1' ? 'localhost' : 'network';

  const reported =
    options.report === false
      ? undefined
      : await reportAndHoldRegistration({
          id: 'acp-service',
          name: 'acp-service',
          kind: 'agent_runtime',
          capabilities: [...ACP_CAPABILITIES],
          port,
          reachability,
          health: '/health',
        });

  console.log(`acp-service — node ${identity.name} (${identity.node_id})`);
  console.log(`  HTTP: http://${host}:${port}/manifest`);
  console.log(`  Health: http://${host}:${port}/health`);
  console.log(`  WebSocket: ws://${host}:${port}/`);
  console.log(`  capabilities: ${ACP_CAPABILITIES.join(', ')}`);

  if (reported) {
    console.log(
      reported.ok
        ? `  已向本机 node agent 报备（reachability=${reachability}）`
        : `  未报备：${reported.reason}（node-agent 未就绪时不影响本服务独立提供能力）`,
    );
  }

  const close = async (): Promise<void> => {
    const sockets = bridge.wss;
    if (sockets) {
      for (const client of sockets.clients) client.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      await killAllManagedAgents();
    } catch {}
  };

  return { server, bridge, port, close };
}
