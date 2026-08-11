import type { PortableValue } from '@dbagent/shared';

export type RuntimeCommandOrigin = Readonly<{
  runId: string;
  turnId: string;
  invocationId: string;
}>;

type RuntimeCommandBase<K extends string, P extends PortableValue> = Readonly<{
  schemaVersion: 1;
  kind: K;
  commandId: string;
  origin: RuntimeCommandOrigin;
  expectedRunRevision: number;
  fencingToken: number;
  payload: P;
}>;

export type RuntimeCommand =
  | RuntimeCommandBase<'plan.create', { planId: string; plan: PortableValue }>
  | RuntimeCommandBase<'plan.update', { planId: string; expectedPlanRevision: number; plan: PortableValue }>
  | RuntimeCommandBase<'tool.activate', { names: string[] }>
  | RuntimeCommandBase<'skill.activate', { ids: string[] }>
  | RuntimeCommandBase<'child.start', { task: string; context: PortableValue }>
  | RuntimeCommandBase<'child.steer', { childRunId: string; input: PortableValue }>
  | RuntimeCommandBase<'child.cancel', { childRunId: string; reason?: string }>;

export type RuntimeCommandInput = RuntimeCommand;

export class RuntimeCommandError extends Error {
  constructor(
    readonly code: 'RUNTIME_COMMAND_INVALID' | 'RUNTIME_COMMAND_UNAUTHENTIC',
    message: string,
  ) {
    super(message);
    this.name = 'RuntimeCommandError';
  }
}
