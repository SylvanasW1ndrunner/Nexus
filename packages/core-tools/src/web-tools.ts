import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  PREPARED_TOOL_INTENT_REVISION,
  ToolExecutionError,
  expectedToolError,
  type AgentToolPermissionFacts,
  type PreparedToolIntent,
  type ToolExecuteContext,
  type ToolInvocationContribution,
  type ToolPrepareContext,
  type ToolTargetRevalidator,
} from '@dbagent/core-agent';
import type { PortableValue } from '@dbagent/shared';
import {
  SecureWebTransportError,
  canonicalWebUrl,
  parseWebUrl,
  type PreparedWebTarget,
  type SecureWebResponse,
  type SecureWebTransport,
} from './secure-web-transport.js';

const MAX_QUERY_CHARS = 2_048;
const MAX_RESULTS = 20;
const MAX_ADAPTER_RESULTS = 100;
const MAX_TITLE_CHARS = 512;
const MAX_SNIPPET_CHARS = 4_096;
const MAX_URL_CHARS = 8_192;
const MAX_SEARCH_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_FETCH_BYTES = 512 * 1024;
const MAX_FETCH_BYTES = 4 * 1024 * 1024;
const MAX_SOURCE_ID_CHARS = 160;
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 60_000;
const SOURCE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SOURCE_TTL_MS = 7 * SOURCE_TTL_MS;

const SEARCH_LIMITS = Object.freeze({
  timeoutMs: MAX_TIMEOUT_MS,
  maxInputBytes: 64 * 1024,
  maxOutputBytes: 4 * 1024 * 1024,
  maxArtifactBytes: 8 * 1024 * 1024,
  maxDepth: 16,
  maxRecords: 1_000,
});
const FETCH_LIMITS = Object.freeze({
  timeoutMs: MAX_TIMEOUT_MS,
  maxInputBytes: 64 * 1024,
  /** JSON escaping can expand one downloaded byte to six output bytes. */
  maxOutputBytes: 32 * 1024 * 1024,
  maxArtifactBytes: 32 * 1024 * 1024,
  maxDepth: 16,
  maxRecords: 1_000,
});

export type AgentWebSearchResult = Readonly<{
  title: string;
  url: string;
  snippet?: string;
}>;

export type AgentWebSearchRequest = Readonly<{
  /** Static endpoint without query or fragment. */
  endpoint: string;
  queryParameter: string;
  limitParameter?: string;
  acceptedContentTypes?: readonly string[];
}>;

export type AgentWebSearchResponseMapping = Readonly<{
  /** Bounded object keys leading to the provider result array. Empty means the JSON root. */
  resultsPath?: readonly string[];
  titleField: string;
  urlField: string;
  snippetField?: string;
}>;

/** Static Host registration only. No adapter callback executes during prepare or execute. */
export type AgentWebSearchAdapter = Readonly<{
  providerId: string;
  revision: string;
  request: AgentWebSearchRequest;
  response: AgentWebSearchResponseMapping;
}>;

/** Host-facing static search registration. */
export type AgentWebAdapter = AgentWebSearchAdapter;

/** Host bridge headers are snapshotted into the generation closure and are never durable input. */
export type WebSearchCredentials = Readonly<{
  headers: Readonly<Record<string, string>>;
}>;

export type WebSourceOwner = Readonly<{
  hostId: string;
  projectId: string;
  sessionId: string;
  runId: string;
}>;

export type WebSourceRecord = Readonly<{
  sourceId: string;
  url: string;
  origin: 'search' | 'redirect' | 'explicit';
  providerId?: string;
  adapterRevision?: string;
  parentSourceId?: string;
  owner: WebSourceOwner;
  invocationId: string;
  generation: string;
  createdAt: string;
  expiresAt: string;
  binding: string;
}>;

export type WebToolLifecycleContext = Readonly<{
  signal: AbortSignal;
  deadline: string;
}>;

/** Generation-private synchronous store. No executable persistence callback crosses this boundary. */
class InMemoryWebSourceStore {
  #records = new Map<string, WebSourceRecord>();

