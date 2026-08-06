import {
  ClientFactory,
  ClientFactoryOptions,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  RestTransportFactory,
  createAuthenticatingFetchWithRetry,
} from "@a2a-js/sdk/client";

const RETRYABLE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "UND_ERR_CONNECT_TIMEOUT",
  "EPIPE",
]);

function isRetryableError(err: unknown): boolean {
  const code =
    (err as any)?.cause?.code ?? (err as any)?.code ?? "";
  const msg = (err as any)?.message ?? "";
  return (
    RETRYABLE_CODES.has(code) ||
    msg.includes("fetch failed") ||
    msg.includes("ECONNREFUSED")
  );
}

export async function retryOnConnectionError<T>(
  fn: () => Promise<T>,
  opts: { maxRetries?: number; baseDelayMs?: number } = {},
): Promise<T> {
  const { maxRetries = 3, baseDelayMs = 2000 } = opts;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxRetries || !isRetryableError(err)) throw err;
      const delay = baseDelayMs * 2 ** attempt;
      process.stderr.write(
        `Connection failed, retrying in ${(delay / 1000).toFixed(0)}s... (${attempt + 1}/${maxRetries})\n`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

export interface CreateClientOptions {
  token?: string;
  timeoutMs?: number;
}

export async function createClient(
  url: string,
  options: CreateClientOptions = {},
) {
  const { token } = options;

  const authHandler = token
    ? {
        headers: async () => ({ authorization: `Bearer ${token}` }),
        shouldRetryWithHeaders: async () => undefined as any,
      }
    : undefined;

  const authFetch = authHandler
    ? createAuthenticatingFetchWithRetry(fetch, authHandler)
    : fetch;

  const factory = new ClientFactory(
    ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
      cardResolver: new DefaultAgentCardResolver({ fetchImpl: authFetch }),
      transports: [
        new JsonRpcTransportFactory({ fetchImpl: authFetch }),
        new RestTransportFactory({ fetchImpl: authFetch }),
      ],
    }),
  );

  return retryOnConnectionError(() => factory.createFromUrl(url));
}

export function requestOptions(token?: string) {
  return token
    ? { serviceParameters: { authorization: `Bearer ${token}` } }
    : undefined;
}
