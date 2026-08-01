import { StructuredOutputValidator, type LlmToolCall } from '@dbagent/core-llm';
import { requiredPermissionForTool } from './permission-manager.js';
import type { ToolRegistry } from './tool-registry.js';
import type {
  AgentToolContext,
  AgentToolDefinition,
  AgentToolFailureKind,
  RegisteredAgentTool,
} from './types.js';

export type AgentToolAuthorizationResult =
  | {
      decision: 'allow';
      context?: Partial<AgentToolContext>;
      metadata?: unknown;
    }
  | {
      decision: 'deny';
      reason: string;
      metadata?: unknown;
    };

export type AgentToolExecutionHookInput = {
  call: LlmToolCall;
  tool: AgentToolDefinition;
  arguments: Record<string, unknown>;
  context: AgentToolContext;
};

export type AgentToolExecutionAfterHookInput = AgentToolExecutionHookInput & {
  result: unknown;
};

export type AgentToolExecutionHook = {
  before?: (
    input: AgentToolExecutionHookInput,
  ) =>
    | void
    | { arguments?: Record<string, unknown>; denyReason?: string }
    | Promise<void | { arguments?: Record<string, unknown>; denyReason?: string }>;
  after?: (
    input: AgentToolExecutionAfterHookInput,
  ) => void | { result?: unknown } | Promise<void | { result?: unknown }>;
};

export type ToolExecutionRouterInput = {
  calls: readonly LlmToolCall[];
  context: AgentToolContext;
  allowedTools?: readonly string[];
  visibleTools?: readonly string[];
  defaultTimeoutMs?: number;
  authorize?: (input: {
    call: LlmToolCall;
    tool: RegisteredAgentTool;
    requiredPermission: ReturnType<typeof requiredPermissionForTool>;
    context: AgentToolContext;
  }) => AgentToolAuthorizationResult | Promise<AgentToolAuthorizationResult>;
};

export type ToolExecutionRouterOutcome = {
  call: LlmToolCall;
  tool?: RegisteredAgentTool;
  status: 'success' | 'denied' | 'failed';
  durationMs: number;
  result?: unknown;
  error?: string;
  failureKind?: AgentToolFailureKind;
  handlerCompleted: boolean;
  authorizationMetadata?: unknown;
  hookWarnings: string[];
};

export class ToolExecutionRouter {
  private readonly validator = new StructuredOutputValidator();
  private readonly hooks: readonly AgentToolExecutionHook[];

  constructor(
    private readonly registry: ToolRegistry,
    options: { hooks?: readonly AgentToolExecutionHook[] } = {},
  ) {
    this.hooks = options.hooks ?? [];
  }

  async execute(input: ToolExecutionRouterInput): Promise<ToolExecutionRouterOutcome[]> {
    const outcomes = new Array<ToolExecutionRouterOutcome>(input.calls.length);
    let readGroup: Array<{ call: LlmToolCall; index: number }> = [];
    const flushReads = async () => {
      if (readGroup.length === 0) return;
      const group = readGroup;
      readGroup = [];
      const completed = await Promise.all(
        group.map(async ({ call, index }) => ({
          index,
          outcome: await this.executeOne(call, input),
        })),
      );
      for (const item of completed) outcomes[item.index] = item.outcome;
    };

    for (let index = 0; index < input.calls.length; index += 1) {
      const call = input.calls[index]!;
      const tool = this.registry.get(call.name);
      if (tool?.descriptor.execution.concurrency === 'read') {
        readGroup.push({ call, index });
        continue;
      }
      await flushReads();
      outcomes[index] = await this.executeOne(call, input);
    }
    await flushReads();
    return outcomes;
  }

