import type {
  ToolCatalogSnapshot,
  ToolInvocationHandlerRuntime,
} from '../tool-registry.js';

/**
 * Raw Invocation Handlers are package authority, never public catalog state.
 * WeakMap ownership keeps them absent from Registry/Snapshot reflection while
 * immutable snapshots still retain the exact Handler generation they captured.
 */
const handlersByOwner = new WeakMap<object, Map<string, ToolInvocationHandlerRuntime>>();

export function setInvocationHandler(
  owner: object,
  toolName: string,
  runtime: ToolInvocationHandlerRuntime,
): void {
  const handlers = handlersByOwner.get(owner) ?? new Map<string, ToolInvocationHandlerRuntime>();
  handlers.set(toolName, runtime);
  handlersByOwner.set(owner, handlers);
}

export function deleteInvocationHandler(owner: object, toolName: string): void {
  handlersByOwner.get(owner)?.delete(toolName);
}

export function cloneInvocationHandlers(
  owner: object,
): Map<string, ToolInvocationHandlerRuntime> {
  return new Map(handlersByOwner.get(owner) ?? []);
}

export function replaceInvocationHandlers(
  owner: object,
  handlers: ReadonlyMap<string, ToolInvocationHandlerRuntime>,
): void {
  handlersByOwner.set(owner, new Map(handlers));
}

export function bindInvocationHandlerSnapshot(
  registry: object,
  snapshot: ToolCatalogSnapshot,
): void {
  handlersByOwner.set(snapshot, cloneInvocationHandlers(registry));
}

export function resolveInvocationHandler(
  snapshot: ToolCatalogSnapshot,
  toolName: string,
): ToolInvocationHandlerRuntime | undefined {
  return handlersByOwner.get(snapshot)?.get(toolName);
}
