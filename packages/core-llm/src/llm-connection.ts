import { createHash, randomUUID } from 'node:crypto';

export type LlmConnectionInput = {
  name?: string;
  endpoint: string;
  apiKey?: string;
  headers?: Record<string, string>;
  /** Opaque revision persisted by the settings store when connection configuration changes. */
  connectionConfigurationRevision?: string;
  /** Opaque revision persisted by the secret store when credentials change. */
  credentialRevision?: string;
};

export type LlmConnection = {
  id: string;
  name: string;
  endpoint: string;
  apiKey?: string;
  headers: Readonly<Record<string, string>>;
  connectionConfigurationRevision: string;
  credentialRevision: string;
  /** Compatibility alias. This is an opaque revision, never a secret-derived hash. */
  credentialScope: string;
};

export function createLlmConnection(input: LlmConnectionInput): LlmConnection {
  const endpoint = normalizeLlmEndpoint(input.endpoint);
  const explicitName = input.name?.trim();
  const name = explicitName || new URL(endpoint).host;
  const headers = normalizeHeaders(input.headers);
  const id = deriveLlmConnectionId({
    endpoint,
    ...(explicitName === undefined ? {} : { name: explicitName }),
  });
  const connectionConfigurationRevision = opaqueRevision(
    input.connectionConfigurationRevision,
    'connectionConfigurationRevision',
  );
  const credentialRevision = opaqueRevision(input.credentialRevision, 'credentialRevision');
  return Object.freeze({
    id,
    name,
    endpoint,
    ...(input.apiKey?.trim() ? { apiKey: input.apiKey.trim() } : {}),
    headers: Object.freeze(headers),
    connectionConfigurationRevision,
    credentialRevision,
    credentialScope: credentialRevision,
  });
}

export function normalizeLlmEndpoint(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint.trim());
  } catch {
    throw new Error('Endpoint must be an absolute HTTP or HTTPS URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Endpoint must use HTTP or HTTPS.');
  }
  if (url.username || url.password) {
    throw new Error('Endpoint must not contain embedded credentials.');
  }
  if (url.search || url.hash) {
    throw new Error('Endpoint must not contain a query string or fragment.');
  }
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

export function deriveLlmConnectionId(
  connection: Pick<LlmConnectionInput, 'endpoint' | 'name'>,
): string {
  const endpoint = normalizeLlmEndpoint(connection.endpoint);
  const name = connection.name?.trim().toLocaleLowerCase() ?? '';
  return `llm_${createHash('sha256').update(`${endpoint}\0${name}`).digest('hex').slice(0, 20)}`;
}

export function appendLlmEndpointPath(endpoint: string, path: string): string {
  const normalizedEndpoint = normalizeLlmEndpoint(endpoint);
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${normalizedEndpoint}${normalizedPath}`;
}

export function isPrivateLlmEndpoint(endpoint: string): boolean {
  const hostname = new URL(normalizeLlmEndpoint(endpoint)).hostname.toLocaleLowerCase();
  if (hostname === 'localhost' || hostname === '::1' || hostname.endsWith('.localhost')) return true;
  if (/^127\./.test(hostname) || /^10\./.test(hostname) || /^192\.168\./.test(hostname)) return true;
  const match = /^172\.(\d{1,3})\./.exec(hostname);
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true;
  return hostname.startsWith('fc') || hostname.startsWith('fd') || hostname.startsWith('fe80:');
}

function normalizeHeaders(input?: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(input ?? {})) {
    const name = rawName.trim();
    if (!name) throw new Error('LLM connection header names must not be empty.');
    if (/[^!#$%&'*+\-.^_`|~0-9A-Za-z]/.test(name)) {
      throw new Error(`Invalid LLM connection header name: ${name}.`);
    }
    if (rawValue.includes('\r') || rawValue.includes('\n')) {
      throw new Error(`Invalid newline in LLM connection header: ${name}.`);
    }
    result[name] = rawValue;
  }
  return result;
}

function opaqueRevision(input: string | undefined, name: string): string {
  if (input === undefined) return randomUUID();
  const revision = input.trim();
  if (revision.length === 0) throw new Error(`${name} must not be empty.`);
  return revision;
}
