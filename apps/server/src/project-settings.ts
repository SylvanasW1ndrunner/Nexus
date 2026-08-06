import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  mergeLlmGenerationConfig,
  type LlmEndpointProtocol,
  type LlmGenerationConfig,
} from '@dbagent/sdk';

export type SchemaNautProjectSettings = {
  version: 1;
  llm?: {
    protocol?: LlmEndpointProtocol;
    baseUrl?: string;
    model?: string;
    canonicalModel?: string;
    generation?: LlmGenerationConfig;
  };
};

export type ResolvedCliConfiguration = {
  protocol: LlmEndpointProtocol;
  baseUrl: string;
  apiKey?: string;
  model: string;
  canonicalModel?: string;
  generation: LlmGenerationConfig;
  databaseUrl: string;
  maxTables: number;
};

const PROTOCOLS = new Set<LlmEndpointProtocol>([
  'openai-chat',
  'openai-responses',
  'anthropic',
  'ollama',
  'vllm',
]);

export async function loadProjectSettings(
  projectDirectory: string,
): Promise<SchemaNautProjectSettings> {
  const path = resolve(projectDirectory, '.schemanaut', 'settings.json');
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return { version: 1 };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error(`项目配置不是有效 JSON：${path}`);
  }
  const root = requireRecord(parsed, '项目配置');
  if (root.version !== 1) throw new Error('项目配置 version 当前只支持 1。');
  if (root.llm === undefined) return { version: 1 };
  const llm = requireRecord(root.llm, 'llm');
  if (
    llm.contextWindow !== undefined ||
    llm.contextTokens !== undefined ||
    llm.maxInputTokens !== undefined
  ) {
    throw new Error('模型上下文窗口是只读元数据，由 Endpoint 或内置模型目录发现，不能手工配置。');
  }
  const protocol = llm.protocol === undefined ? undefined : parseProtocol(llm.protocol);
  const baseUrl = optionalNonBlankString(llm.baseUrl, 'llm.baseUrl');
  const model = optionalNonBlankString(llm.model, 'llm.model');
  const canonicalModel = optionalNonBlankString(llm.canonicalModel, 'llm.canonicalModel');
  if (canonicalModel !== undefined && !canonicalModel.includes('/')) {
    throw new Error('llm.canonicalModel 必须采用 provider/model 格式。');
  }
  const generation =
    llm.generation === undefined ? undefined : parseGeneration(llm.generation, 'llm.generation');
  return {
    version: 1,
    llm: {
      ...(protocol === undefined ? {} : { protocol }),
      ...(baseUrl === undefined ? {} : { baseUrl }),
      ...(model === undefined ? {} : { model }),
      ...(canonicalModel === undefined ? {} : { canonicalModel }),
      ...(generation === undefined ? {} : { generation }),
    },
  };
}

export function resolveCliConfiguration(
  env: NodeJS.ProcessEnv,
  settings: SchemaNautProjectSettings = { version: 1 },
): ResolvedCliConfiguration {
  if (
    env.SCHEMANAUT_LLM_CONTEXT_WINDOW !== undefined ||
    env.SCHEMANAUT_LLM_CONTEXT_TOKENS !== undefined ||
    env.SCHEMANAUT_LLM_MAX_INPUT_TOKENS !== undefined
  ) {
    throw new Error('模型上下文窗口是只读元数据，不能通过环境变量覆盖。');
  }
  const baseUrl = env.SCHEMANAUT_LLM_BASE_URL?.trim() || settings.llm?.baseUrl;
  const model = env.SCHEMANAUT_LLM_MODEL?.trim() || settings.llm?.model;
  const databaseUrl = env.SCHEMANAUT_DATABASE_URL?.trim() || env.DATABASE_URL?.trim();
  if (!baseUrl || !model || !databaseUrl) {
    throw new Error(
      [
        'CLI 缺少连接配置。',
        '请在 .schemanaut/settings.json 或环境变量中设置 SCHEMANAUT_LLM_BASE_URL、SCHEMANAUT_LLM_MODEL、SCHEMANAUT_DATABASE_URL；',
        '远程模型另需 SCHEMANAUT_LLM_API_KEY。',
      ].join(' '),
    );
  }
  const protocol = env.SCHEMANAUT_LLM_PROTOCOL?.trim()
    ? parseProtocol(env.SCHEMANAUT_LLM_PROTOCOL.trim())
    : (settings.llm?.protocol ?? inferProtocol(baseUrl));
  const envGeneration = parseEnvironmentGeneration(env);
  const generation = mergeLlmGenerationConfig(settings.llm?.generation, envGeneration);
  const canonicalModel =
    env.SCHEMANAUT_LLM_CANONICAL_MODEL?.trim() || settings.llm?.canonicalModel;
  if (canonicalModel !== undefined && !canonicalModel.includes('/')) {
    throw new Error('SCHEMANAUT_LLM_CANONICAL_MODEL 必须采用 provider/model 格式。');
  }
  const maxTables = Number(env.SCHEMANAUT_MAX_SCHEMA_TABLES ?? '500');
  if (!Number.isSafeInteger(maxTables) || maxTables < 1 || maxTables > 1_000) {
    throw new Error('SCHEMANAUT_MAX_SCHEMA_TABLES 必须是 1 到 1000 的整数。');
  }
  return {
    protocol,
    baseUrl,
    ...(env.SCHEMANAUT_LLM_API_KEY?.trim()
      ? { apiKey: env.SCHEMANAUT_LLM_API_KEY.trim() }
      : {}),
    model,
    ...(canonicalModel === undefined ? {} : { canonicalModel }),
    generation,
    databaseUrl,
    maxTables,
  };
}

