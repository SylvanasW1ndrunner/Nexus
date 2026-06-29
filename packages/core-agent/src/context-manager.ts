import type { LlmMessage, LlmTool } from '@dbagent/core-llm';
import { toLlmMessages } from './session.js';
import type { AgentSession } from './types.js';

export type AgentContextCompressionLevel = 'none' | 'tool-summary' | 'archive-early-messages';

export type AgentContextManagerOptions = {
  maxPromptTokens?: number;
  keepRecentMessages?: number;
  maxToolResultChars?: number;
};

export type AgentContextCompressionReport = {
  level: AgentContextCompressionLevel;
  originalTokenEstimate: number;
  finalTokenEstimate: number;
  archivedMessageCount: number;
  summarizedToolResultCount: number;
  warnings: string[];
};

export type AgentContextBuildOutput = {
  messages: LlmMessage[];
  tools: LlmTool[];
  compression: AgentContextCompressionReport;
};

const DEFAULT_MAX_PROMPT_TOKENS = 40_000;
const DEFAULT_KEEP_RECENT_MESSAGES = 8;
const DEFAULT_MAX_TOOL_RESULT_CHARS = 1_200;

export function buildAgentContext(
  session: AgentSession,
  tools: LlmTool[],
  options: AgentContextManagerOptions = {},
): AgentContextBuildOutput {
  const maxPromptTokens = normalizePositiveInteger(options.maxPromptTokens, DEFAULT_MAX_PROMPT_TOKENS);
  const keepRecentMessages = normalizePositiveInteger(options.keepRecentMessages, DEFAULT_KEEP_RECENT_MESSAGES);
  const maxToolResultChars = normalizePositiveInteger(options.maxToolResultChars, DEFAULT_MAX_TOOL_RESULT_CHARS);
  const originalMessages = toLlmMessages(session);
  const originalTokenEstimate = estimatePromptTokens(originalMessages, tools);
  const warnings: string[] = [];
  let messages = originalMessages;
  let summarizedToolResultCount = 0;
  let archivedMessageCount = 0;
  let level: AgentContextCompressionLevel = 'none';

  if (originalTokenEstimate > maxPromptTokens * 0.8) {
    const summarized = summarizeLargeToolResults(messages, maxToolResultChars);
    messages = summarized.messages;
    summarizedToolResultCount = summarized.count;
    if (summarized.count > 0) level = 'tool-summary';
  }

  let finalTokenEstimate = estimatePromptTokens(messages, tools);
  if (finalTokenEstimate > maxPromptTokens) {
    const archived = archiveEarlyMessages(messages, keepRecentMessages);
    messages = archived.messages;
    archivedMessageCount = archived.archivedMessageCount;
    finalTokenEstimate = estimatePromptTokens(messages, tools);
    level = 'archive-early-messages';
  }

  if (finalTokenEstimate > maxPromptTokens) {
    warnings.push('Context is still over budget after local compression.');
  }

  return {
    messages,
    tools,
    compression: {
      level,
      originalTokenEstimate,
      finalTokenEstimate,
      archivedMessageCount,
      summarizedToolResultCount,
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