  constructor(
    private readonly maxRecords = 4_096,
    private readonly clock: () => number = Date.now,
  ) {
    if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 100_000) throw new TypeError('Invalid web source capacity.');
  }

  put(record: WebSourceRecord, context: WebToolLifecycleContext): WebSourceRecord {
    ensureSourceContextActive(context);
    const stored = freezeSourceRecord(record);
    const previous = this.#records;
    const next = new Map(previous);
    this.prune(next);
    next.delete(stored.sourceId);
    next.set(stored.sourceId, stored);
    while (next.size > this.maxRecords) {
      const oldest = next.keys().next().value;
      if (oldest === undefined) break;
      next.delete(oldest);
    }
    ensureSourceContextActive(context);
    this.#records = next;
    try {
      ensureSourceContextActive(context);
    } catch (error) {
      if (this.#records === next) this.#records = previous;
      throw error;
    }
    return stored;
  }

  get(sourceId: string, context: WebToolLifecycleContext): WebSourceRecord | undefined {
    ensureSourceContextActive(context);
    const record = this.#records.get(sourceId);
    ensureSourceContextActive(context);
    return record;
  }

  removeIf(record: WebSourceRecord): void {
    if (this.#records.get(record.sourceId) !== record) return;
    const next = new Map(this.#records);
    next.delete(record.sourceId);
    this.#records = next;
  }

  private prune(records: Map<string, WebSourceRecord>): void {
    const now = this.clock();
    for (const [id, record] of records) {
      if (Date.parse(record.expiresAt) > now) continue;
      records.delete(id);
    }
  }
}

export type WebToolOptions = Readonly<{
  transport?: SecureWebTransport | null;
  searchAdapter?: AgentWebSearchAdapter | null;
  searchCredentials?: WebSearchCredentials | null;
  sourceTtlMs?: number;
  handlerRevisions?: Partial<Readonly<Record<'web_search' | 'web_fetch', string>>>;
}>;

const WEB_GENERATION_BRAND: unique symbol = Symbol('WebToolGeneration');
const trustedWebGenerations = new WeakSet<object>();

export type WebToolGeneration = Readonly<{
  [WEB_GENERATION_BRAND]: true;
  generationId: string;
  contributions: readonly ToolInvocationContribution[];
  revalidateTarget: ToolTargetRevalidator;
  /** The private synchronous source store has no late work; drain always converges immediately. */
  drain(context: WebToolLifecycleContext): Promise<void>;
}>;

/** One Host generation whose handlers and revalidator close over the same transport and source store. */
export function createWebToolGeneration(options: WebToolOptions = {}): WebToolGeneration {
  const transport = options.transport ?? null;
  const adapter = options.searchAdapter === undefined || options.searchAdapter === null
    ? null
    : snapshotSearchAdapter(options.searchAdapter);
  const credentials = adapter === null ? null : snapshotSearchCredentials(options.searchCredentials);
  if (credentials !== null && transport !== null && new URL(adapter!.request.endpoint).protocol !== 'https:') {
    throw new TypeError('Web search credentials require an HTTPS endpoint.');
  }
  const ttlMs = options.sourceTtlMs ?? SOURCE_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_SOURCE_TTL_MS) throw new TypeError('Invalid web source lifetime.');
  const authorityKey = randomBytes(32);
  const generationId = `webauth.v1.${createHash('sha256').update(authorityKey).digest('hex').slice(0, 24)}`;
  const sourceAuthority = new WebSourceAuthority(
    new InMemoryWebSourceStore(),
    ttlMs,
    generationId,
    authorityKey,
  );
  const searchHandlerRevision = authorityBoundHandlerRevision(
    options.handlerRevisions?.web_search ?? 'web_search.handler.v1',
    generationId,
  );
  const fetchHandlerRevision = authorityBoundHandlerRevision(
    options.handlerRevisions?.web_fetch ?? 'web_fetch.handler.v1',
    generationId,
  );
  const contributions = Object.freeze([
    createWebSearchToolContribution({ transport, adapter, credentials, sources: sourceAuthority,
      handlerRevision: searchHandlerRevision }),
    createWebFetchToolContribution({ transport, sources: sourceAuthority,
      handlerRevision: fetchHandlerRevision }),
  ]);
  const generation = Object.freeze({
    [WEB_GENERATION_BRAND]: true as const,
    generationId,
    contributions,
    revalidateTarget: webTargetRevalidator(transport),
    drain: () => Promise.resolve(),
  });
  trustedWebGenerations.add(generation);
  return generation;
}

export function assertWebToolGeneration(value: unknown): asserts value is WebToolGeneration {
  if (value === null || typeof value !== 'object' || !trustedWebGenerations.has(value)) {
    throw new TypeError('Web Tool generation was not issued by the core-tools factory.');
  }
}

function webTargetRevalidator(transport: SecureWebTransport | null | undefined): ToolTargetRevalidator {
  return async (intent, context) => {
    if (intent.permission.toolName !== 'web_search' && intent.permission.toolName !== 'web_fetch') return;
    if (intent.targetIdentity === null) return;
    if (transport === null || transport === undefined) return 'target_changed';
    const target = preparedTarget(intent.targetIdentity);
    if (intent.input.transportRevision !== transport.revision || target.resolverRevision !== transport.resolverRevision) return 'target_changed';
    try {
      return await transport.revalidateTarget(target, { signal: context.signal, deadline: context.deadline }) ? undefined : 'target_changed';
    } catch (error) {
      if (error instanceof SecureWebTransportError && error.code === 'target_changed') return 'target_changed';
      throw mapWebError(error);
    }
  };
}

function createWebSearchToolContribution(options: Readonly<{
  transport: SecureWebTransport | null;
  adapter: AgentWebSearchAdapter | null;
  credentials: Readonly<Record<string, string>> | null;
  sources: WebSourceAuthority;
  handlerRevision: string;
}>): ToolInvocationContribution {
  const toolRevision = 'web_search.v1';
  const handlerRevision = options.handlerRevision;
  return Object.freeze({
    definition: {
      name: 'web_search',
      description: 'Search current external information through a Host adapter and the Runtime secure web transport.',
      aliases: [], tags: ['web', 'search', 'external'],
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['query'], properties: {
          query: { type: 'string', minLength: 1, maxLength: MAX_QUERY_CHARS },
          limit: { type: 'integer', minimum: 1, maximum: MAX_RESULTS },
          timeoutMs: { type: 'integer', minimum: 1_000, maximum: MAX_TIMEOUT_MS },
        },
      },
      outputSchema: {
        type: 'object', additionalProperties: false, required: ['status', 'summary', 'results'], properties: {
          status: { type: 'string', enum: ['ok', 'unavailable'] }, summary: { type: 'string' }, reason: { type: 'string' },
          results: { type: 'array', maxItems: MAX_RESULTS, items: { type: 'object', additionalProperties: false,
            required: ['title', 'url', 'sourceId', 'provenance'], properties: {
              title: { type: 'string' }, url: { type: 'string' }, snippet: { type: 'string' }, sourceId: { type: 'string' }, provenance: { type: 'object' },
            } },
          },
        },
      },
      dangerLevel: 'high', readonly: true, source: 'runtime', exposure: 'direct',
      permission: { actions: ['network', 'credential'], network: true, credentials: true }, access: 'external', recoveryClass: 'read', limits: SEARCH_LIMITS,
      toolRevision, handlerRevision, intentRevision: PREPARED_TOOL_INTENT_REVISION,
      execution: { concurrency: 'exclusive', timeoutMs: SEARCH_LIMITS.timeoutMs },
      failurePolicy: { onUnknown: { failureKind: 'unknown', retryable: false } },
      presentation: { category: 'search', preparingMessage: '正在准备网络搜索。', inputPreview: { argument: 'query', label: 'Query' } },
    },
    runtime: {
      revision: { toolName: 'web_search', toolRevision, handlerRevision, intentRevision: PREPARED_TOOL_INTENT_REVISION },
      async prepare(input, context) {
        const query = boundedString(input.query, 'query', MAX_QUERY_CHARS);
        const limit = optionalInteger(input.limit, 'limit', 1, MAX_RESULTS) ?? 8;
        const timeoutMs = optionalInteger(input.timeoutMs, 'timeoutMs', 1_000, MAX_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS;
        if (options.transport === null || options.adapter === null) {
          return intent(context, { query, limit, timeoutMs, unavailable: true }, null, unavailablePermission('web_search'), 'Search backend is unavailable.', timeoutMs);
        }
        const requestUrl = buildSearchRequestUrl(options.adapter, query, limit);
        const headers: Record<string, PortableValue> = {};
        const acceptedContentTypes = [...(options.adapter.request.acceptedContentTypes ?? ['application/json'])];
        const deadline = new Date(Date.now() + timeoutMs).toISOString();
        const target = await mapWebOperation(() => options.transport!.prepareTarget(requestUrl, { signal: context.signal, deadline }));
        const preparedInput: Record<string, PortableValue> = {
          query, limit, timeoutMs, requestUrl, headers, acceptedContentTypes,
          providerId: options.adapter.providerId, adapterRevision: options.adapter.revision,
          transportRevision: options.transport.revision, credentialPresent: options.credentials !== null,
        };
        return intent(
          context,
          preparedInput,
          target as unknown as PortableValue,
          networkPermission('web_search', target, options.credentials !== null, options.adapter.providerId),
          `Search the web for ${query.slice(0, 512)}.`,
          timeoutMs,
        );
      },
      async execute(input, context) {
        if (input.unavailable === true || options.transport === null || options.adapter === null) return unavailable('search_backend_unavailable');
        if (input.transportRevision !== options.transport.revision || input.adapterRevision !== options.adapter.revision || input.providerId !== options.adapter.providerId) {
          throw expectedToolError('conflict', 'The prepared web search backend changed.');
        }
        if (preparedBoolean(input.credentialPresent, 'credentialPresent') !== (options.credentials !== null)) {
          throw expectedToolError('conflict', 'The prepared web search credential availability changed.');
        }
        const query = preparedString(input.query, 'query');
        const limit = preparedNumber(input.limit, 'limit');
        const target = preparedTarget(context.intent.targetIdentity);
        const response = await mapWebOperation(() => options.transport!.request({
          target,
          headers: preparedHeaders(input.headers),
          ...(options.credentials === null ? {} : { ephemeralHeaders: options.credentials }),
          acceptedContentTypes: preparedStringArray(input.acceptedContentTypes, 'acceptedContentTypes'),
          maxCompressedBytes: MAX_SEARCH_OUTPUT_BYTES,
          maxDecompressedBytes: MAX_SEARCH_OUTPUT_BYTES,
          timeoutMs: preparedNumber(input.timeoutMs, 'timeoutMs'),
          signal: context.signal,
          deadline: context.deadline,
        }));
        if (response.statusCode < 200 || response.statusCode >= 300) throw expectedToolError('external', `The search provider returned HTTP ${response.statusCode}.`, { retryable: response.statusCode >= 500 });
        const validated = parseSearchResponse(response, options.adapter.response, limit);
        const queryDigest = `sha256:${createHash('sha256').update(query).digest('hex')}`;
        const results = [];
        for (const result of validated) {
          const source = options.sources.issue(
            { url: result.url, origin: 'search', providerId: options.adapter.providerId, adapterRevision: options.adapter.revision },
            sourceOperationContext(context, context.deadline),
          );
          results.push({
            ...result,
            sourceId: source.sourceId,
            provenance: { kind: 'web-search', providerId: options.adapter.providerId, adapterRevision: options.adapter.revision, queryDigest },
          });
        }
        if (Buffer.byteLength(JSON.stringify(results), 'utf8') > MAX_SEARCH_OUTPUT_BYTES) throw expectedToolError('limit', 'The validated search results exceed the output limit.');
        return { status: 'ok', summary: `Found ${results.length} web result${results.length === 1 ? '' : 's'}.`, results };
      },
    },
  });
}

function createWebFetchToolContribution(options: Readonly<{
  transport: SecureWebTransport | null;
  sources: WebSourceAuthority;
  handlerRevision: string;
}>): ToolInvocationContribution {
  const toolRevision = 'web_fetch.v1';
  const handlerRevision = options.handlerRevision;
  return Object.freeze({
    definition: {
      name: 'web_fetch',
      description: 'Fetch one bounded web resource by search sourceId or explicit URL without following redirects.',
      aliases: [], tags: ['web', 'fetch', 'external'],
      inputSchema: {
        oneOf: [
          { type: 'object', additionalProperties: false, required: ['sourceId'], properties: {
            sourceId: { type: 'string', minLength: 1, maxLength: MAX_SOURCE_ID_CHARS }, maxBytes: { type: 'integer', minimum: 1, maximum: MAX_FETCH_BYTES }, timeoutMs: { type: 'integer', minimum: 1_000, maximum: MAX_TIMEOUT_MS },
          } },
          { type: 'object', additionalProperties: false, required: ['url'], properties: {
            url: { type: 'string', minLength: 1, maxLength: MAX_URL_CHARS }, maxBytes: { type: 'integer', minimum: 1, maximum: MAX_FETCH_BYTES }, timeoutMs: { type: 'integer', minimum: 1_000, maximum: MAX_TIMEOUT_MS },
          } },
        ],
      },
      outputSchema: {
        type: 'object', additionalProperties: false, required: ['status', 'summary'], properties: {
          status: { type: 'string', enum: ['ok', 'partial', 'unavailable'] }, summary: { type: 'string' }, reason: { type: 'string' },
          sourceId: { type: 'string' }, url: { type: 'string' }, statusCode: { type: 'integer' }, contentType: { type: 'string' }, charset: { type: 'string' },
          text: { type: 'string' }, totalBytes: { type: 'integer' }, provenance: { type: 'object' },
          redirect: { type: 'object', additionalProperties: false, required: ['url', 'sourceId'], properties: { url: { type: 'string' }, sourceId: { type: 'string' } } },
        },
      },
      dangerLevel: 'medium', readonly: true, source: 'runtime', exposure: 'direct',
      permission: { actions: ['network'], network: true }, access: 'external', recoveryClass: 'read', limits: FETCH_LIMITS,
      toolRevision, handlerRevision, intentRevision: PREPARED_TOOL_INTENT_REVISION,
      execution: { concurrency: 'exclusive', timeoutMs: FETCH_LIMITS.timeoutMs },
      failurePolicy: { onUnknown: { failureKind: 'unknown', retryable: false } },
      presentation: { category: 'web', preparingMessage: '正在准备网页读取。', inputPreview: { argument: 'url', label: 'URL' } },
    },
    runtime: {
      revision: { toolName: 'web_fetch', toolRevision, handlerRevision, intentRevision: PREPARED_TOOL_INTENT_REVISION },
      async prepare(input, context) {
        const sourceId = input.sourceId === undefined ? undefined : boundedString(input.sourceId, 'sourceId', MAX_SOURCE_ID_CHARS);
        const explicitUrl = input.url === undefined ? undefined : boundedString(input.url, 'url', MAX_URL_CHARS);
        if ((sourceId === undefined) === (explicitUrl === undefined)) throw expectedToolError('invalid_argument', 'Provide exactly one sourceId or URL.');
        const maxBytes = optionalInteger(input.maxBytes, 'maxBytes', 1, MAX_FETCH_BYTES) ?? DEFAULT_FETCH_BYTES;
        const timeoutMs = optionalInteger(input.timeoutMs, 'timeoutMs', 1_000, MAX_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS;
        if (options.transport === null) {
          return intent(context, { ...(sourceId === undefined ? { url: explicitUrl! } : { sourceId }), maxBytes, timeoutMs, unavailable: true }, null, unavailablePermission('web_fetch'), 'Web fetch backend is unavailable.', timeoutMs);
        }
        const deadline = new Date(Date.now() + timeoutMs).toISOString();
        let source: WebSourceRecord;
        if (sourceId !== undefined) {
          source = options.sources.resolve(sourceId, sourceOperationContext(context, deadline));
        } else {
          const canonical = canonicalUrl(explicitUrl!);
          source = options.sources.issue(
            { url: canonical, origin: 'explicit' },
            sourceOperationContext(context, deadline),
          );
        }
        const target = await mapWebOperation(() => options.transport!.prepareTarget(source.url, { signal: context.signal, deadline }));
        return intent(context, {
          source: sourceRecordToPortable(source), url: source.url, maxBytes, timeoutMs,
          transportRevision: options.transport.revision,
        }, target as unknown as PortableValue, networkPermission('web_fetch', target), `Fetch ${target.url}.`, timeoutMs);
      },
      async execute(input, context) {
        if (input.unavailable === true || options.transport === null) return unavailableFetch('fetch_backend_unavailable');
        if (input.transportRevision !== options.transport.revision) throw expectedToolError('conflict', 'The prepared web fetch backend changed.');
        const source = options.sources.assertActive(
          preparedSourceRecord(input.source),
          sourceOperationContext(context, context.deadline),
        );
        const sourceId = source.sourceId;
        const response = await mapWebOperation(() => options.transport!.request({
          target: preparedTarget(context.intent.targetIdentity),
          acceptedContentTypes: ['text/*', 'application/json', 'application/xml', 'application/xhtml+xml', 'application/rss+xml', 'application/atom+xml'],
          maxCompressedBytes: preparedNumber(input.maxBytes, 'maxBytes'),
          maxDecompressedBytes: preparedNumber(input.maxBytes, 'maxBytes'),
          timeoutMs: preparedNumber(input.timeoutMs, 'timeoutMs'),
          signal: context.signal,
          deadline: context.deadline,
        }));
        if (isRedirectStatusCode(response.statusCode)) {
          const location = response.headers.location;
          if (location === undefined) throw expectedToolError('external', 'The redirect response omitted Location.');
          let redirectUrl: string;
          try {
            redirectUrl = canonicalWebUrl(new URL(location, response.url));
            parseWebUrl(redirectUrl);
          } catch {
            throw expectedToolError('external', 'The redirect Location is invalid.');
          }
          const redirect = options.sources.issue(
            {
              url: redirectUrl, origin: 'redirect', parentSourceId: sourceId,
              ...(source.providerId === undefined ? {} : { providerId: source.providerId }),
              ...(source.adapterRevision === undefined ? {} : { adapterRevision: source.adapterRevision }),
            },
            sourceOperationContext(context, context.deadline),
          );
          return {
            status: 'partial', summary: `HTTP ${response.statusCode} redirect; call web_fetch again for the new sourceId.`,
            sourceId, url: response.url, statusCode: response.statusCode,
            redirect: { url: redirect.url, sourceId: redirect.sourceId },
            provenance: {
              kind: 'web-fetch', transportRevision: options.transport.revision,
              sourceOrigin: source.origin, sourceGeneration: source.generation,
              sourceInvocationId: source.invocationId,
              ...(source.providerId === undefined ? {} : { providerId: source.providerId }),
              ...(source.adapterRevision === undefined ? {} : { adapterRevision: source.adapterRevision }),
            },
          };
        }
        if (response.statusCode === 304) {
          return {
            status: 'partial', summary: 'HTTP 304 returned no representation body.',
            sourceId, url: response.url, statusCode: response.statusCode, text: '', totalBytes: 0,
            provenance: {
              kind: 'web-fetch', transportRevision: options.transport.revision,
              sourceOrigin: source.origin, sourceGeneration: source.generation,
              sourceInvocationId: source.invocationId,
              ...(source.providerId === undefined ? {} : { providerId: source.providerId }),
              ...(source.adapterRevision === undefined ? {} : { adapterRevision: source.adapterRevision }),
            },
          };
        }
        if (response.statusCode < 200 || response.statusCode >= 300) throw expectedToolError('external', `The web server returned HTTP ${response.statusCode}.`, { retryable: response.statusCode >= 500 });
        const text = decodeWebText(response);
        return {
          status: 'ok', summary: `Fetched ${response.body.byteLength} bytes from ${response.url}.`,
          sourceId, url: response.url, statusCode: response.statusCode,
          ...(response.contentType === undefined ? {} : { contentType: response.contentType }),
          ...(response.charset === undefined ? {} : { charset: response.charset }),
          text, totalBytes: response.body.byteLength,
          provenance: {
            kind: 'web-fetch', transportRevision: options.transport.revision, contentEncoding: response.contentEncoding,
            sourceOrigin: source.origin, sourceGeneration: source.generation,
            sourceInvocationId: source.invocationId,
            ...(source.providerId === undefined ? {} : { providerId: source.providerId }),
            ...(source.adapterRevision === undefined ? {} : { adapterRevision: source.adapterRevision }),
          },
        };
      },
    },
  });
}

function intent(
  context: ToolPrepareContext,
  input: Record<string, PortableValue>,
  targetIdentity: PortableValue,
  permission: AgentToolPermissionFacts,
  summary: string,
  timeoutMs: number,
): PreparedToolIntent {
  return Object.freeze({
    input: Object.freeze(input), toolRevision: context.toolRevision, handlerRevision: context.handlerRevision,
    intentRevision: context.intentRevision, generation: context.generation, targetIdentity,
    action: { summary }, permission, access: permission.access, recoveryClass: permission.recoveryClass,
    concurrency: 'exclusive', resourceKeys: permission.hosts.length === 0 ? [`network-unavailable:${permission.toolName}`] : permission.hosts.map(host => `network:${host}`),
    limits: { ...context.limits, timeoutMs: Math.min(context.limits.timeoutMs, timeoutMs) },
  });
}

function networkPermission(
  toolName: 'web_search' | 'web_fetch',
  target: PreparedWebTarget,
  sendsCredentials = false,
  credentialProviderId?: string,
): AgentToolPermissionFacts {
  const addressRisk = target.addresses.some(address => address.risk.loopback || address.risk.private || address.risk.linkLocal || address.risk.metadata || address.risk.special);
  const metadata = target.addresses.some(address => address.risk.metadata);
  const credentials = metadata || sendsCredentials;
  const highRisk = addressRisk || credentials;
  return Object.freeze({
    toolName, dangerLevel: highRisk ? 'high' : 'medium', readonly: true, access: 'external', recoveryClass: 'read',
    actions: Object.freeze(credentials ? ['network', 'credential'] as const : ['network'] as const), paths: Object.freeze([]), hosts: Object.freeze([target.hostname]),
    network: true, externalWrite: false, destructive: false, credentials, admin: false, unknownRisk: addressRisk,
    resolvedAddresses: Object.freeze(target.addresses.map(address => address.address)),
    targets: Object.freeze([{ kind: 'web', protocol: target.protocol, host: target.hostname, port: target.port,
      addresses: target.addresses.map(address => ({ address: address.address, family: address.family, risk: address.risk })),
      ...(credentialProviderId === undefined ? {} : { credentialProviderId }) }]),
  });
}

function unavailablePermission(toolName: 'web_search' | 'web_fetch'): AgentToolPermissionFacts {
  return Object.freeze({
    toolName, dangerLevel: 'safe', readonly: true, access: 'external', recoveryClass: 'read', actions: Object.freeze([]),
    paths: Object.freeze([]), hosts: Object.freeze([]), network: false, externalWrite: false, destructive: false,
    credentials: false, admin: false, unknownRisk: false, resolvedAddresses: Object.freeze([]),
    targets: Object.freeze([{ kind: 'web-backend', availability: 'unavailable' }]),
  });
}

function unavailable(reason: string) {
  return { status: 'unavailable' as const, summary: 'The Host web search backend is unavailable; configure an external search backend and retry.', reason, results: [] };
}

function unavailableFetch(reason: string) {
  return { status: 'unavailable' as const, summary: 'The Host web fetch backend is unavailable; configure an external transport backend and retry.', reason };
}

function snapshotSearchAdapter(adapter: AgentWebSearchAdapter): AgentWebSearchAdapter {
  assertPlainDataObject(adapter, 'web search adapter');
  const providerId = boundedStaticIdentifier(adapter.providerId, 'providerId');
  const revision = boundedStaticRevision(adapter.revision, 'revision');
  assertPlainDataObject(adapter.request, 'web search request template');
  const parsedEndpoint = parseStaticEndpoint(adapter.request.endpoint);
  const queryParameter = boundedQueryName(adapter.request.queryParameter, 'queryParameter');
  const limitParameter = adapter.request.limitParameter === undefined
    ? undefined
    : boundedQueryName(adapter.request.limitParameter, 'limitParameter');
  if (limitParameter === queryParameter) throw new TypeError('Search query and limit parameter names must differ.');
  const acceptedContentTypes = snapshotContentTypes(adapter.request.acceptedContentTypes ?? ['application/json']);
  assertPlainDataObject(adapter.response, 'web search response mapping');
  const resultsPath = snapshotFieldPath(adapter.response.resultsPath ?? []);
  const titleField = boundedFieldName(adapter.response.titleField, 'titleField');
  const urlField = boundedFieldName(adapter.response.urlField, 'urlField');
  const snippetField = adapter.response.snippetField === undefined
    ? undefined
    : boundedFieldName(adapter.response.snippetField, 'snippetField');
  return Object.freeze({
    providerId,
    revision,
    request: Object.freeze({
      endpoint: parsedEndpoint,
      queryParameter,
      ...(limitParameter === undefined ? {} : { limitParameter }),
      acceptedContentTypes,
    }),
    response: Object.freeze({
      resultsPath,
      titleField,
      urlField,
      ...(snippetField === undefined ? {} : { snippetField }),
    }),
  });
}

function snapshotSearchCredentials(value: WebSearchCredentials | null | undefined): Readonly<Record<string, string>> | null {
  if (value === undefined || value === null) return null;
  assertPlainDataObject(value, 'web search credentials');
  assertPlainDataObject(value.headers, 'web search credential headers');
  const headers: Record<string, string> = {};
  const descriptors = Object.getOwnPropertyDescriptors(value.headers);
  if (Object.keys(descriptors).length < 1 || Object.keys(descriptors).length > 16) throw new TypeError('Web search credential headers are invalid.');
  for (const [rawName, descriptor] of Object.entries(descriptors)) {
    if (!('value' in descriptor) || typeof descriptor.value !== 'string') throw new TypeError('Web search credential headers must be plain string values.');
    const name = rawName.trim().toLowerCase();
    if (!validHeaderName(name) || controlledHeader(name) || name.length > 128 || descriptor.value.length < 1 || descriptor.value.length > 8_192 || /[\r\n]/u.test(descriptor.value)) {
      throw new TypeError('A web search credential header is invalid.');
    }
    headers[name] = descriptor.value;
  }
  return Object.freeze(headers);
}

function buildSearchRequestUrl(adapter: AgentWebSearchAdapter, query: string, limit: number): string {
  const url = new URL(adapter.request.endpoint);
  url.searchParams.set(adapter.request.queryParameter, query);
  if (adapter.request.limitParameter !== undefined) url.searchParams.set(adapter.request.limitParameter, String(limit));
  return canonicalWebUrl(url);
}

function parseSearchResponse(
  response: SecureWebResponse,
  mapping: AgentWebSearchResponseMapping,
  limit: number,
): AgentWebSearchResult[] {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(response.body);
  } catch {
    throw expectedToolError('external', 'The search provider response is not valid UTF-8 JSON.');
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw expectedToolError('external', 'The search provider returned invalid JSON.');
  }
  assertBoundedJson(value, 0, { nodes: 0, bytes: 0 });
  for (const field of mapping.resultsPath ?? []) {
    if (!isPlainJsonObject(value) || !Object.prototype.hasOwnProperty.call(value, field)) {
      throw expectedToolError('external', 'The search provider result path is missing.');
    }
    value = value[field];
  }
  if (!Array.isArray(value) || value.length > MAX_ADAPTER_RESULTS) throw expectedToolError('external', 'The search provider returned an invalid result list.');
  return value.slice(0, limit).map((item) => {
    if (!isPlainJsonObject(item)) throw expectedToolError('external', 'A search result is invalid.');
    const title = boundedExternalString(item[mapping.titleField], 'title', MAX_TITLE_CHARS);
    const url = canonicalUrl(boundedExternalString(item[mapping.urlField], 'url', MAX_URL_CHARS));
    const snippetValue = mapping.snippetField === undefined ? undefined : item[mapping.snippetField];
    const snippet = snippetValue === undefined ? undefined : boundedExternalString(snippetValue, 'snippet', MAX_SNIPPET_CHARS, true);
    return Object.freeze({ title, url, ...(snippet === undefined ? {} : { snippet }) });
  });
}

function assertBoundedJson(value: unknown, depth: number, state: { nodes: number; bytes: number }): void {
  state.nodes += 1;
  if (depth > 12 || state.nodes > 5_000) throw expectedToolError('limit', 'The search provider result is too deeply nested or too large.');
  if (typeof value === 'string') state.bytes += Buffer.byteLength(value, 'utf8');
  else if (Array.isArray(value)) {
    for (const nested of value) assertBoundedJson(nested, depth + 1, state);
  } else if (isPlainJsonObject(value)) {
    for (const key of Object.keys(value)) {
      state.bytes += Buffer.byteLength(key, 'utf8');
      assertBoundedJson(value[key], depth + 1, state);
    }
  } else if (value !== null && typeof value === 'object') {
    throw expectedToolError('external', 'The search provider result contains an unsupported value.');
  }
  if (state.bytes > MAX_SEARCH_OUTPUT_BYTES) throw expectedToolError('limit', 'The search provider result exceeds its byte limit.');
}

type SourceIssueInput = Readonly<Pick<WebSourceRecord, 'url' | 'origin'> & Partial<Pick<WebSourceRecord,
  'providerId' | 'adapterRevision' | 'parentSourceId'>>>;

type SourceOperationContext = WebToolLifecycleContext & Readonly<{
  owner: WebSourceOwner;
  invocationId: string;
}>;

class WebSourceAuthority {
  readonly #key: Buffer;

  constructor(
    private readonly store: InMemoryWebSourceStore,
    private readonly ttlMs: number,
    private readonly generationId: string,
    key: Uint8Array,
    private readonly clock: () => number = Date.now,
  ) {
    this.#key = Buffer.from(key);
  }

  issue(input: SourceIssueInput, context: SourceOperationContext): WebSourceRecord {
    ensureSourceContextActive(context);
    const now = this.clock();
    const unsigned = {
      sourceId: `web_${randomBytes(24).toString('base64url')}`,
      url: canonicalUrl(input.url),
      origin: input.origin,
      ...(input.providerId === undefined ? {} : { providerId: boundedStaticIdentifier(input.providerId, 'providerId') }),
      ...(input.adapterRevision === undefined ? {} : { adapterRevision: boundedStaticRevision(input.adapterRevision, 'adapterRevision') }),
      ...(input.parentSourceId === undefined ? {} : { parentSourceId: requireValidSourceId(input.parentSourceId) }),
      owner: context.owner,
      invocationId: boundedOwnerId(context.invocationId, 'invocationId'),
      generation: this.generationId,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.ttlMs).toISOString(),
    };
    const record = freezeSourceRecord({ ...unsigned, binding: this.sign(unsigned) });
    const stored = this.store.put(record, context);
    try {
      ensureSourceContextActive(context);
      return this.assertRecord(stored, context, record.sourceId);
    } catch (error) {
      this.store.removeIf(stored);
      throw error;
    }
  }

  resolve(sourceId: string, context: SourceOperationContext): WebSourceRecord {
    const id = requireValidSourceId(sourceId);
    const record = this.store.get(id, context);
    ensureSourceContextActive(context);
    if (record === undefined) throw expectedToolError('not_found', 'The web sourceId is unknown or expired; use the explicit URL or search again.');
    return this.assertRecord(record, context, id);
  }

  assertActive(record: WebSourceRecord, context: SourceOperationContext): WebSourceRecord {
    return this.assertRecord(record, context, record.sourceId);
  }

  private assertRecord(value: WebSourceRecord, context: SourceOperationContext, sourceId: string): WebSourceRecord {
    const record = freezeSourceRecord(value);
    const createdAt = Date.parse(record.createdAt);
    const expiresAt = Date.parse(record.expiresAt);
    const now = this.clock();
    if (record.sourceId !== sourceId || !Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || createdAt > now ||
      expiresAt <= createdAt || expiresAt - createdAt > this.ttlMs || expiresAt <= now || !sameSourceOwner(record.owner, context.owner) ||
      record.generation !== this.generationId || !this.verify(record)) {
      throw expectedToolError('not_found', 'The web sourceId is unknown, expired, or outside this Run.');
    }
    return record;
  }

  private sign(record: Omit<WebSourceRecord, 'binding'>): string {
    return createHmac('sha256', this.#key).update(sourceBindingPayload(record)).digest('base64url');
  }

  private verify(record: WebSourceRecord): boolean {
    if (!/^[a-zA-Z0-9_-]{43}$/u.test(record.binding)) return false;
    const expected = Buffer.from(this.sign(record), 'utf8');
    const actual = Buffer.from(record.binding, 'utf8');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
}

function sourceOperationContext(
  context: ToolPrepareContext | ToolExecuteContext,
  deadline: string,
): SourceOperationContext {
  return Object.freeze({
    owner: Object.freeze({
      hostId: boundedOwnerId(context.hostId, 'hostId'),
      projectId: boundedOwnerId(context.projectId, 'projectId', true),
      sessionId: boundedOwnerId(context.sessionId, 'sessionId'),
      runId: boundedOwnerId(context.runId, 'runId'),
    }),
    invocationId: boundedOwnerId(context.invocationId, 'invocationId'),
    signal: context.signal,
    deadline,
  });
}

function sourceRecordToPortable(record: WebSourceRecord): PortableValue {
  return {
    sourceId: record.sourceId,
    url: record.url,
    origin: record.origin,
    ...(record.providerId === undefined ? {} : { providerId: record.providerId }),
    ...(record.adapterRevision === undefined ? {} : { adapterRevision: record.adapterRevision }),
    ...(record.parentSourceId === undefined ? {} : { parentSourceId: record.parentSourceId }),
    owner: { ...record.owner },
    invocationId: record.invocationId,
    generation: record.generation,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    binding: record.binding,
  };
}

function preparedSourceRecord(value: PortableValue | undefined): WebSourceRecord {
  if (value === undefined) throw expectedToolError('precondition', 'The prepared web source is missing.');
  try {
    return freezeSourceRecord(value as unknown as WebSourceRecord);
  } catch {
    throw expectedToolError('precondition', 'The prepared web source is invalid.');
  }
}

function freezeSourceRecord(value: WebSourceRecord): WebSourceRecord {
  assertPlainDataObject(value, 'web source record');
  assertPlainDataObject(value.owner, 'web source owner');
  const origin = value.origin;
  if (origin !== 'search' && origin !== 'redirect' && origin !== 'explicit') throw new TypeError('Invalid web source origin.');
  const providerId = value.providerId === undefined ? undefined : boundedStaticIdentifier(value.providerId, 'providerId');
  const adapterRevision = value.adapterRevision === undefined ? undefined : boundedStaticRevision(value.adapterRevision, 'adapterRevision');
  if (origin === 'search' && (providerId === undefined || adapterRevision === undefined)) throw new TypeError('Search sources require provider identity.');
  const parentSourceId = value.parentSourceId === undefined ? undefined : requireValidSourceId(value.parentSourceId);
  if (origin === 'redirect' && parentSourceId === undefined) throw new TypeError('Redirect sources require a parent sourceId.');
  if (typeof value.createdAt !== 'string' || value.createdAt.length > 64 || typeof value.expiresAt !== 'string' || value.expiresAt.length > 64 ||
    typeof value.binding !== 'string' || value.binding.length > 128) throw new TypeError('Invalid web source lifecycle.');
  return Object.freeze({
    sourceId: requireValidSourceId(value.sourceId),
    url: canonicalUrl(value.url),
    origin,
    ...(providerId === undefined ? {} : { providerId }),
    ...(adapterRevision === undefined ? {} : { adapterRevision }),
    ...(parentSourceId === undefined ? {} : { parentSourceId }),
    owner: Object.freeze({
      hostId: boundedOwnerId(value.owner.hostId, 'hostId'),
      projectId: boundedOwnerId(value.owner.projectId, 'projectId', true),
      sessionId: boundedOwnerId(value.owner.sessionId, 'sessionId'),
      runId: boundedOwnerId(value.owner.runId, 'runId'),
    }),
    invocationId: boundedOwnerId(value.invocationId, 'invocationId'),
    generation: boundedStaticRevision(value.generation, 'generation'),
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    binding: value.binding,
  });
}

function sourceBindingPayload(record: Omit<WebSourceRecord, 'binding'> | WebSourceRecord): string {
  return JSON.stringify({
    sourceId: record.sourceId,
    url: record.url,
    origin: record.origin,
    providerId: record.providerId ?? null,
    adapterRevision: record.adapterRevision ?? null,
    parentSourceId: record.parentSourceId ?? null,
    owner: record.owner,
    invocationId: record.invocationId,
    generation: record.generation,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  });
}

function sameSourceOwner(left: WebSourceOwner, right: WebSourceOwner): boolean {
  return left.hostId === right.hostId && left.projectId === right.projectId && left.sessionId === right.sessionId && left.runId === right.runId;
}

function ensureSourceContextActive(context: WebToolLifecycleContext): void {
  if (context.signal.aborted) throw cancelledToolError();
  const deadline = Date.parse(context.deadline);
  if (!Number.isFinite(deadline) || deadline <= Date.now()) throw timedOutToolError();
}

function cancelledToolError(): ToolExecutionError {
  return new ToolExecutionError({ code: 'TOOL_CANCELLED', category: 'cancelled', retryable: false, outcome: 'not_applied' });
}

function timedOutToolError(): ToolExecutionError {
  return new ToolExecutionError({ code: 'TOOL_TIMEOUT', category: 'timeout', retryable: true, outcome: 'not_applied' });
}

function parseStaticEndpoint(value: string): string {
  let parsed: URL;
  try {
    parsed = parseWebUrl(value);
  } catch {
    throw new TypeError('The web search endpoint must be a valid HTTP or HTTPS URL.');
  }
  if (parsed.search !== '' || parsed.hash !== '') throw new TypeError('The web search endpoint cannot contain query parameters or a fragment.');
  return canonicalWebUrl(parsed);
}

function snapshotContentTypes(value: readonly string[]): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) throw new TypeError('The web search content types are invalid.');
  return Object.freeze(value.map(item => {
    if (typeof item !== 'string' || !/^[a-z0-9.+*-]+\/[a-z0-9.+*-]+$/u.test(item) || item.length > 128) throw new TypeError('The web search content types are invalid.');
    return item.toLowerCase();
  }));
}

