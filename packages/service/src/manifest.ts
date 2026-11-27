/**
 * acp-service 作为 DreamMate Network Service 时的 manifest 构建。
 *
 * 节点身份来自 `@1agents/dreammate-node`（优先 tailnet，回退本地），
 * 保证整台机器上的所有服务共享同一个 node_id 与 name。
 */
import { createAgentRegistry } from '@1agents/acp-service/runtime';
import { loadAgentProfiles } from './agent-profiles.js';
import { nodeIdentity, type NodeIdentity } from '@1agents/dreammate-node';
import {
  PROTOCOL_VERSION,
  type AccessDescriptor,
  type NodeManifest,
  type Reachability,
  type Service as NetworkService,
} from '@1agents/dreammate-network';

export { nodeIdentity, PROTOCOL_VERSION };
export type { AccessDescriptor, NetworkService, NodeIdentity, NodeManifest, Reachability };

/** Profile ids are real Agent endpoints; a broken profile file must not break discovery. */
function agentProfileIds(): string[] {
  try {
    return loadAgentProfiles().profiles.map(profile => profile.id);
  } catch (error) {
    console.warn(`[acp-service] agent profiles ignored in manifest: ${error instanceof Error ? error.message : error}`);
    return [];
  }
}

/**
 * 默认 ACP 运行时端口（36xx2 服务系列约定）
 */
export const DEFAULT_ACP_PORT = 36812;

/**
 * 该 Agent Runtime Service 支持的能力列表
 */
export const ACP_CAPABILITIES = [
  'agent.prompt',
  'agent.session',
  'agent.cancel',
  'agent.mode',
  'agent.response_policy',
  'runtime.claude',
  'runtime.grok',
  'runtime.codex',
] as const;

export async function buildManifest(baseUrl: string): Promise<NodeManifest> {
  const identity = await nodeIdentity();
  const url = new URL(baseUrl);
  const port = url.port || String(DEFAULT_ACP_PORT);

  const atWs = (host: string): AccessDescriptor => ({
    protocol: 'acp',
    base_url: `ws://${host}:${port}`,
  });
  const atHttp = (host: string): AccessDescriptor => ({
    protocol: 'http',
    base_url: `http://${host}:${port}`,
  });

  // MagicDNS 名在前（可读、IP 变了也不用改），tailnet IP 兜底
  const access: AccessDescriptor[] = [
    ...(identity.dnsName ? [atWs(identity.dnsName), atHttp(identity.dnsName)] : []),
    ...(identity.ipv4 && identity.ipv4 !== identity.dnsName
      ? [atWs(identity.ipv4), atHttp(identity.ipv4)]
      : []),
  ];

  return {
    node_id: identity.node_id,
    name: identity.name,
    type: identity.type,
    tailscale_name: identity.dnsName ?? process.env.DREAMMATE_TAILSCALE_NAME?.trim() ?? null,
    online: true,
    metadata: {
      protocol_version: PROTOCOL_VERSION,
      identity_source: identity.source,
      service_type: 'agent_runtime',
      acp_protocol_version: 1,
      acp_transport: 'websocket',
      acp_agent_endpoints: Object.fromEntries([...createAgentRegistry().list(), ...agentProfileIds()].map(name => [name, `/agents/${encodeURIComponent(name)}`])),
    },
    services: [
      {
        id: 'acp-service',
        name: 'acp-service',
        kind: 'agent_runtime',
        capabilities: [...ACP_CAPABILITIES],
        access: access.length > 0 ? access : [atWs(url.hostname), atHttp(url.hostname)],
      },
    ],
  };
}
