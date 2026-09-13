import type { McpConfigRepository, McpServerConfig } from './mcp-config-store.js';
import type { McpHealthManager, McpServerHealthState } from './mcp-health.js';
import type {
  McpToolGenerationTransaction,
  McpToolRegistrationManager,
} from './mcp-tool-registration-manager.js';
import { snapshotMcpMetadata, type McpToolSpec } from './mcp-tool-adapter.js';

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 5_000;

export type McpServerDescriptor = {
  serverId: string;
  transport: McpServerConfig['transport'];
  capabilities: Record<string, unknown>;
  serverInfo?: Record<string, unknown>;
  instructions?: string;
};

export type McpResourceSpec = Record<string, unknown> & {
  uri: string;
  name: string;
};

export type McpResourceTemplateSpec = Record<string, unknown> & {
  uriTemplate: string;
  name: string;
};

export type McpPromptSpec = Record<string, unknown> & {
  name: string;
};

export type McpReadResourceResult = Record<string, unknown> & {
  contents: unknown[];
};

export type McpGetPromptResult = Record<string, unknown> & {
  messages: unknown[];
};

export type McpListChangedEvent<T> =
  | { items: T[]; error?: never }
  | { items?: never; error: Error };

export type McpRuntimeClient = {
  describe(): McpServerDescriptor;
  ping(signal?: AbortSignal): Promise<void>;
  listTools(signal?: AbortSignal): Promise<McpToolSpec[]>;
  callTool(toolName: string, args: Record<string, unknown>, signal: AbortSignal): unknown;
  listResources(signal?: AbortSignal): Promise<McpResourceSpec[]>;
  listResourceTemplates(signal?: AbortSignal): Promise<McpResourceTemplateSpec[]>;
  readResource(uri: string, signal?: AbortSignal): Promise<McpReadResourceResult>;
  listPrompts(signal?: AbortSignal): Promise<McpPromptSpec[]>;
  getPrompt(
    name: string,
    args?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<McpGetPromptResult>;
  stop(): Promise<void> | void;
  onExit?(handler: (event: McpRuntimeExitEvent) => void): () => void;
  onToolsChanged?(handler: (event: McpListChangedEvent<McpToolSpec>) => void): () => void;
  onResourcesChanged?(handler: (event: McpListChangedEvent<McpResourceSpec>) => void): () => void;
  onPromptsChanged?(handler: (event: McpListChangedEvent<McpPromptSpec>) => void): () => void;
};

export type McpRuntimeLauncher = (
  server: McpServerConfig,
  signal?: AbortSignal,
) => Promise<McpRuntimeClient> | McpRuntimeClient;

export type McpRuntimeExitEvent = {
  code?: number;
  signal?: string;
  errorMessage?: string;
  stderrPreview?: string;
  at?: string;
};

export type McpRuntimeStartResult = {
  server: McpServerConfig;
  tools: string[];
  descriptor?: McpServerDescriptor;
  health: McpServerHealthState;
};

export type McpRuntimeStopResult = {
  serverId: string;
  removedTools: string[];
  health: McpServerHealthState;
};

export type McpRuntimeExitResult = {
  serverId: string;
  removedTools: string[];
  health: McpServerHealthState;
};

export type McpRuntimeAvailabilityEvent = {
  serverId: string;
  status: 'ready' | 'unavailable' | 'disabled' | 'stopped';
  reason?: string;
};

export type McpRuntimeGenerationPublication = {
  event: McpRuntimeAvailabilityEvent;
  /**
   * Synchronous catalog mutation at the availability linearization point.
   * The publisher must invoke this exactly once before it resolves.
   */
  commit: () => void;
  /** Compensation for a rejected or incomplete publication. */
  rollback: () => void;
};

export class McpGenerationPublicationContractError extends Error {
  readonly code = 'MCP_GENERATION_PUBLICATION_CONTRACT';

  constructor(message = 'MCP generation publisher did not commit exactly once.') {
    super(message);
    this.name = 'McpGenerationPublicationContractError';
  }
}

export class McpGenerationPublicationPoisonedError extends Error {
  readonly code = 'MCP_GENERATION_PUBLICATION_POISONED';

  constructor(cause?: unknown) {
    super('MCP generation publication compensation failed; host restart is required.',
      cause === undefined ? undefined : { cause });
    this.name = 'McpGenerationPublicationPoisonedError';
  }
}

type McpCleanupOutcome =
  | Readonly<{ status: 'complete' }>
  | Readonly<{ status: 'failed'; reason: string }>
  | Readonly<{ status: 'timed_out' }>;

type McpRunningServer = {
  client: McpRuntimeClient;
  server: McpServerConfig;
  descriptor: McpServerDescriptor;
  unsubscribers: Array<() => void>;
};

type McpClientRetirement = Readonly<{
  cleanup: McpCleanupOutcome;
  subscriptionFailures: number;
}>;

export class McpRuntimeManager {
  private readonly clients = new Map<string, McpRunningServer>();
  private readonly lifecycleTails = new Map<string, Promise<void>>();
  private readonly coalescibleStarts = new Map<string, Promise<McpRuntimeStartResult>>();
  /**
   * Includes both active and queued starts. Its identity checks ensure an old
   * completion cannot clear or abort the controller owned by a newer start.
   */
  private readonly startupControllers = new Map<string, AbortController>();
  private publicationPoisoned = false;
  /** Allows a retried Host close to proceed after fatal cleanup was reported once. */
  private poisonShutdownReported = false;
  /** Owns batch admission so stopAll cannot return before a sequence stops adding servers. */
  private readonly autoStartSequences = new Set<Readonly<{
    controller: AbortController;
    settled: Promise<void>;
    settle: () => void;
  }>>();

  constructor(
    private readonly options: {
      configStore: McpConfigRepository;
      health: McpHealthManager;
      tools: McpToolRegistrationManager;
      launcher: McpRuntimeLauncher;
      /** Bounds launcher discovery even when a custom launcher ignores cancellation. */
      startupTimeoutMs?: number;
      /** Bounds retiring clients which ignore shutdown. */
      cleanupTimeoutMs?: number;
      onGenerationPublished?: (publication: McpRuntimeGenerationPublication) => void | Promise<void>;
    },
  ) {}

  start(serverId: string, parentSignal?: AbortSignal): Promise<McpRuntimeStartResult> {
    const pending = this.coalescibleStarts.get(serverId);
    if (pending) {
      // A coalesced caller does not own the shared startup, but it must still
      // be able to stop waiting promptly without cancelling the first caller.
      return parentSignal === undefined
        ? pending
        : this.awaitStartup(() => pending, parentSignal);
    }

    const controller = new AbortController();
    const forwardParentAbort = () => {
      if (!controller.signal.aborted) {
        controller.abort(parentSignal?.reason ?? new Error(`MCP startup was aborted: ${serverId}.`));
      }
    };
    if (parentSignal?.aborted) forwardParentAbort();
    else parentSignal?.addEventListener('abort', forwardParentAbort, { once: true });
    this.startupControllers.set(serverId, controller);
    const operation = this.enqueueLifecycle(serverId, async () => {
      try {
        return await this.startUnlocked(serverId, controller);
      } finally {
        parentSignal?.removeEventListener('abort', forwardParentAbort);
        this.releaseStartupController(serverId, controller);
      }
    });
    this.coalescibleStarts.set(serverId, operation);
    const clear = () => {
      if (this.coalescibleStarts.get(serverId) === operation) {
        this.coalescibleStarts.delete(serverId);
      }
    };
    void operation.then(clear, clear);
    return operation;
  }

  private async startUnlocked(
    serverId: string,
    controller: AbortController,
  ): Promise<McpRuntimeStartResult> {
    // Configuration is local repository I/O, not launcher discovery. Keep it
    // cancellation/deadline bounded for shutdown, but do not consume the
    // caller-configured launcher/discovery budget while reading the file.
    let clearDeadline = this.armStartupDeadline(
      `${serverId} configuration`,
      controller,
      DEFAULT_STARTUP_TIMEOUT_MS,
    );
    let server: McpServerConfig;
    try {
      server = await this.awaitStartup(
        () => this.requireServer(serverId),
        controller.signal,
      );
    } catch (error) {
      clearDeadline();
      throw error;
    }
    clearDeadline();
    clearDeadline = this.armStartupDeadline(serverId, controller);
    if (!server.enabled) {
      clearDeadline();
      if (this.publicationPoisoned) {
        await this.stopPoisonedUnlocked(server.id);
        throw new McpGenerationPublicationPoisonedError();
      }
      const running = this.clients.get(server.id);
      const removal = this.options.tools.prepareUnregisterServerTools(server.id);
      const previousHealth = this.options.health.capture(server.id);
      let health: McpServerHealthState | undefined;
      try {
        await this.publishGeneration({
          serverId: server.id,
          status: 'disabled',
          reason: 'MCP server is disabled.',
        }, () => {
          health = this.options.health.disable(server.id, 'MCP server is disabled.');
          removal.finalize();
        }, () => {
          removal.rollback();
          this.options.health.restore(server.id, previousHealth);
        });
      } catch (error) {
        if (!this.publicationPoisoned) throw error;
        await this.stopPoisonedUnlocked(server.id);
        throw error instanceof McpGenerationPublicationPoisonedError
          ? error
          : new McpGenerationPublicationPoisonedError(error);
      }
      removal.complete();
      this.clients.delete(server.id);
      const retirement = await this.retirePublishedClient(server.id, running);
      const diagnostic = cleanupDiagnostic('disable', retirement);
      if (diagnostic) {
        health = this.options.health.recordDiagnostic(
          server.id,
          diagnostic,
        );
      }
      return {
        server,
        tools: [],
        health: health!,
      };
    }

    const running = this.clients.get(server.id);
    if (
      running &&
      this.options.health.get(server.id).status === 'healthy' &&
      sameLaunchConfiguration(running.server, server)
    ) {
      clearDeadline();
      await this.publishGeneration(
        { serverId: server.id, status: 'ready' },
        () => undefined,
        () => undefined,
      );
      return {
        server,
        tools: this.options.tools.listServerTools(server.id).map((tool) => tool.name),
        descriptor: structuredClone(running.descriptor),
        health: this.options.health.get(server.id),
      };
    }
    // Keep a changed-config generation alive while its replacement is prepared.
    // The candidate transaction can restore its catalog if launch or publication fails.
    const previousRunning = running;
    const priorHealth = this.options.health.capture(server.id);
    if (!previousRunning) this.options.health.markStarting(server.id);

    let client: McpRuntimeClient | undefined;
    let candidateRunning: McpRunningServer | undefined;
    let stagedTools: McpToolGenerationTransaction | undefined;
    let startupComplete = false;
    let startupExit: McpRuntimeExitEvent | undefined;
    let failureGenerationPublished = false;
    let publicationCompleted = false;
    let committedResult: McpRuntimeStartResult | undefined;
    let cleanupResult: McpClientRetirement | undefined;
    try {
      const launchedClient = await this.awaitStartup(
        () => this.options.launcher(server, controller.signal),
        controller.signal,
        (lateClient) => this.stopLateClient(lateClient),
      );
      client = launchedClient;
      // `describe()` is external code. Snapshot and validate it while rollback
      // is still possible, then serve only the immutable local generation fact.
      const descriptor = normalizeMcpServerDescriptor(launchedClient.describe(), server);
      const candidate = {
        client: launchedClient,
        server,
        descriptor,
        unsubscribers: [] as Array<() => void>,
      };
      candidateRunning = candidate;
      // Subscribe before the first fallible remote discovery. A stdio process
      // can close while `listTools()` is awaiting a paginated response; that
      // exit must still be treated as a failed candidate, never as a healthy
      // catalog with a missed lifecycle event.
      const unsubscribeExit = launchedClient.onExit?.((event) => {
        const running = this.clients.get(server.id);
        if (running?.client !== launchedClient && candidateRunning?.client !== launchedClient) return;
        if (!startupComplete) {
          startupExit = event;
          return;
        }
        void this.recordExitForClient(server.id, launchedClient, event).catch(() => {
          this.options.health.recordDiagnostic(
            server.id,
            'MCP exit callback could not publish its lifecycle generation.',
          );
        });
      });
      if (unsubscribeExit) candidate.unsubscribers.push(unsubscribeExit);
      if (startupExit) throw new Error(startupExitMessage(startupExit));
      const specs = await this.awaitStartup(
        () => launchedClient.listTools(controller.signal),
        controller.signal,
      );
      // The manager-owned deadline covers only launcher settlement and the
      // first catalog discovery. Later staged publication retains its existing
      // serialized transaction semantics.
      clearDeadline();
      const prepared = this.options.tools.prepareServerTools({
        serverId: server.id,
        source: 'user-mcp',
        tools: specs,
        health: this.options.health,
        ...mcpTransportPermission(server),
        callTool: ({ toolName, args, signal }) => launchedClient.callTool(toolName, args, signal),
      });
      const unsubscribeTools = launchedClient.onToolsChanged?.((event) => {
        void this.handleToolsChanged(server.id, launchedClient, event).catch(() => {
          this.options.health.recordDiagnostic(
            server.id,
            'MCP tool-catalog callback could not publish its lifecycle generation.',
          );
        });
      });
      if (unsubscribeTools) candidate.unsubscribers.push(unsubscribeTools);
      if (startupExit) throw new Error(startupExitMessage(startupExit));
      stagedTools = prepared.stage();
      if (startupExit) throw new Error(startupExitMessage(startupExit));
      const previousHealth = this.options.health.capture(server.id);
      let health: McpServerHealthState | undefined;
      let registered: ReturnType<McpToolGenerationTransaction['finalize']> = [];
      await this.publishGeneration({ serverId: server.id, status: 'ready' }, () => {
        health = this.options.health.markHealthy(server.id);
        registered = stagedTools!.finalize();
      }, () => {
        stagedTools?.rollback();
        this.options.health.restore(server.id, previousHealth);
      });
      if (startupExit) {
        const reason = startupExitMessage(startupExit);
        const rollbackEvent = previousRunning
          ? availabilityForHealth(server.id, priorHealth, 'MCP replacement exited before publication completed; previous tools remain available.')
          : { serverId: server.id, status: 'unavailable' as const, reason };
        await this.publishGeneration(
          rollbackEvent,
          () => {
            if (previousRunning) {
              this.options.health.restore(server.id, priorHealth);
              health = this.options.health.get(server.id);
            } else health = this.options.health.markUnhealthy(server.id, reason);
            stagedTools!.rollback();
          },
          () => undefined,
        );
        failureGenerationPublished = true;
        stagedTools = undefined;
        throw new Error(reason);
      }
      committedResult = {
        server,
        tools: registered.map((tool) => tool.name),
        descriptor: structuredClone(descriptor),
        health: health!,
      };
      this.clients.set(server.id, candidate);
      stagedTools.complete();
      // From this point the prior generation is retiring and rollback is no
      // longer legal. Every following external cleanup failure is diagnostic.
      publicationCompleted = true;
      stagedTools = undefined;
      startupComplete = true;
      if (previousRunning) {
        // The previous client owns the captured handlers. Do not close its
        // transport until the retired catalog generation has drained. The
        // bounded cleanup path may still force close a transport which ignores
        // cancellation, while the registration manager continues observing the
        // actual Handler promises until they settle.
        const retirement = await this.retirePublishedClient(server.id, previousRunning);
        const diagnostic = cleanupDiagnostic('replacement', retirement);
        if (diagnostic) {
          // The replacement is already committed; old-client cleanup cannot undo it.
          const diagnosedHealth = this.options.health.recordDiagnostic(
            server.id,
            diagnostic,
          );
          committedResult = { ...committedResult, health: diagnosedHealth };
        }
      }
      return committedResult;
    } catch (error) {
      if (publicationCompleted && committedResult) {
        // Never route post-commit cleanup/diagnostic failures into the startup
        // rollback path. The committed client, catalog and health stay paired.
        return committedResult;
      }
      if (!this.publicationPoisoned) stagedTools?.rollback();
      else this.options.tools.retireServerToolsForFatalShutdown(server.id);
      if (this.clients.get(server.id)?.client === client) this.clients.delete(server.id);
      if (client) {
        cleanupResult = await this.retireFailedStartup(
          server.id,
          client,
          candidateRunning?.unsubscribers ?? [],
        );
      }
      if (this.publicationPoisoned) {
        throw error instanceof McpGenerationPublicationPoisonedError
          ? error
          : new McpGenerationPublicationPoisonedError(error);
      }
      const reason = errorMessage(error);
      if (failureGenerationPublished) {
        let health = this.options.health.get(server.id);
        const diagnostic = cleanupResult === undefined
          ? undefined
          : cleanupDiagnostic('failed startup generation', cleanupResult);
        if (diagnostic) health = this.options.health.recordDiagnostic(server.id, diagnostic);
        return {
          server,
          tools: this.options.tools.listServerTools(server.id).map((tool) => tool.name),
          health,
        };
      }
      let health: McpServerHealthState = this.options.health.get(server.id);
      if (previousRunning) {
        this.options.health.restore(server.id, priorHealth);
        health = this.options.health.recordDiagnostic(
          server.id,
          'MCP replacement failed; the previous complete generation remains active.',
        );
        const diagnostic = cleanupResult === undefined
          ? undefined
          : cleanupDiagnostic('failed replacement candidate', cleanupResult);
        if (diagnostic) {
          health = this.options.health.recordDiagnostic(
            server.id,
            diagnostic,
          );
        }
      } else {
        const removal = this.options.tools.prepareUnregisterServerTools(server.id);
        const healthBeforeFailurePublication = this.options.health.capture(server.id);
        try {
          await this.publishGeneration({ serverId: server.id, status: 'unavailable', reason }, () => {
            health = this.options.health.markUnhealthy(server.id, reason);
            removal.finalize();
          }, () => {
            removal.rollback();
            this.options.health.restore(server.id, healthBeforeFailurePublication);
          });
          removal.complete();
          const diagnostic = cleanupResult === undefined
            ? undefined
            : cleanupDiagnostic('failed startup', cleanupResult);
          if (diagnostic) {
            health = this.options.health.recordDiagnostic(
              server.id,
              diagnostic,
            );
          }
        } catch (publicationError) {
          if (this.publicationPoisoned) {
            this.options.tools.retireServerToolsForFatalShutdown(server.id);
            throw publicationError;
          }
          this.options.health.restore(server.id, healthBeforeFailurePublication);
          throw new Error(
            `MCP startup and unavailable publication both failed: ${reason}`,
          );
        }
      }
      return {
        server,
        tools: previousRunning
          ? this.options.tools.listServerTools(server.id).map((tool) => tool.name)
          : [],
        health,
      };
    } finally {
      clearDeadline();
    }
  }

  stop(serverId: string): Promise<McpRuntimeStopResult> {
    // A start queued after this stop must not be coalesced with an earlier start.
    this.abortStartup(serverId);
    this.coalescibleStarts.delete(serverId);
    return this.enqueueLifecycle(serverId, () => this.stopUnlocked(serverId));
  }

  private async stopUnlocked(serverId: string): Promise<McpRuntimeStopResult> {
    if (this.publicationPoisoned) return await this.stopPoisonedUnlocked(serverId);
    const running = this.clients.get(serverId);
    const removal = this.options.tools.prepareUnregisterServerTools(serverId);
    const removedTools = this.options.tools.listServerTools(serverId).map((tool) => tool.name);
    const previousHealth = this.options.health.capture(serverId);
    let health: McpServerHealthState | undefined;
    try {
      await this.publishGeneration({ serverId, status: 'stopped' }, () => {
        health = this.options.health.markStopped(serverId);
        removal.finalize();
      }, () => {
        removal.rollback();
        this.options.health.restore(serverId, previousHealth);
      });
    } catch (error) {
      if (!this.publicationPoisoned) throw error;
      await this.stopPoisonedUnlocked(serverId);
      throw error instanceof McpGenerationPublicationPoisonedError
        ? error
        : new McpGenerationPublicationPoisonedError(error);
    }
    removal.complete();
    this.clients.delete(serverId);
    const retirement = await this.retirePublishedClient(serverId, running);
    const diagnostic = cleanupDiagnostic('stop', retirement);
    health = diagnostic
      ? this.options.health.recordDiagnostic(serverId, diagnostic)
      : health;
    return {
      serverId,
      removedTools,
      health: health!,
    };
  }

  private async stopPoisonedUnlocked(serverId: string): Promise<McpRuntimeStopResult> {
    const running = this.clients.get(serverId);
    // Catalog state is unknowable after failed compensation. Do not claim Tool
    // removal or attempt another publication; health is the local invocation
    // fail-closed fence while Host shutdown discards the poisoned catalog.
    let health = this.options.health.markUnhealthy(
      serverId,
      'MCP generation publication is poisoned; host restart is required.',
    );
    this.options.tools.retireServerToolsForFatalShutdown(serverId);
    this.clients.delete(serverId);
    const retirement = await this.retirePublishedClient(serverId, running);
    const diagnostic = cleanupDiagnostic('fatal shutdown', retirement);
    if (diagnostic) health = this.options.health.recordDiagnostic(serverId, diagnostic);
    return { serverId, removedTools: [], health };
  }

  async stopAll(): Promise<McpRuntimeStopResult[]> {
    const sequences = [...this.autoStartSequences];
    for (const sequence of sequences) {
      if (!sequence.controller.signal.aborted) {
        sequence.controller.abort(new Error('MCP auto-start was cancelled by stopAll().'));
      }
    }
    const serverIds = [...new Set([
      ...this.clients.keys(),
      ...this.coalescibleStarts.keys(),
      ...this.startupControllers.keys(),
    ])].sort(
      (left, right) => left.localeCompare(right),
    );
    const resultsByServer = new Map<string, McpRuntimeStopResult>();
    const failures: unknown[] = [];
    const collect = (settled: readonly PromiseSettledResult<McpRuntimeStopResult>[]): void => {
      for (const result of settled) {
        if (result.status === 'fulfilled') resultsByServer.set(result.value.serverId, result.value);
        else if (!(result.reason instanceof McpGenerationPublicationPoisonedError)) {
          failures.push(result.reason);
        }
      }
    };
    collect(await Promise.allSettled(serverIds.map((serverId) => this.stop(serverId))));
    // A sequence either registered its current per-server start before the
    // snapshot above, or observes its aborted controller before the next
    // registration. Waiting here closes batch admission before returning.
    await Promise.allSettled(sequences.map((sequence) => sequence.settled));
    if (this.publicationPoisoned && this.clients.size > 0) {
      // A sibling stop may have failed before another publication poisoned the
      // manager. Sweep every residual client through the publication-free path.
      const residualServerIds = [...this.clients.keys()].sort(
        (left, right) => left.localeCompare(right),
      );
      collect(await Promise.allSettled(residualServerIds.map((serverId) => {
        this.abortStartup(serverId);
        this.coalescibleStarts.delete(serverId);
        return this.enqueueLifecycle(serverId, () => this.stopPoisonedUnlocked(serverId));
      })));
    }
    if (this.publicationPoisoned) {
      if (this.clients.size > 0) {
        failures.push(new Error('One or more MCP clients remain after fatal shutdown cleanup.'));
      } else if (!this.poisonShutdownReported) {
        this.poisonShutdownReported = true;
        throw new AggregateError(
          [...failures, new McpGenerationPublicationPoisonedError()],
          'MCP clients were cleaned up, but the poisoned catalog must be discarded by Host restart.',
        );
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'One or more MCP clients could not be stopped.');
    }
    return serverIds.flatMap((serverId) => {
      const result = resultsByServer.get(serverId);
      return result === undefined ? [] : [result];
    });
  }

  async recordExit(
    serverId: string,
    input: { code?: number; signal?: string; errorMessage?: string; at?: string } = {},
  ): Promise<McpRuntimeExitResult> {
    return await this.enqueueLifecycle(serverId, () => this.recordExitUnlocked(serverId, input));
  }

  /**
   * An exit callback belongs to one launched client, not to a server ID forever.
   * A replacement may finish while this callback is waiting behind its startup
   * lifecycle work, so re-check the identity only when the queued operation
   * reaches the lifecycle boundary.
   */
  private async recordExitForClient(
    serverId: string,
    client: McpRuntimeClient,
    input: McpRuntimeExitEvent,
  ): Promise<void> {
    await this.enqueueLifecycle(serverId, async () => {
      if (this.clients.get(serverId)?.client !== client) return;
      await this.recordExitUnlocked(serverId, input);
    });
  }

  private async recordExitUnlocked(
    serverId: string,
    input: { code?: number; signal?: string; errorMessage?: string; at?: string } = {},
  ): Promise<McpRuntimeExitResult> {
    const running = this.clients.get(serverId);
    const removal = this.options.tools.prepareUnregisterServerTools(serverId);
    const removedTools = this.options.tools.listServerTools(serverId).map((tool) => tool.name);
    const previousHealth = this.options.health.capture(serverId);
    let health: McpServerHealthState | undefined;
    try {
      await this.publishGeneration({
        serverId,
        status: 'unavailable',
        ...(input.errorMessage === undefined ? {} : { reason: input.errorMessage }),
      }, () => {
        health = this.options.health.recordExit(serverId, input);
        removal.finalize();
      }, () => {
        removal.rollback();
        this.options.health.restore(serverId, previousHealth);
      });
      removal.complete();
    } catch (error) {
      if (this.publicationPoisoned) {
        await this.stopPoisonedUnlocked(serverId);
        throw error instanceof McpGenerationPublicationPoisonedError
          ? error
          : new McpGenerationPublicationPoisonedError(error);
      }
      removal.rollback();
      const subscriptionFailures = releaseMcpSubscriptions(running?.unsubscribers ?? []);
      this.clients.delete(serverId);
      this.options.health.markUnhealthy(
        serverId,
        'MCP process exited but its unavailable generation could not be published.',
      );
      this.options.health.recordDiagnostic(
        serverId,
        'MCP exit state could not be published; local invocation is fail-closed.',
      );
      if (subscriptionFailures > 0) {
        this.options.health.recordDiagnostic(
          serverId,
          subscriptionFailureDiagnostic('exit publication failure', subscriptionFailures),
        );
      }
      throw error;
    }
    this.clients.delete(serverId);
    const retirement = await this.retirePublishedClient(serverId, running);
    const diagnostic = cleanupDiagnostic('process exit', retirement);
    if (diagnostic) health = this.options.health.recordDiagnostic(serverId, diagnostic);
    return {
      serverId,
      removedTools,
      health: health!,
    };
  }

  async restartDue(now: string = new Date().toISOString()): Promise<McpRuntimeStartResult[]> {
    const due = this.options.health
      .list()
      .filter(
        (state) =>
          state.status === 'restarting' &&
          state.nextRestartAt !== undefined &&
          Date.parse(state.nextRestartAt) <= Date.parse(now),
      );
    const results: McpRuntimeStartResult[] = [];
    for (const state of due) {
      results.push(await this.start(state.serverId));
    }
    return results;
  }

  async startAutoStart(signal?: AbortSignal): Promise<McpRuntimeStartResult[]> {
    const controller = new AbortController();
    let markSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      markSettled = resolve;
    });
    const sequence = Object.freeze({ controller, settled, settle: markSettled });
    this.autoStartSequences.add(sequence);
    const forwardAbort = () => {
      if (!controller.signal.aborted) {
        controller.abort(signal?.reason ?? new Error('MCP auto-start was aborted.'));
      }
    };
    if (signal?.aborted) forwardAbort();
    else signal?.addEventListener('abort', forwardAbort, { once: true });
    const clearDeadline = this.armStartupDeadline('auto-start configuration', controller);
    try {
      const servers = await this.awaitStartup(
        () => this.options.configStore.list(),
        controller.signal,
      );
      // Each admitted server owns a separate start deadline. The sequence
      // controller remains connected to caller shutdown between admissions.
      clearDeadline();
      const results: McpRuntimeStartResult[] = [];
      for (const server of servers) {
        if (server.autoStart && server.enabled) {
          if (controller.signal.aborted) throw startupAbortError(controller.signal);
          results.push(await this.start(server.id, controller.signal));
        }
      }
      if (controller.signal.aborted) throw startupAbortError(controller.signal);
      return results;
    } finally {
      clearDeadline();
      signal?.removeEventListener('abort', forwardAbort);
      this.autoStartSequences.delete(sequence);
      sequence.settle();
    }
  }

  health(serverId: string): McpServerHealthState {
    return this.options.health.get(serverId);
  }

  listHealth(): McpServerHealthState[] {
    return this.options.health.list();
  }

  isRunning(serverId: string): boolean {
    return this.clients.has(serverId);
  }

  describe(serverId: string): McpServerDescriptor {
    return structuredClone(this.requireRunningServer(serverId).descriptor);
  }

  async ping(serverId: string, signal?: AbortSignal): Promise<void> {
    this.options.health.assertAvailable(serverId);
    await this.requireRunning(serverId).ping(signal);
  }

  async listResources(serverId: string, signal?: AbortSignal): Promise<McpResourceSpec[]> {
    this.options.health.assertAvailable(serverId);
    return this.requireRunning(serverId).listResources(signal);
  }

  async listResourceTemplates(
    serverId: string,
    signal?: AbortSignal,
  ): Promise<McpResourceTemplateSpec[]> {
    this.options.health.assertAvailable(serverId);
    return this.requireRunning(serverId).listResourceTemplates(signal);
  }

  async readResource(
    serverId: string,
    uri: string,
    signal?: AbortSignal,
  ): Promise<McpReadResourceResult> {
    this.options.health.assertAvailable(serverId);
    return this.requireRunning(serverId).readResource(uri, signal);
  }

  async listPrompts(serverId: string, signal?: AbortSignal): Promise<McpPromptSpec[]> {
    this.options.health.assertAvailable(serverId);
    return this.requireRunning(serverId).listPrompts(signal);
  }

  async getPrompt(
    serverId: string,
    name: string,
    args?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<McpGetPromptResult> {
    this.options.health.assertAvailable(serverId);
    return this.requireRunning(serverId).getPrompt(name, args, signal);
  }

  onResourcesChanged(
    serverId: string,
    handler: (event: McpListChangedEvent<McpResourceSpec>) => void,
  ): () => void {
    return this.requireRunning(serverId).onResourcesChanged?.(handler) ?? (() => {});
  }

  onPromptsChanged(
    serverId: string,
    handler: (event: McpListChangedEvent<McpPromptSpec>) => void,
  ): () => void {
    return this.requireRunning(serverId).onPromptsChanged?.(handler) ?? (() => {});
  }

  private async requireServer(serverId: string): Promise<McpServerConfig> {
    const server = (await this.options.configStore.list()).find((item) => item.id === serverId);
    if (!server) throw new Error(`MCP server not found: ${serverId}.`);
    return server;
  }

  private armStartupDeadline(
    serverId: string,
    controller: AbortController,
    timeoutOverrideMs?: number,
  ): () => void {
    const timeoutMs = positiveInteger(
      timeoutOverrideMs,
      positiveInteger(this.options.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS),
    );
    const timeout = setTimeout(() => {
      if (!controller.signal.aborted) {
        controller.abort(new Error(`MCP startup timed out after ${timeoutMs}ms: ${serverId}.`));
      }
    }, timeoutMs);
    return () => clearTimeout(timeout);
  }

  private abortStartup(serverId: string): void {
    const controller = this.startupControllers.get(serverId);
    if (controller && !controller.signal.aborted) {
      controller.abort(new Error(`MCP startup was cancelled: ${serverId}.`));
    }
  }

  private releaseStartupController(serverId: string, controller: AbortController): void {
    if (this.startupControllers.get(serverId) === controller) {
      this.startupControllers.delete(serverId);
    }
  }

  private async awaitStartup<T>(
    operation: () => Promise<T> | T,
    signal: AbortSignal,
    onLateValue?: (value: T) => void,
  ): Promise<T> {
    if (signal.aborted) throw startupAbortError(signal);
    let acceptingResult = true;
    const observed = Promise.resolve().then(operation);
    void observed.then(
      (value) => {
        if (!acceptingResult) onLateValue?.(value);
      },
      () => undefined,
    );
    const aborted = startupAbortPromise(signal);
    try {
      const value = await Promise.race([observed, aborted.promise]);
      if (signal.aborted) {
        // `observed` may win the microtask race immediately before stop()
        // aborts the startup. At that point the late-value observer has
        // already seen `acceptingResult === true`, so retire the value here
        // before rejecting the cancelled operation.
        onLateValue?.(value);
        throw startupAbortError(signal);
      }
      return value;
    } finally {
      acceptingResult = false;
      aborted.dispose();
    }
  }

  private async retireFailedStartup(
    serverId: string,
    client: McpRuntimeClient,
    unsubscribers: readonly (() => void)[],
  ): Promise<McpClientRetirement> {
    const subscriptionFailures = releaseMcpSubscriptions(unsubscribers);
    const cleanup = await this.cleanupFailedStartup(serverId, client);
    return { cleanup, subscriptionFailures };
  }

  private async retirePublishedClient(
    serverId: string,
    running: McpRunningServer | undefined,
  ): Promise<McpClientRetirement> {
    const subscriptionFailures = releaseMcpSubscriptions(running?.unsubscribers ?? []);
    const cleanup = await this.cleanupPublishedClient(serverId, running?.client);
    return { cleanup, subscriptionFailures };
  }

  private async cleanupFailedStartup(
    serverId: string,
    client: McpRuntimeClient,
  ): Promise<McpCleanupOutcome> {
    let stopPromise: Promise<void> | undefined;
    const stopClient = (): Promise<void> => {
      stopPromise ??= Promise.resolve().then(async () => {
        await client.stop();
      });
      return stopPromise;
    };
    const cleanup = Promise.resolve().then(async () => {
      try {
        await this.options.tools.drainServerTools(serverId);
      } finally {
        await stopClient();
      }
    });
    return await this.awaitBoundedCleanup(cleanup, () => {
      void stopClient().catch(() => undefined);
    });
  }

  private async cleanupPublishedClient(
    serverId: string,
    client: McpRuntimeClient | undefined,
  ): Promise<McpCleanupOutcome> {
    let stopPromise: Promise<void> | undefined;
    const stopClient = (): Promise<void> => {
      stopPromise ??= Promise.resolve().then(async () => {
        if (client) await client.stop();
      });
      return stopPromise;
    };
    const cleanup = Promise.resolve().then(async () => {
      try {
        await this.options.tools.drainServerTools(serverId);
      } finally {
        await stopClient();
      }
    });
    return await this.awaitBoundedCleanup(cleanup, () => {
      // Invocation drain and transport shutdown are independent retirement
      // duties. A stuck Tool invocation must not keep the client process alive.
      void stopClient().catch(() => undefined);
    });
  }

  private stopLateClient(client: McpRuntimeClient): void {
    void Promise.resolve()
      .then(async () => {
        await client.stop();
      })
      .catch(() => undefined);
  }

  private async awaitBoundedCleanup(
    cleanup: Promise<void>,
    onTimeout: () => void,
  ): Promise<McpCleanupOutcome> {
    const timeoutMs = positiveInteger(
      this.options.cleanupTimeoutMs,
      positiveInteger(this.options.startupTimeoutMs, DEFAULT_CLEANUP_TIMEOUT_MS),
    );
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const settled = cleanup.then(
      (): McpCleanupOutcome => ({ status: 'complete' }),
      (): McpCleanupOutcome => ({
        status: 'failed',
        reason: 'cleanup operation rejected',
      }),
    );
    const timedOut = new Promise<McpCleanupOutcome>((resolve) => {
      timeout = setTimeout(() => {
        try {
          onTimeout();
        } catch {
          // The timeout outcome remains authoritative even if a custom cleanup
          // hook throws while force-closing the transport.
        }
        resolve({ status: 'timed_out' });
      }, timeoutMs);
      timeout.unref?.();
    });
    try {
      return await Promise.race([settled, timedOut]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private enqueueLifecycle<T>(serverId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.lifecycleTails.get(serverId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.lifecycleTails.set(serverId, tail);
    void tail.then(() => {
      if (this.lifecycleTails.get(serverId) === tail) {
        this.lifecycleTails.delete(serverId);
      }
    });
    return result;
  }

  private requireRunningServer(serverId: string): McpRunningServer {
    const running = this.clients.get(serverId);
    if (!running) throw new Error(`MCP server is not running: ${serverId}.`);
    return running;
  }

  private requireRunning(serverId: string): McpRuntimeClient {
    return this.requireRunningServer(serverId).client;
  }

  private async handleToolsChanged(
    serverId: string,
    client: McpRuntimeClient,
    event: McpListChangedEvent<McpToolSpec>,
  ): Promise<void> {
    await this.enqueueLifecycle(serverId, () =>
      this.handleToolsChangedUnlocked(serverId, client, event),
    );
  }

  private async handleToolsChangedUnlocked(
    serverId: string,
    client: McpRuntimeClient,
    event: McpListChangedEvent<McpToolSpec>,
  ): Promise<void> {
    const running = this.clients.get(serverId);
    if (running?.client !== client) return;

    if (event.error) {
      // A failed list refresh says nothing about the last successfully published
      // generation. Keep that catalog and lease authoritative, and surface a
      // bounded diagnostic without retracting the ready provider.
      const previousHealth = this.options.health.capture(serverId);
      await this.publishGeneration({
        serverId,
        status: 'ready',
        reason: 'MCP tool catalog refresh failed; the previous catalog remains available.',
      }, () => {
        this.options.health.recordDiagnostic(
          serverId,
          'MCP tool catalog refresh failed; the previous catalog remains available.',
        );
      }, () => this.options.health.restore(serverId, previousHealth));
      return;
    }

    let stagedTools: McpToolGenerationTransaction | undefined;
    try {
      const prepared = this.options.tools.prepareServerTools({
        serverId,
        source: 'user-mcp',
        tools: event.items,
        health: this.options.health,
        ...mcpTransportPermission(running.server),
        callTool: ({ toolName, args, signal }) => client.callTool(toolName, args, signal),
      });
      stagedTools = prepared.stage();
      const previousHealth = this.options.health.capture(serverId);
      await this.publishGeneration({ serverId, status: 'ready' }, () => {
        this.options.health.markHealthy(serverId);
        stagedTools!.finalize();
      }, () => {
        stagedTools?.rollback();
        this.options.health.restore(serverId, previousHealth);
      });
      stagedTools.complete();
      stagedTools = undefined;
    } catch {
      // A rejected ready publication means consumers still have the old published
      // generation. Keep its health and availability state together with its catalog.
      if (!this.publicationPoisoned) stagedTools?.rollback();
      else this.options.tools.retireServerToolsForFatalShutdown(serverId);
      this.options.health.recordDiagnostic(
        serverId,
        this.publicationPoisoned
          ? 'MCP generation publication is poisoned; host restart is required.'
          : 'MCP tool catalog refresh was rejected; the previous complete generation remains active.',
      );
    }
  }

  private async publishGeneration(
    event: McpRuntimeAvailabilityEvent,
    commit: () => void,
    rollback: () => void,
  ): Promise<void> {
    if (this.publicationPoisoned) throw new McpGenerationPublicationPoisonedError();

    type PublicationState = 'pending' | 'committed' | 'rolled_back';
    const publication = { state: 'pending' as PublicationState };
    let commitCalls = 0;
    let rollbackCalls = 0;
    let invalidTransition = false;
    let closed = false;
    let rollbackFailed = false;
    let rollbackFailure: unknown;

    const guardedCommit = (): void => {
      if (this.publicationPoisoned) throw new McpGenerationPublicationPoisonedError();
      if (closed || publication.state !== 'pending' || commitCalls !== 0 || rollbackCalls !== 0) {
        invalidTransition = true;
        throw new McpGenerationPublicationContractError(
          'MCP generation commit must occur exactly once while publication is pending.',
        );
      }
      commitCalls += 1;
      commit();
      publication.state = 'committed';
    };
    const guardedRollback = (): void => {
      if (closed || publication.state === 'rolled_back' || rollbackCalls !== 0) {
        invalidTransition = true;
        throw new McpGenerationPublicationContractError(
          'MCP generation rollback may occur at most once before publication closes.',
        );
      }
      rollbackCalls += 1;
      try {
        rollback();
        publication.state = 'rolled_back';
      } catch (error) {
        rollbackFailed = true;
        rollbackFailure = error;
        throw error;
      }
    };
    const compensate = (): void => {
      if (publication.state === 'rolled_back' || rollbackFailed) return;
      try {
        guardedRollback();
      } catch {
        // The original failure is retained unless compensation itself poisons
        // the publication boundary below.
      }
    };

    let publisherFailed = false;
    let publisherError: unknown;
    if (this.options.onGenerationPublished) {
      try {
        await this.options.onGenerationPublished({
          event,
          commit: guardedCommit,
          rollback: guardedRollback,
        });
      } catch (error) {
        publisherFailed = true;
        publisherError = error;
      }
    } else {
      try {
        guardedCommit();
      } catch (error) {
        publisherFailed = true;
        publisherError = error;
      }
    }

    const committedExactlyOnce = !publisherFailed && publication.state === 'committed' &&
      commitCalls === 1 && rollbackCalls === 0 && !invalidTransition;
    if (committedExactlyOnce) {
      closed = true;
      return;
    }

    compensate();
    closed = true;
    if (rollbackFailed) {
      this.publicationPoisoned = true;
      this.poisonShutdownReported = false;
      try {
        this.options.health.markUnhealthy(
          event.serverId,
          'MCP generation publication compensation failed; host restart is required.',
        );
      } catch {
        // The poisoned error remains authoritative even if health projection
        // cannot be updated after compensation failed.
      }
      throw new McpGenerationPublicationPoisonedError(rollbackFailure);
    }
    if (publisherFailed) throw publisherError;
    throw new McpGenerationPublicationContractError();
  }
}

function mcpTransportPermission(
  server: McpServerConfig,
): Readonly<{ network?: true; host?: string }> {
  if (server.transport === 'stdio') return {};
  const rawUrl = server.url?.trim();
  if (!rawUrl) return { network: true };
  try {
    const host = new URL(rawUrl).hostname.trim().toLocaleLowerCase();
    return host ? { network: true, host } : { network: true };
  } catch {
    return { network: true };
  }
}

function normalizeMcpServerDescriptor(
  input: unknown,
  server: McpServerConfig,
): McpServerDescriptor {
  let snapshot: ReturnType<typeof snapshotMcpMetadata>;
  try {
    snapshot = snapshotMcpMetadata(input);
  } catch {
    throw new TypeError('MCP server descriptor exceeds its portable metadata boundary.');
  }
  if (!isMcpRecord(snapshot)) {
    throw new TypeError('MCP server descriptor does not match the launched server generation.');
  }
  const descriptor = snapshot as Record<string, unknown>;
  if (descriptor.serverId !== server.id || descriptor.transport !== server.transport ||
    !isMcpRecord(descriptor.capabilities)) {
    throw new TypeError('MCP server descriptor does not match the launched server generation.');
  }
  if (descriptor.serverInfo !== undefined && !isMcpRecord(descriptor.serverInfo)) {
    throw new TypeError('MCP server descriptor contains invalid server information.');
  }
  if (descriptor.instructions !== undefined && typeof descriptor.instructions !== 'string') {
    throw new TypeError('MCP server descriptor contains invalid instructions.');
  }
  return {
    serverId: server.id,
    transport: server.transport,
    capabilities: structuredClone(descriptor.capabilities),
    ...(descriptor.serverInfo === undefined
      ? {}
      : { serverInfo: structuredClone(descriptor.serverInfo) }),
    ...(descriptor.instructions === undefined
      ? {}
      : { instructions: descriptor.instructions }),
  };
}

function releaseMcpSubscriptions(unsubscribers: readonly (() => void)[]): number {
  let failures = 0;
  for (const unsubscribe of unsubscribers) {
    try {
      unsubscribe();
    } catch {
      failures += 1;
    }
  }
  return failures;
}

function cleanupDiagnostic(
  phase: string,
  retirement: McpClientRetirement,
): string | undefined {
  const messages: string[] = [];
  if (retirement.subscriptionFailures > 0) {
    messages.push(subscriptionFailureDiagnostic(phase, retirement.subscriptionFailures));
  }
  if (retirement.cleanup.status === 'timed_out') {
    messages.push(`MCP client cleanup is still pending after ${phase}.`);
  } else if (retirement.cleanup.status === 'failed') {
    messages.push(`MCP client cleanup failed after ${phase} (${retirement.cleanup.reason}).`);
  }
  return messages.length === 0 ? undefined : messages.join(' ');
}

function subscriptionFailureDiagnostic(phase: string, failures: number): string {
  return `${String(failures)} MCP subscription cleanup callback(s) failed after ${phase}.`;
}

function isMcpRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function startupAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('MCP startup was aborted.');
}

function startupAbortPromise(signal: AbortSignal): {
  promise: Promise<never>;
  dispose: () => void;
} {
  let listener: (() => void) | undefined;
  const promise = new Promise<never>((_, reject) => {
    const abort = () => reject(startupAbortError(signal));
    if (signal.aborted) {
      abort();
      return;
    }
    listener = abort;
    signal.addEventListener('abort', listener, { once: true });
  });
  return {
    promise,
    dispose: () => {
      if (listener) signal.removeEventListener('abort', listener);
    },
  };
}

function availabilityForHealth(
  serverId: string,
  snapshot: ReturnType<McpHealthManager['capture']>,
  reason: string,
): McpRuntimeAvailabilityEvent {
  const status = snapshot.state?.status;
  if (status === 'disabled') return { serverId, status: 'disabled', reason };
  return {
    serverId,
    status: status === 'healthy' ? 'ready' : 'unavailable',
    reason,
  };
}

function startupExitMessage(event: McpRuntimeExitEvent): string {
  if (event.errorMessage?.trim()) return event.errorMessage.trim();
  const detail = [
    event.code === undefined ? undefined : `code ${String(event.code)}`,
    event.signal?.trim() ? `signal ${event.signal.trim()}` : undefined,
  ]
    .filter((value): value is string => value !== undefined)
    .join(', ');
  return detail
    ? `MCP server exited during startup (${detail}).`
    : 'MCP server exited during startup.';
}

function sameLaunchConfiguration(left: McpServerConfig, right: McpServerConfig): boolean {
  return (
    JSON.stringify(projectLaunchConfiguration(left)) ===
    JSON.stringify(projectLaunchConfiguration(right))
  );
}

function projectLaunchConfiguration(server: McpServerConfig): Record<string, unknown> {
  return {
    transport: server.transport,
    command: server.command,
    args: server.args,
    cwd: server.cwd,
    url: server.url,
    env: server.env,
    headers: server.headers,
  };
}
