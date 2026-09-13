type InvocationHandler = (...args: never[]) => unknown;

const underlyingHandlers = new WeakMap<InvocationHandler, InvocationHandler>();

/**
 * Binds an infrastructure wrapper to the Handler identity supplied by its
 * owner. The WeakMap is Runtime-private, so a Capability cannot forge this
 * equivalence through public object metadata.
 */
export function bindInvocationHandlerIdentity<T extends InvocationHandler>(
  wrapper: T,
  handler: T,
): T {
  underlyingHandlers.set(wrapper, underlyingHandler(handler));
  return wrapper;
}

/** Compares owner Handler identity while ignoring trusted lifecycle wrappers. */
export function sameInvocationHandler(
  left: InvocationHandler | undefined,
  right: InvocationHandler | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return underlyingHandler(left) === underlyingHandler(right);
}

function underlyingHandler(handler: InvocationHandler): InvocationHandler {
  return underlyingHandlers.get(handler) ?? handler;
}
