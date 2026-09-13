import type {
  AgentToolSnapshotLifecycle,
  ToolRegistry,
  ToolInvocationContribution,
} from '@dbagent/core-agent';
import {
  mcpOwnerId,
  prepareMcpTools,
  type McpToolAdapterOptions,
  type RegisteredMcpTool,
} from './mcp-tool-adapter.js';

export type McpServerToolRegistrationOptions = McpToolAdapterOptions;

export type McpToolGenerationTransaction = {
  readonly tools: readonly RegisteredMcpTool[];
  finalize(): RegisteredMcpTool[];
  /** Retires the prior lease only after the host has accepted the publication. */
  complete(): void;
  rollback(): RegisteredMcpTool[];
};

type McpToolGeneration = {
  tools: RegisteredMcpTool[];
  lease: McpToolGenerationLease;
  prepared: ReturnType<typeof prepareMcpTools>;
  retirement?: Promise<void>;
};

export class McpToolRegistrationManager {
  private readonly byServer = new Map<
    string,
    McpToolGeneration
  >();
  /** Every generation which may still be captured by Registry or a Turn. */
  private readonly liveGenerations = new Map<string, Set<McpToolGeneration>>();
  private readonly retirements = new Map<string, Set<Promise<void>>>();

  constructor(private readonly registry: ToolRegistry) {}

  prepareServerTools(options: McpServerToolRegistrationOptions): {
    tools: readonly RegisteredMcpTool[];
    stage: () => McpToolGenerationTransaction;
    commit: () => RegisteredMcpTool[];
  } {
    const prepared = prepareMcpTools(options);
    let staged = false;
    const stage = (): McpToolGenerationTransaction => {
      if (staged) {
        throw new Error(`MCP Tool catalog was already committed: ${options.serverId}.`);
      }
      staged = true;
      return this.stageServerTools(options.serverId, prepared);
    };
    return {
      tools: [...prepared.tools],
      stage,
      commit: () => {
        const transaction = stage();
        const tools = transaction.finalize();
        transaction.complete();
        return tools;
      },
    };
  }

  registerServerTools(options: McpServerToolRegistrationOptions): RegisteredMcpTool[] {
    return this.prepareServerTools(options).commit();
  }

  private stageServerTools(
    serverId: string,
    prepared: ReturnType<typeof prepareMcpTools>,
  ): McpToolGenerationTransaction {
    const lease = new McpToolGenerationLease(serverId);
    const next: McpToolGeneration = { tools: prepared.tools, lease, prepared };
    const previous = this.byServer.get(serverId);
    if (previous) this.trackGeneration(serverId, previous);
    this.trackGeneration(serverId, next);

    let installed = false;
    let completed = false;
    return {
      tools: [...next.tools],
      finalize: () => {
        if (installed) return [...next.tools];
        this.registry.replaceOwnerInvocations(mcpOwnerId(serverId), this.contributions(next), {
          snapshotLifecycle: lease,
        });
        installed = true;
        this.byServer.set(serverId, next);
        return [...next.tools];
      },
      complete: () => {
        if (!installed || completed) return;
        completed = true;
        if (previous) this.retire(serverId, previous);
      },
      rollback: () => {
        if (completed) return [...(this.byServer.get(serverId)?.tools ?? [])];
        if (installed) {
          this.registry.replaceOwnerInvocations(
            mcpOwnerId(serverId),
            previous ? this.contributions(previous) : [],
            previous === undefined ? undefined : { snapshotLifecycle: previous.lease },
          );
          if (previous) this.byServer.set(serverId, previous);
          else this.byServer.delete(serverId);
          this.retire(serverId, next);
          completed = true;
          return [...(previous?.tools ?? [])];
        }
        completed = true;
        this.retire(serverId, next);
        return [...(previous?.tools ?? [])];
      },
    };
  }

  private contributions(generation: McpToolGeneration): ToolInvocationContribution[] {
    return generation.prepared.contributions.map((contribution) =>
      leaseContribution(contribution, generation.lease),
    );
  }

  unregisterServerTools(serverId: string): RegisteredMcpTool[] {
    const registered = this.byServer.get(serverId);
    this.registry.replaceOwnerInvocations(mcpOwnerId(serverId), []);
    this.byServer.delete(serverId);
    if (registered) this.retire(serverId, registered);
    return [...(registered?.tools ?? [])];
  }