function snapshotFieldPath(value: readonly string[]): readonly string[] {
  if (!Array.isArray(value) || value.length > 8) throw new TypeError('The web search result path is invalid.');
  const path: string[] = [];
  for (const [index, field] of value.entries()) {
    if (typeof field !== 'string') throw new TypeError('The web search result path is invalid.');
    path.push(boundedFieldName(field, `resultsPath[${index}]`));
  }
  return Object.freeze(path);
}

function boundedStaticIdentifier(value: string, label: string): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/u.test(value)) throw new TypeError(`Invalid web search ${label}.`);
  return value;
}

function boundedStaticRevision(value: string, label: string): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9._:@/-]{1,128}$/u.test(value)) throw new TypeError(`Invalid web ${label}.`);
  return value;
}

function authorityBoundHandlerRevision(base: string, authorityRevision: string): string {
  const suffix = `@${boundedStaticRevision(authorityRevision, 'authority revision')}`;
  if (typeof base !== 'string' || base.length < 1 || base.length > 128 - suffix.length ||
    !/^[a-zA-Z0-9._:@/-]+$/u.test(base)) {
    throw new TypeError('Invalid web handler revision base.');
  }
  return `${base}${suffix}`;
}

function boundedQueryName(value: string, label: string): string {
  if (typeof value !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/u.test(value)) throw new TypeError(`Invalid web search ${label}.`);
  return value;
}

