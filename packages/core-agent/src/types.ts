import type { LlmMessage, LlmTool, LlmToolCall, LlmUsage } from '@dbagent/core-llm';
import type { UsageMode } from '@dbagent/shared';

export type AgentMode = 'ask' | 'auto' | 'full-auto' | 'readonly';

export type AgentStrategy = 'react';

export type AgentMessage =
  | { role: 'user'; content: string; createdAt: string }
  | { role: 'assistant'; content: string; toolCalls?: LlmToolCall[]; createdAt: string }
  | { role: 'tool'; toolCallId: string; toolName: string; content: string; createdAt: string }
  | { role: 'system'; content: string; createdAt: string };

export type AgentMessageDraft =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: LlmToolCall[] }
  | { role: 'tool'; toolCallId: string; toolName: string; content: string }
  | { role: 'system'; content: string };

export type AgentSession = {
  id: string;
  title: string;
  mode: AgentMode;
  strategy: AgentStrategy;
  messages: AgentMessage[];
  tokenUsage: LlmUsage;
  aborted: boolean;
};

export type AgentRunStatus =
  | 'done'
  | 'aborted'
  | 'max_iterations_reached'
  | 'permission_denied'
  | 'tool_failed'
  | 'quota_exceeded';

export type AgentRunResult = {
  status: AgentRunStatus;
  session: AgentSession;
  finalText: string;
  iterations: number;
  toolExecutions: AgentToolExecutionRecord[];
};

export type AgentRunOptions = {
  providerId: string;
  model: string;
  userMessage: string;
  allowedTools?: string[];
  usageMode?: UsageMode;
  mode?: AgentMode;
  maxIterations?: number;
  tokenBudget?: number;
  signal?: AbortSignal;
};

export type ToolDangerLevel = 'safe' | 'medium' | 'high' | 'critical';

export type ToolPermissionDecision = 'allow' | 'deny' | 'ask';

export type AgentToolDefinition = LlmTool & {
  dangerLevel: ToolDangerLevel;
  readonly?: boolean;
};

export type AgentToolContext = {
  session: AgentSession;
  signal?: AbortSignal;
};

export type AgentToolHandler = (
  args: Record<string, unknown>,
  context: AgentToolContext,
) => Promise<unknown> | unknown;

export type RegisteredAgentTool = AgentToolDefinition & {
  handler: AgentToolHandler;
};

export type AgentToolExecutionRecord = {
  toolCallId: string;
  toolName: string;
  status: 'success' | 'denied' | 'failed';
  durationMs: number;
  resultPreview: string;
};

export type PermissionRequest = {
  mode: AgentMode;
  tool: AgentToolDefinition;
  toolCall: LlmToolCall;
};

export type ApprovalProvider = (request: PermissionRequest) => Promise<boolean> | boolean;

export type AgentRunDependencies = {
  now?: () => string;
  createSessionId?: () => string;
};

export type AgentContextBuildResult = {
  messages: LlmMessage[];
  tools: LlmTool[];
};
