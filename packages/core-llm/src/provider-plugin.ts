import type { LlmConnection } from './llm-connection.js';
import type {
  LlmGenerationConfig,
  LlmGenerationParameterSupport,
  LlmProvider,
  LlmProviderError,
} from './types.js';

export type LlmFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type LlmRouteEvidenceSource = 'plugin' | 'endpoint' | 'runtime';

export type LlmRouteEvidence = {
  source: LlmRouteEvidenceSource;
  kind: string;
  summary: string;
  statusCode?: number;
};

export type LlmProviderPluginManifest = {
  id: string;
  name: string;
  version: string;
  protocol: string;
  priority: number;
};

export type LlmProviderMatch = {
  score: number;
  evidence: readonly LlmRouteEvidence[];
};

export type LlmPassiveJsonRequest = {
  path: string;
  headers?: Record<string, string>;
};

export type LlmPassiveJsonResponse = {
  url: string;
  status: number;
  ok: boolean;
  headers: Readonly<Record<string, string>>;
  json?: unknown;
};

export type LlmProviderDiscoveryContext = {
  connection: LlmConnection;
  signal: AbortSignal;
  getJson(request: LlmPassiveJsonRequest): Promise<LlmPassiveJsonResponse>;
};

export type LlmProviderDiscovery = {
  score: number;
  models?: readonly string[];
  evidence: readonly LlmRouteEvidence[];
  providerBaseUrl?: string;
};

export type LlmConnectionResolution = {
  connectionId: string;
  providerId: string;
  pluginId: string;
  pluginVersion: string;
  protocol: string;
  providerBaseUrl: string;
  models: readonly string[];
  revision: string;
  evidence: readonly LlmRouteEvidence[];
};

export type LlmResolvedRoute = {
  connectionId: string;
  modelId: string;
  providerId: string;
  pluginId: string;
  protocol: string;
  revision: string;
  evidence: readonly LlmRouteEvidence[];
};

export type LlmProviderCreationContext = {
  connection: LlmConnection;
  resolution: LlmConnectionResolution;
  fetch: LlmFetch;
  timeoutMs: number;
};

export type LlmParameterAdapter = {
  support?: Partial<LlmGenerationParameterSupport>;
  normalize?(config: LlmGenerationConfig): LlmGenerationConfig;
};

export type LlmProviderErrorClassifier = {
  classify(error: unknown): LlmProviderError | undefined;
};

export type LlmProviderPlugin = {
  manifest: LlmProviderPluginManifest;
  match(connection: LlmConnection): LlmProviderMatch;
  discover?(context: LlmProviderDiscoveryContext): Promise<LlmProviderDiscovery>;
  createProvider(context: LlmProviderCreationContext): LlmProvider;
  parameters?: LlmParameterAdapter;
  errors?: LlmProviderErrorClassifier;
};

export type LlmProviderPluginMatch = {
  plugin: LlmProviderPlugin;
  match: LlmProviderMatch;
  registrationOrder: number;
};

export type LlmProviderPluginDiagnostic = {
  pluginId: string;
  phase: 'match' | 'discover';
  message: string;
};
