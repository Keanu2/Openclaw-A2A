/**
 * Map fetch() calls onto TunnelSession.forward() — path/query/body preserved,
 * host ignored (same effective behavior as pointing A2A at tunnel-client localPort).
 */

import { filterHeaders, type TunnelHttpRequest } from "./protocol.js";
import type { TunnelSession } from "./session.js";

function headersToRecord(headers: HeadersInit | undefined): Record<string, string | string[]> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    const out: Record<string, string> = {};
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    const out: Record<string, string> = {};
    for (const [key, value] of headers) out[key] = value;
    return out;
  }
  return { ...(headers as Record<string, string>) };
}

async function bodyToString(body: BodyInit | null | undefined): Promise<string> {
  if (body == null) return "";
  if (typeof body === "string") return body;
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString("utf8");
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("utf8");
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) return body.text();
  // URLSearchParams / FormData / streams — best-effort
  return String(body);
}

function resolveUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

export function createTunnelFetch(
  session: TunnelSession,
  targetDevice: string,
): typeof fetch {
  const tunnelFetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(resolveUrl(input));
    const path = `${url.pathname}${url.search}`;
    const method = (init?.method || (typeof input !== "string" && !(input instanceof URL) ? input.method : "GET") || "GET").toUpperCase();

    let headers = headersToRecord(init?.headers);
    if (typeof input !== "string" && !(input instanceof URL) && input.headers) {
      headers = { ...headersToRecord(input.headers), ...headers };
    }

    let body = "";
    if (init?.body != null) {
      body = await bodyToString(init.body);
    } else if (typeof input !== "string" && !(input instanceof URL)) {
      try {
        body = await input.clone().text();
      } catch {
        body = "";
      }
    }

    const httpRequest: TunnelHttpRequest = {
      method,
      path,
      headers: filterHeaders(headers),
      body,
    };

    const result = await session.forward(targetDevice, httpRequest);

    const responseHeaders = new Headers();
    for (const [key, value] of Object.entries(result.headers || {})) {
      if (value == null) continue;
      if (Array.isArray(value)) {
        for (const v of value) responseHeaders.append(key, v);
      } else {
        responseHeaders.set(key, value);
      }
    }

    return new Response(result.body, {
      status: result.status,
      headers: responseHeaders,
    });
  };

  return tunnelFetch as typeof fetch;
}