export function inferEndpointProviderId(
  protocol: LlmEndpointProtocol,
  baseUrl: string,
): string {
  if (protocol === 'ollama' || protocol === 'vllm' || protocol === 'anthropic') return protocol;
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    if (host === 'api.openai.com') return 'openai';
    if (host === 'api.siliconflow.cn') return 'siliconflow';
    if (host === 'api.deepseek.com') return 'deepseek';
    if (host === 'open.bigmodel.cn') return 'zhipu';
    if (host === 'api.moonshot.cn') return 'moonshot';
  } catch {
    // URL validation is owned by the selected Provider adapter.
  }
  return 'custom-endpoint';
}

function parseEnvironmentGeneration(env: NodeJS.ProcessEnv): LlmGenerationConfig {
  const config: LlmGenerationConfig = {};
  if (env.SCHEMANAUT_LLM_TEMPERATURE?.trim()) {
    config.temperature = parseNumber(env.SCHEMANAUT_LLM_TEMPERATURE, 'SCHEMANAUT_LLM_TEMPERATURE');
  }
  if (env.SCHEMANAUT_LLM_TOP_P?.trim()) {
    config.topP = parseNumber(env.SCHEMANAUT_LLM_TOP_P, 'SCHEMANAUT_LLM_TOP_P');
  }
  if (env.SCHEMANAUT_LLM_MAX_OUTPUT_TOKENS?.trim()) {
    config.maxOutputTokens = parseNumber(
      env.SCHEMANAUT_LLM_MAX_OUTPUT_TOKENS,
      'SCHEMANAUT_LLM_MAX_OUTPUT_TOKENS',
    );
  }
  if (env.SCHEMANAUT_LLM_SEED?.trim()) {
    config.seed = parseNumber(env.SCHEMANAUT_LLM_SEED, 'SCHEMANAUT_LLM_SEED');
  }
  if (env.SCHEMANAUT_LLM_STOP?.trim()) {
    let stop: unknown;
    try {
      stop = JSON.parse(env.SCHEMANAUT_LLM_STOP);
    } catch {
      throw new Error('SCHEMANAUT_LLM_STOP 必须是 JSON 字符串数组。');
    }
    config.stop = parseStop(stop, 'SCHEMANAUT_LLM_STOP');
  }
  if (env.SCHEMANAUT_LLM_REASONING_EFFORT?.trim()) {
    config.reasoningEffort = parseReasoningEffort(
      env.SCHEMANAUT_LLM_REASONING_EFFORT,
      'SCHEMANAUT_LLM_REASONING_EFFORT',
    );
  }
  return config;
}

function parseGeneration(value: unknown, name: string): LlmGenerationConfig {
  const input = requireRecord(value, name);
  return mergeLlmGenerationConfig(undefined, {
    ...(input.temperature === undefined
      ? {}
      : { temperature: parseNumber(input.temperature, `${name}.temperature`) }),
    ...(input.topP === undefined ? {} : { topP: parseNumber(input.topP, `${name}.topP`) }),
    ...(input.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: parseNumber(input.maxOutputTokens, `${name}.maxOutputTokens`) }),
    ...(input.seed === undefined ? {} : { seed: parseNumber(input.seed, `${name}.seed`) }),
    ...(input.stop === undefined ? {} : { stop: parseStop(input.stop, `${name}.stop`) }),
    ...(input.reasoningEffort === undefined
      ? {}
      : {
          reasoningEffort: parseReasoningEffort(
            input.reasoningEffort,
            `${name}.reasoningEffort`,
          ),
        }),
  });
}

function parseProtocol(value: unknown): LlmEndpointProtocol {
  if (value === 'openai-compatible') return 'openai-chat';
  if (value === 'anthropic-messages') return 'anthropic';
  if (typeof value !== 'string' || !PROTOCOLS.has(value as LlmEndpointProtocol)) {
    throw new Error(
      'llm.protocol 必须是 openai-chat、openai-responses、anthropic、ollama 或 vllm。',
    );
  }
  return value as LlmEndpointProtocol;
}

function inferProtocol(baseUrl: string): LlmEndpointProtocol {
  try {
    const url = new URL(baseUrl);
    if (url.port === '11434') return 'ollama';
  } catch {
    // The Provider constructor returns the precise URL validation error.
  }
  return 'openai-chat';
}

function parseNumber(value: unknown, name: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} 必须是有限数字。`);
  return parsed;
}

function parseStop(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${name} 必须是非空字符串数组。`);
  }
  const parsed: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item) {
      throw new Error(`${name} must contain non-empty strings.`);
    }
    parsed.push(item);
  }
  return parsed;
}

function parseReasoningEffort(
  value: unknown,
  name: string,
): NonNullable<LlmGenerationConfig['reasoningEffort']> {
  if (value !== 'low' && value !== 'medium' && value !== 'high') {
    throw new Error(`${name} 必须是 low、medium 或 high。`);
  }
  return value;
}

function optionalNonBlankString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} 不能为空。`);
  return value.trim();
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} 必须是 JSON 对象。`);
  }
  return value as Record<string, unknown>;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
