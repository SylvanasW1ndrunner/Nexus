import type { PortableValue } from '@dbagent/shared';
import type { ToolInvocationHandlerRuntime } from '../tool-registry.js';
import type { ToolExecuteContext } from './tool-protocol.js';

export class ToolHandlerAbort extends Error {
  constructor() { super('Tool Handler aborted.'); this.name = 'ToolHandlerAbort'; }
}

/** Abort is an execution boundary, not proof that an external side effect stopped. */
export function startToolHandlerExecution(
  handler: ToolInvocationHandlerRuntime['execute'],
  args: Readonly<Record<string, PortableValue>>,
  context: ToolExecuteContext,
): Readonly<{ result: Promise<unknown>; settled: Promise<void>; hasStarted(): boolean }> {
  let detach = () => {};
  const aborted = new Promise<never>((_, reject) => {
    const abort = () => reject(new ToolHandlerAbort());
    detach = () => context.signal.removeEventListener('abort', abort);
    if (context.signal.aborted) abort(); else context.signal.addEventListener('abort', abort, { once: true });
  });
  let started = false;
  const execution = Promise.resolve().then(async () => {
    if (context.signal.aborted) throw new ToolHandlerAbort();
    started = true;
    return await handler(args, context);
  });
  const settled = execution.then(() => undefined, () => undefined);
  const result = Promise.race([execution, aborted]).finally(() => detach());
  return Object.freeze({ result, settled, hasStarted: () => started });
}

/** Applies the same abort/drain boundary to post-result domain retention. */
export function startToolResultRetention(
  handler: NonNullable<ToolInvocationHandlerRuntime['retainResult']>,
  payload: PortableValue,
  context: ToolExecuteContext,
): Readonly<{ result: Promise<unknown>; settled: Promise<void>; hasStarted(): boolean }> {
  let detach = () => {};
  const aborted = new Promise<never>((_, reject) => {
    const abort = () => reject(new ToolHandlerAbort());
    detach = () => context.signal.removeEventListener('abort', abort);
    if (context.signal.aborted) abort();
    else context.signal.addEventListener('abort', abort, { once: true });
  });
  let started = false;
  const execution = Promise.resolve().then(async () => {
    if (context.signal.aborted) throw new ToolHandlerAbort();
    started = true;
    return await handler(payload, context);
  });
  const settled = execution.then(() => undefined, () => undefined);
  const result = Promise.race([execution, aborted]).finally(() => detach());
  return Object.freeze({ result, settled, hasStarted: () => started });
}
