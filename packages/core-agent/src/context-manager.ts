import type { LlmMessage, LlmTool } from '@dbagent/core-llm';
import { toLlmMessages } from './session.js';
import type {
  AgentContextCompressionLevel,
  AgentContextCompressionReport,
  AgentContextCompressionStep,
  AgentSession,
} from './types.js';

export type AgentContextManagerOptions = {
  maxPromptTokens?: number;
  keepRecentMessages?: number;
  maxToolResultChars?: number;
  warningThresholdRatio?: number;
  softCompressionThresholdRatio?: number;
  hardCompressionThresholdRatio?: number;
};

export type AgentContextBuildOutput = {
  messages: LlmMessage[];
  tools: LlmTool[];
  compression: AgentContextCompressionReport;
};

const DEFAULT_MAX_PROMPT_TOKENS = 40_000;
const DEFAULT_KEEP_RECENT_MESSAGES = 8;
const DEFAULT_MAX_TOOL_RESULT_CHARS = 1_200;
const DEFAULT_WARNING_THRESHOLD_RATIO = 0.6;
const DEFAULT_SOFT_COMPRESSION_THRESHOLD_RATIO = 0.8;
const DEFAULT_HARD_COMPRESSION_THRESHOLD_RATIO = 0.95;

export function buildAgentContext(
  session: AgentSession,
  tools: LlmTool[],
  options: AgentContextManagerOptions = {},
): AgentContextBuildOutput {
  const maxPromptTokens = normalizePositiveInteger(options.maxPromptTokens, DEFAULT_MAX_PROMPT_TOKENS);
  const keepRecentMessages = normalizePositiveInteger(options.keepRecentMessages, DEFAULT_KEEP_RECENT_MESSAGES);
  const maxToolResultChars = normalizePositiveInteger(options.maxToolResultChars, DEFAULT_MAX_TOOL_RESULT_CHARS);
  const thresholds = normalizeCompressionThresholds(maxPromptTokens, options);
  const originalMessages = toLlmMessages(session);
  const originalTokenEstimate = estimatePromptTokens(originalMessages, tools);
  const warnings: string[] = [];
  const steps: AgentContextCompressionStep[] = [];
  let messages = originalMessages;
  let summarizedToolResultCount = 0;
  let archivedMessageCount = 0;
  let level: AgentContextCompressionLevel = 'none';

  if (originalTokenEstimate >= thresholds.softCompressionThresholdTokens) {
    const beforeTokenEstimate = estimatePromptTokens(messages, tools);
    const summarized = summarizeLargeToolResults(messages, maxToolResultChars);
    messages = summarized.messages;
    summarizedToolResultCount = summarized.count;
    if (summarized.count > 0) {
      const afterTokenEstimate = estimatePromptTokens(messages, tools);
      steps.push({
        type: 'tool-summary',
        beforeTokenEstimate,
        afterTokenEstimate,
        affectedMessageCount: summarized.count,
      });
      level = 'tool-summary';
    }
  }

  let finalTokenEstimate = estimatePromptTokens(messages, tools);
  if (finalTokenEstimate >= thresholds.hardCompressionThresholdTokens) {
    const beforeTokenEstimate = finalTokenEstimate;
    const archived = archiveEarlyMessages(messages, keepRecentMessages);
    messages = archived.messages;
    archivedMessageCount = archived.archivedMessageCount;
    finalTokenEstimate = estimatePromptTokens(messages, tools);
    if (archived.archivedMessageCount > 0) {
      steps.push({
        type: 'archive-early-messages',
        beforeTokenEstimate,
        afterTokenEstimate: finalTokenEstimate,
        affectedMessageCount: archived.archivedMessageCount,
      });
      level = 'archive-early-messages';
    }
  }

  if (finalTokenEstimate > maxPromptTokens) {
    warnings.push('Context is still over budget after local compression.');
  }

  return {
    messages,
    tools,
    compression: {
      phase: compressionPhase({
        originalTokenEstimate,
        finalTokenEstimate,
        warningThresholdTokens: thresholds.warningThresholdTokens,
        maxPromptTokens,
        archivedMessageCount,
        summarizedToolResultCount,
      }),
      level,
      originalTokenEstimate,
      finalTokenEstimate,
      maxPromptTokens,
      ...thresholds,
      retainedMessageCount: messages.length,
      toolCount: tools.length,
      archivedMessageCount,
      summarizedToolResultCount,
      steps,
      warnings,
    },
  };
}

export function estimatePromptTokens(messages: LlmMessage[], tools: LlmTool[] = []): number {
  const messageTokens = messages.reduce((total, message) => total + estimateTextTokens(message.content) + 4, 0);
  const toolTokens = tools.reduce((total, tool) => total + estimateTextTokens(JSON.stringify(tool)) + 8, 0);
  return messageTokens + toolTokens;
}