function boundedFieldName(value: string, label: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128 || hasControlCharacters(value)) throw new TypeError(`Invalid web search ${label}.`);
  return value;
}

function boundedOwnerId(value: string, label: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length < 1) || value.length > 512 || hasControlCharacters(value)) throw new TypeError(`Invalid web source ${label}.`);
  return value;
}

function requireValidSourceId(value: string): string {
  if (!validSourceId(value)) throw new TypeError('Invalid web sourceId.');
  return value;
}

function validSourceId(value: string): boolean {
  return typeof value === 'string' && /^web_[a-zA-Z0-9_-]{32}$/u.test(value);
}

function assertPlainDataObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be a plain data object.`);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${label} must be a plain data object.`);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!('value' in descriptor)) throw new TypeError(`${label} cannot contain accessors.`);
  }
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function decodeWebText(response: SecureWebResponse): string {
  const encoding = response.charset ?? 'utf-8';
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(response.body);
  } catch {
    throw expectedToolError('external', `The web response body is not valid ${encoding} text.`);
  }
}

function isRedirectStatusCode(statusCode: number): boolean {
  return statusCode === 300 || statusCode === 301 || statusCode === 302 || statusCode === 303 || statusCode === 307 || statusCode === 308;
}

function validHeaderName(value: string): boolean {
  return /^[a-z0-9!#$%&'*+.^_`|~-]+$/u.test(value);
}

function controlledHeader(value: string): boolean {
  return value === 'host' || value === 'connection' || value === 'content-length' || value === 'transfer-encoding' || value === 'proxy-authorization';
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) <= 0x1f) return true;
  }
  return false;
}

