import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import type { PortableValue } from '@dbagent/shared';
import type { ToolInvocationHandlerRuntime } from '../tool-registry.js';
import type { PreparedToolIntent, ToolPrepareContext } from './tool-protocol.js';
import { validatePreparedIntent, validateInvocationInput } from './prepared-invocation.js';
import { ToolInvocationError } from './tool-errors.js';
import type { ToolExecutionDrain } from './tool-resource-leases.js';

export type ToolPreparationInterruption = 'cancelled' | 'timed_out';

export type PreparedToolPreparation = Readonly<{
  intent?: PreparedToolIntent;
  interruption?: ToolPreparationInterruption;
}>;

/** Owns bounded schema validation and preparation; it has no Journal or approval authority. */
export class ToolInvocationPreparer {
  readonly #compiler = new Ajv2020({ allErrors: true, strictSchema: true, strictTypes: false, allowUnionTypes: true, coerceTypes: false, useDefaults: false, removeAdditional: false });
  readonly #schemas = new Map<string, ValidateFunction>();

  async prepare(runtime: ToolInvocationHandlerRuntime, input: Readonly<Record<string, PortableValue>>, context: ToolPrepareContext, drain: Pick<ToolExecutionDrain, 'track'>): Promise<PreparedToolPreparation> {
    validateInvocationInput(input, context.limits);
    const schemaKey = JSON.stringify(context.descriptor.inputSchema);
    let validate = this.#schemas.get(schemaKey);
    if (validate === undefined) {
      validate = this.#compiler.compile(context.descriptor.inputSchema);
      this.#schemas.set(schemaKey, validate);
      if (this.#schemas.size > 128) this.#schemas.delete(this.#schemas.keys().next().value!);
    }
    if (Buffer.byteLength(JSON.stringify(input)) > context.limits.maxInputBytes || !validate(input)) throw new ToolInvocationError('TOOL_INPUT_INVALID', 'Tool arguments do not match its bounded schema.');
    const controller = new AbortController();
    let interruption: ToolPreparationInterruption | undefined;
    let resolveInterruption: ((value: ToolPreparationInterruption) => void) | undefined;
    const interrupted = new Promise<ToolPreparationInterruption>((resolve) => {
      resolveInterruption = resolve;
    });
    const interrupt = (next: ToolPreparationInterruption): void => {
      if (interruption !== undefined) return;
      interruption = next;
      controller.abort();
      resolveInterruption?.(next);
    };
    const abortFromCaller = () => interrupt('cancelled');
    if (context.signal.aborted) abortFromCaller();
    else context.signal.addEventListener('abort', abortFromCaller, { once: true });
    const timer = setTimeout(() => {
      interrupt('timed_out');
    }, context.limits.timeoutMs);
    try {
      const prepared = drain.track(Promise.resolve().then(() => runtime.prepare(input, Object.freeze({ ...context, signal: controller.signal }))));
      const first = await Promise.race([
        prepared.then((intent) => ({ kind: 'prepared' as const, intent })),
        interrupted.then((interruption) => ({ kind: 'interrupted' as const, interruption })),
      ]).catch((error: unknown) => {
        if (interruption !== undefined) return { kind: 'interrupted' as const, interruption };
        throw error;
      });
      if (first.kind === 'interrupted') return Object.freeze({ interruption: first.interruption });
      const intent = validatePreparedIntent({ ...first.intent, runPolicy: context.runPolicy }, context.descriptor);
      return Object.freeze({
        intent,
        ...(interruption === undefined ? {} : { interruption }),
      });
    } finally {
      clearTimeout(timer);
      context.signal.removeEventListener('abort', abortFromCaller);
    }
  }
}