  /**
   * Fatal shutdown fence used after publication compensation is poisoned.
   * It deliberately leaves the unknowable Registry catalog untouched, but
   * stops accepting every generation which may still be captured by Registry
   * or a Turn and exposes all drains before client force-close.
   */
  retireServerToolsForFatalShutdown(serverId: string): void {
    const indexed = this.byServer.get(serverId);
    if (indexed) this.trackGeneration(serverId, indexed);
    this.byServer.delete(serverId);
    for (const generation of [...(this.liveGenerations.get(serverId) ?? [])]) {
      this.retire(serverId, generation);
    }
  }

  /** Prepares removal without exposing an empty catalog before publication. */
  prepareUnregisterServerTools(serverId: string): McpToolGenerationTransaction {
    const previous = this.byServer.get(serverId);
    if (previous) this.trackGeneration(serverId, previous);
    let installed = false;
    let completed = false;
    return {
      tools: [],
      finalize: () => {
        if (installed) return [];
        installed = true;
        this.registry.replaceOwnerInvocations(mcpOwnerId(serverId), []);
        this.byServer.delete(serverId);
        return [];
      },
      complete: () => {
        if (!installed || completed) return;
        completed = true;
        if (previous) this.retire(serverId, previous);
      },
      rollback: () => {
        if (completed) return [];
        if (installed && previous) {
          this.registry.replaceOwnerInvocations(mcpOwnerId(serverId), this.contributions(previous), {
            snapshotLifecycle: previous.lease,
          });
          this.byServer.set(serverId, previous);
        }
        completed = true;
        return [...(previous?.tools ?? [])];
      },
    };
  }

  async drainServerTools(serverId: string): Promise<void> {
    const pending = [...(this.retirements.get(serverId) ?? [])];
    await Promise.all(pending);
  }

  listServerTools(serverId: string): RegisteredMcpTool[] {
    return [...(this.byServer.get(serverId)?.tools ?? [])];
  }

  listAll(): RegisteredMcpTool[] {
    return [...this.byServer.values()].flatMap(({ tools }) => [...tools]);
  }

  private trackGeneration(serverId: string, generation: McpToolGeneration): void {
    const generations = this.liveGenerations.get(serverId) ?? new Set<McpToolGeneration>();
    generations.add(generation);
    this.liveGenerations.set(serverId, generations);
  }

  private retire(serverId: string, generation: McpToolGeneration): void {
    if (generation.retirement !== undefined) return;
    generation.lease.stopAccepting();
    const pending = generation.lease.drain();
    generation.retirement = pending;
    const retirements = this.retirements.get(serverId) ?? new Set<Promise<void>>();
    retirements.add(pending);
    this.retirements.set(serverId, retirements);
    void pending.finally(() => {
      retirements.delete(pending);
      if (retirements.size === 0) this.retirements.delete(serverId);
      const generations = this.liveGenerations.get(serverId);
      generations?.delete(generation);
      if (generations?.size === 0) this.liveGenerations.delete(serverId);
    });
  }
}

class McpToolGenerationLease implements AgentToolSnapshotLifecycle {
  private accepting = true;
  private snapshotPins = 0;
  private inFlight = 0;
  private readonly waiters = new Set<() => void>();

  constructor(private readonly serverId: string) {}

  retain(): () => void {
    this.snapshotPins += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.snapshotPins -= 1;
      this.flush();
    };
  }

  async run<T>(operation: () => T | Promise<T>): Promise<T> {
    if (!this.accepting && this.snapshotPins === 0) {
      throw new Error(`MCP tool generation is no longer active: ${this.serverId}.`);
    }
    this.inFlight += 1;
    try {
      return await operation();
    } finally {
      this.inFlight -= 1;
      this.flush();
    }
  }

  stopAccepting(): void {
    this.accepting = false;
    this.flush();
  }

  async drain(): Promise<void> {
    if (this.inFlight === 0 && this.snapshotPins === 0) return;
    await new Promise<void>((resolve) => this.waiters.add(resolve));
  }

  private flush(): void {
    if (this.accepting || this.inFlight > 0 || this.snapshotPins > 0) return;
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }
}

function leaseContribution(
  contribution: ToolInvocationContribution,
  lease: McpToolGenerationLease,
): ToolInvocationContribution {
  return {
    definition: contribution.definition,
    runtime: {
      revision: contribution.runtime.revision,
      prepare: (args, context) =>
        lease.run(() => contribution.runtime.prepare(args, context)),
      execute: (args, context) => lease.run(() => contribution.runtime.execute(args, context)),
      ...(contribution.runtime.recover === undefined
        ? {}
        : {
            recover: (args, context) =>
              lease.run(() => contribution.runtime.recover!(args, context)),
          }),
    },
  };
}
