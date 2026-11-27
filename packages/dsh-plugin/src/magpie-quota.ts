/** Host half of the Magpie quota plugin shipped with @1agents/acp-service. */
import type { Context } from '@deepseek-ai/cordis'

const DEFAULT_GATEWAY = 'http://127.0.0.1:3425'

function gatewayBase(): string {
  const configured = process.env.MAGPIE_GATEWAY_URL || DEFAULT_GATEWAY
  return configured.replace(/\/+$/, '')
}

const ROUTES = [
  ['/api/magpie-quota/quotas', '/v1/magpie/quotas'],
  ['/api/magpie-quota/usage', '/v1/magpie/usage'],
] as const

export const inject = ['connection']

/**
 * Proxy the local magpie gateway over DSH's authenticated same-origin channel:
 * the gateway answers only on loopback and sends no CORS headers.
 */
export function apply(ctx: Context): void {
  const connection = (ctx as any).connection
  if (!connection || !connection.fetch) return
  for (const [path, upstream] of ROUTES) {
    ctx.effect(() => connection.fetch.register({
      path,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request: Request) => {
        const headers = { 'cache-control': 'no-store' }
        try {
          const response = await fetch(gatewayBase() + upstream, {
            method: 'GET',
            headers: { accept: 'application/json' },
            signal: request.signal,
          })
          const body = await response.text()
          return new Response(body, {
            status: response.status,
            headers: {
              ...headers,
              'content-type': response.headers.get('content-type') || 'application/json',
            },
          })
        } catch (error) {
          return Response.json(
            { error: error instanceof Error ? error.message : String(error) },
            { status: 502, headers },
          )
        }
      },
    }))
  }
}
