import { publicErrorMessage } from "./errors.js";
import type { NodeHandler } from "./handler.js";

/** Live Council preview. The dashboard Vercel project serves this path. */
export const PUBLIC_MCP_URL = "https://sa-council-dashboard-preview.vercel.app/api/mcp";

/** Return before the platform cuts the invocation off, so the client gets a clean error. */
export const REQUEST_TIMEOUT_MS = 20_000;

/** Under Vercel's 4.5 MB response limit. A larger body is replaced, not truncated. */
export const MAX_RESPONSE_BYTES = 512 * 1024;

/** Same cap on the request body. A larger body is refused before the handler runs. */
export const MAX_REQUEST_BYTES = 512 * 1024;

const CORS_HEADERS: Readonly<Record<string, string>> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, accept, mcp-session-id, mcp-protocol-version, last-event-id, authorization",
  "access-control-expose-headers": "mcp-session-id",
  "access-control-max-age": "86400",
};

export function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value);
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function jsonRpcError(message: string, status = 500): Response {
  return withCors(
    new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message }, id: null }), {
      status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    }),
  );
}

/**
 * Limits in front of the stateless MCP handler.
 * The rate limiter behind this is in-memory and per instance.
 */
export function createPublicMcpFetch(
  handler: NodeHandler,
  options?: { timeoutMs?: number; maxBytes?: number; maxRequestBytes?: number },
): (request: Request) => Promise<Response> {
  const timeoutMs = options?.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const maxBytes = options?.maxBytes ?? MAX_RESPONSE_BYTES;
  const maxRequestBytes = options?.maxRequestBytes ?? MAX_REQUEST_BYTES;

  return async (request: Request): Promise<Response> => {
    if (request.method === "OPTIONS") return withCors(new Response(null, { status: 204 }));

    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = (async () => {
      const prepared = await limitedRequest(request, maxRequestBytes);
      if (prepared instanceof Response) return prepared;
      return handler.fetch(prepared);
    })().catch((error: unknown) => jsonRpcError(publicErrorMessage(error)));
    const timeout = new Promise<Response>((resolve) => {
      timer = setTimeout(() => resolve(jsonRpcError("The read timed out. No data was invented.", 504)), timeoutMs);
    });
    try {
      const response = await Promise.race([pending, timeout]);
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > maxBytes) {
        return jsonRpcError("The response exceeded the size cap. No partial data was returned.", 413);
      }
      const headers = new Headers(response.headers);
      headers.set("content-length", String(bytes.byteLength));
      return withCors(new Response(bytes, { status: response.status, statusText: response.statusText, headers }));
    } catch (error) {
      return jsonRpcError(publicErrorMessage(error));
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

const REQUEST_TOO_LARGE = "The request exceeded the size cap.";

async function limitedRequest(request: Request, maxRequestBytes: number): Promise<Request | Response> {
  if (request.method === "GET" || request.method === "HEAD") return request;
  const declared = request.headers.get("content-length");
  if (declared !== null && declared !== "") {
    if (!/^\d+$/.test(declared)) return jsonRpcError("The request body size could not be read.", 400);
    if (BigInt(declared) > BigInt(maxRequestBytes)) {
      await request.body?.cancel().catch(() => undefined);
      return jsonRpcError(REQUEST_TOO_LARGE, 413);
    }
  }
  if (request.body === null) return request;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxRequestBytes) {
      await reader.cancel().catch(() => undefined);
      return jsonRpcError(REQUEST_TOO_LARGE, 413);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  return new Request(request.url, {
    method: request.method,
    headers,
    body: body.byteLength > 0 ? body : undefined,
    signal: request.signal,
  });
}