function hasDisallowedTextControls(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x08 || code === 0x0b || code === 0x0c || (code >= 0x0e && code <= 0x1f)) return true;
  }
  return false;
}

function canonicalUrl(value: string): string {
  try {
    return canonicalWebUrl(value);
  } catch (error) {
    throw mapWebError(error);
  }
}

function boundedString(value: PortableValue | undefined, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maximum) throw expectedToolError('invalid_argument', `${label} must contain 1-${maximum} bounded characters.`);
  return value.trim();
}

function boundedExternalString(value: unknown, label: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.trim() === '') || value.length > maximum || hasDisallowedTextControls(value)) throw expectedToolError('external', `The search result ${label} is invalid.`);
  return value.trim();
}

function optionalInteger(value: PortableValue | undefined, label: string, minimum: number, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw expectedToolError('invalid_argument', `${label} must be an integer from ${minimum} to ${maximum}.`);
  return value;
}

function preparedString(value: PortableValue | undefined, label: string): string {
  if (typeof value !== 'string') throw expectedToolError('precondition', `Prepared ${label} is invalid.`);
  return value;
}

function preparedNumber(value: PortableValue | undefined, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw expectedToolError('precondition', `Prepared ${label} is invalid.`);
  return value;
}

function preparedBoolean(value: PortableValue | undefined, label: string): boolean {
  if (typeof value !== 'boolean') throw expectedToolError('precondition', `Prepared ${label} is invalid.`);
  return value;
}