function summarizeLargeToolResults(
  messages: LlmMessage[],
  maxToolResultChars: number,
): { messages: LlmMessage[]; count: number } {
  let count = 0;
  return {
    messages: messages.map((message) => {
      if (message.role !== 'tool' || message.content.length <= maxToolResultChars) return message;
      count += 1;
      return {
        ...message,
        content: summarizeToolContent(message.content, maxToolResultChars),
      };
    }),
    count,
  };
}

function summarizeToolContent(content: string, maxToolResultChars: number): string {
  const head = content.slice(0, Math.max(80, Math.floor(maxToolResultChars * 0.45)));
  const tail = content.slice(-Math.max(80, Math.floor(maxToolResultChars * 0.2)));
  return JSON.stringify({
    summary: '工具结果已在本地摘要，保留开头、结尾和原始长度，避免超出模型上下文。',
    originalChars: content.length,
    head,
    tail,
  });
}

function archiveEarlyMessages(messages: LlmMessage[], keepRecentMessages: number): { messages: LlmMessage[]; archivedMessageCount: number } {
  if (messages.length <= keepRecentMessages + 1) return { messages, archivedMessageCount: 0 };

  const systemMessages = messages.filter((message) => message.role === 'system');
  const nonSystem = messages.filter((message) => message.role !== 'system');
  const recent = nonSystem.slice(-keepRecentMessages);
  const archived = nonSystem.slice(0, Math.max(0, nonSystem.length - keepRecentMessages));
  if (archived.length === 0) return { messages, archivedMessageCount: 0 };

  const archiveSummary: LlmMessage = {
    role: 'system',
    content: buildArchiveSummary(archived),
  };
  return {
    messages: [...systemMessages, archiveSummary, ...recent],
    archivedMessageCount: archived.length,
  };
}

function buildArchiveSummary(messages: LlmMessage[]): string {
  const roles = messages.reduce<Record<string, number>>((counts, message) => {
    counts[message.role] = (counts[message.role] ?? 0) + 1;
    return counts;
  }, {});
  const samples = messages
    .slice(-3)
    .map((message) => `${message.role}: ${message.content.slice(0, 120).replace(/\s+/g, ' ')}`)
    .join('\n');
  return [
    `前文已归档 ${messages.length} 条消息。`,
    `角色分布: ${Object.entries(roles)
      .map(([role, count]) => `${role}=${count}`)
      .join(', ')}`,
    samples ? `最近归档片段:\n${samples}` : undefined,
  ]
    .filter(Boolean)
    .join('\n');
}

function estimateTextTokens(text: string): number {
  const asciiWords = text.match(/[a-zA-Z0-9_]+/g)?.length ?? 0;
  const cjkChars = text.match(/[\u4e00-\u9fff]/g)?.length ?? 0;
  const symbols = Math.ceil(Math.max(0, text.length - asciiWords * 4 - cjkChars) / 4);
  return Math.max(1, asciiWords + cjkChars + symbols);
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function normalizeCompressionThresholds(
  maxPromptTokens: number,
  options: AgentContextManagerOptions,
): {
  warningThresholdTokens: number;
  softCompressionThresholdTokens: number;
  hardCompressionThresholdTokens: number;
} {
  const warningRatio = normalizeRatio(
    options.warningThresholdRatio,
    DEFAULT_WARNING_THRESHOLD_RATIO,
  );
  const softRatio = Math.max(
    warningRatio,
    normalizeRatio(options.softCompressionThresholdRatio, DEFAULT_SOFT_COMPRESSION_THRESHOLD_RATIO),
  );
  const hardRatio = Math.max(
    softRatio,
    normalizeRatio(options.hardCompressionThresholdRatio, DEFAULT_HARD_COMPRESSION_THRESHOLD_RATIO),
  );
  return {
    warningThresholdTokens: Math.max(1, Math.floor(maxPromptTokens * warningRatio)),
    softCompressionThresholdTokens: Math.max(1, Math.floor(maxPromptTokens * softRatio)),
    hardCompressionThresholdTokens: Math.max(1, Math.floor(maxPromptTokens * hardRatio)),
  };
}

function normalizeRatio(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0 || value > 1) {
    return fallback;
  }
  return value;
}

function compressionPhase(input: {
  originalTokenEstimate: number;
  finalTokenEstimate: number;
  warningThresholdTokens: number;
  maxPromptTokens: number;
  archivedMessageCount: number;
  summarizedToolResultCount: number;
}): AgentContextCompressionReport['phase'] {
  if (input.finalTokenEstimate > input.maxPromptTokens) return 'over_budget';
  if (input.archivedMessageCount > 0) return 'hard_compressed';
  if (input.summarizedToolResultCount > 0) return 'soft_compressed';
  if (input.originalTokenEstimate >= input.warningThresholdTokens) return 'warning';
  return 'healthy';
}