  private async executeOne(
    call: LlmToolCall,
    input: ToolExecutionRouterInput,
  ): Promise<ToolExecutionRouterOutcome> {
    const startedAt = performance.now();
    const base = (overrides: Partial<ToolExecutionRouterOutcome>): ToolExecutionRouterOutcome => ({
      call,
      status: 'failed',
      durationMs: Math.max(0, performance.now() - startedAt),
      handlerCompleted: false,
      hookWarnings: [],
      ...overrides,
    });
    const allowed = input.allowedTools === undefined ? undefined : new Set(input.allowedTools);
    if (allowed && !allowed.has(call.name)) {
      return base({ status: 'denied', error: 'Tool is not allowed for this run.' });
    }
    const visible = input.visibleTools === undefined ? undefined : new Set(input.visibleTools);
    if (visible && !visible.has(call.name)) {
      return base({ error: 'Tool is not active. Discover it with tool_search before use.' });
    }
    const tool = this.registry.get(call.name);
    if (!tool) return base({ error: 'Tool is not registered.' });

    let argumentsValue = structuredClone(call.arguments);
    try {
      this.validator.assertValid(argumentsValue, tool.inputSchema);
    } catch (error) {
      return base({ tool, error: `Tool arguments are invalid: ${errorMessage(error)}` });
    }

    const hookWarnings: string[] = [];
    for (const hook of this.hooks) {
      if (!hook.before) continue;
      try {
        const result = await hook.before({
          call,
          tool,
          arguments: argumentsValue,
          context: input.context,
        });
        if (result?.denyReason) {
          return base({
            tool,
            status: 'denied',
            error: result.denyReason,
            hookWarnings,
          });
        }
        if (result?.arguments) {
          argumentsValue = structuredClone(result.arguments);
          this.validator.assertValid(argumentsValue, tool.inputSchema);
        }
      } catch (error) {
        return base({ tool, error: `Pre-tool hook failed: ${errorMessage(error)}`, hookWarnings });
      }
    }

    const requiredPermission = requiredPermissionForTool(
      tool.resolveRequiredPermission === undefined
        ? tool
        : {
            ...tool,
            requiredPermission: tool.resolveRequiredPermission(argumentsValue),
          },
    );
    const invocation = {
      toolCallId: call.id,
      toolName: tool.name,
      requiredPermission,
    };
    let authorizationMetadata: unknown;
    let context: AgentToolContext = { ...input.context, invocation };
    if (input.authorize) {
      const authorization = await input.authorize({
        call: { ...call, arguments: argumentsValue },
        tool,
        requiredPermission,
        context,
      });
      authorizationMetadata = authorization.metadata;
      if (authorization.decision === 'deny') {
        return base({
          tool,
          status: 'denied',
          error: authorization.reason,
          ...(authorizationMetadata === undefined ? {} : { authorizationMetadata }),
          hookWarnings,
        });
      }
      context = { ...context, ...(authorization.context ?? {}) };
    }

    let result: unknown;
    try {
      result = await executeWithTimeout(
        tool.name,
        tool.handler,
        argumentsValue,
        context,
        tool.descriptor.execution.timeoutMs ?? input.defaultTimeoutMs ?? 60_000,
      );
    } catch (error) {
      return base({
        tool,
        error: errorMessage(error),
        ...(authorizationMetadata === undefined ? {} : { authorizationMetadata }),
        hookWarnings,
      });
    }

    for (const hook of this.hooks) {
      if (!hook.after) continue;
      try {
        const hookResult = await hook.after({
          call,
          tool,
          arguments: argumentsValue,
          context,
          result,
        });
        if (hookResult && Object.hasOwn(hookResult, 'result')) result = hookResult.result;
      } catch (error) {
        hookWarnings.push(errorMessage(error));
      }
    }
    return base({
      tool,
      status: 'success',
      result,
      handlerCompleted: true,
      ...(authorizationMetadata === undefined ? {} : { authorizationMetadata }),
      hookWarnings,
    });
  }
}

async function executeWithTimeout(
  toolName: string,
  handler: RegisteredAgentTool['handler'],
  args: Record<string, unknown>,
  context: AgentToolContext,
  timeoutMs: number,
): Promise<unknown> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return handler(args, context);
  if (context.signal?.aborted) throw new Error('Agent run was aborted before tool execution.');

  const controller = new AbortController();
  const abortFromParent = () => controller.abort(context.signal?.reason);
  context.signal?.addEventListener('abort', abortFromParent, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener(
      'abort',
      () =>
        reject(
          new Error(
            timedOut
              ? `Tool ${toolName} timed out after ${timeoutMs}ms.`
              : 'Agent run was aborted during tool execution.',
          ),
        ),
      { once: true },
    );
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  });
  const handlerPromise = Promise.resolve().then(() =>
    handler(args, { ...context, signal: controller.signal }),
  );
  try {
    return await Promise.race([handlerPromise, abortPromise]);
  } finally {
    if (timer) clearTimeout(timer);
    context.signal?.removeEventListener('abort', abortFromParent);
    if (controller.signal.aborted) {
      await Promise.race([
        handlerPromise.then(
          () => undefined,
          () => undefined,
        ),
        new Promise<void>((resolve) => setTimeout(resolve, 500)),
      ]);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