function preparedHeaders(value: PortableValue | undefined): Readonly<Record<string, string>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw expectedToolError('precondition', 'Prepared web headers are invalid.');
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') throw expectedToolError('precondition', 'Prepared web headers are invalid.');
    result[key] = item;
  }
  return result;
}

function preparedStringArray(value: PortableValue | undefined, label: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw expectedToolError('precondition', `Prepared ${label} is invalid.`);
  return [...value] as string[];
}

function preparedTarget(value: PortableValue): PreparedWebTarget {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw expectedToolError('precondition', 'The prepared web target is invalid.');
  const target = value as unknown as PreparedWebTarget;
  if (typeof target.url !== 'string' || typeof target.hostname !== 'string' || !Array.isArray(target.addresses)) throw expectedToolError('precondition', 'The prepared web target is invalid.');
  return target;
}

async function mapWebOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw mapWebError(error);
  }
}

function mapWebError(error: unknown): Error {
  if (error instanceof ToolExecutionError) return error;
  if (!(error instanceof SecureWebTransportError)) return expectedToolError('external', 'The secure web backend failed.', { retryable: true });
  switch (error.code) {
    case 'invalid_url': return expectedToolError('invalid_argument', error.message);
    case 'target_changed': return new ToolExecutionError({ code: 'target_changed', category: 'precondition', retryable: true, outcome: 'not_applied' }, error.message);
    case 'limit': return expectedToolError('limit', error.message);
    case 'unsupported_content': return expectedToolError('precondition', error.message);
    case 'cancelled': return new ToolExecutionError({ code: 'TOOL_CANCELLED', category: 'cancelled', retryable: false, outcome: 'not_applied' }, error.message);
    case 'timeout': return new ToolExecutionError({ code: 'TOOL_TIMEOUT', category: 'timeout', retryable: true, outcome: 'not_applied' }, error.message);
    case 'dns':
    case 'tls':
    case 'invalid_response':
    case 'network':
      return expectedToolError('external', error.message, { retryable: error.code === 'dns' || error.code === 'network' });
  }
}
