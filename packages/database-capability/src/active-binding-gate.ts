import { DatabaseCapabilityError } from './errors.js';

export type ActiveBindingGateRelease = () => void;

type ActiveBindingGateWaiter = {
  readonly kind: 'read' | 'write';
  readonly resolve: (release: ActiveBindingGateRelease) => void;
  readonly reject: (error: Error) => void;
  readonly signal?: AbortSignal;
  abort?: () => void;
};

/**
 * Fair in-process read/write gate for a module's single active connection.
 * A queued writer prevents later readers from starving connection lifecycle
 * changes, while already admitted readers remain concurrent.
 */
export class ActiveBindingReadWriteGate {
  private readers = 0;
  private writer = false;
  private readonly queue: ActiveBindingGateWaiter[] = [];

  acquireRead(signal?: AbortSignal): Promise<ActiveBindingGateRelease> {
    return this.acquire('read', signal);
  }

  acquireWrite(): Promise<ActiveBindingGateRelease> {
    return this.acquire('write');
  }

  private acquire(
    kind: ActiveBindingGateWaiter['kind'],
    signal?: AbortSignal,
  ): Promise<ActiveBindingGateRelease> {
    if (signal?.aborted) return Promise.reject(bindingGateAbortError());
    if (this.canGrantImmediately(kind)) return Promise.resolve(this.grant(kind));
    return new Promise<ActiveBindingGateRelease>((resolve, reject) => {
      const waiter: ActiveBindingGateWaiter = {
        kind,
        resolve,
        reject,
        ...(signal === undefined ? {} : { signal }),
      };
      if (signal !== undefined) {
        waiter.abort = () => {
          const index = this.queue.indexOf(waiter);
          if (index < 0) return;
          this.queue.splice(index, 1);
          reject(bindingGateAbortError());
          this.pump();
        };
        signal.addEventListener('abort', waiter.abort, { once: true });
      }
      this.queue.push(waiter);
    });
  }

  private canGrantImmediately(kind: ActiveBindingGateWaiter['kind']): boolean {
    if (this.writer) return false;
    if (kind === 'write') return this.readers === 0 && this.queue.length === 0;
    return !this.queue.some((waiter) => waiter.kind === 'write');
  }

  private grant(kind: ActiveBindingGateWaiter['kind']): ActiveBindingGateRelease {
    if (kind === 'write') this.writer = true;
    else this.readers += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (kind === 'write') this.writer = false;
      else this.readers -= 1;
      this.pump();
    };
  }

  private pump(): void {
    if (this.writer || this.readers > 0 || this.queue.length === 0) return;
    if (this.queue[0]?.kind === 'write') {
      this.deliver(this.queue.shift()!);
      return;
    }
    while (this.queue[0]?.kind === 'read') this.deliver(this.queue.shift()!);
  }

  private deliver(waiter: ActiveBindingGateWaiter): void {
    if (waiter.signal !== undefined && waiter.abort !== undefined) {
      waiter.signal.removeEventListener('abort', waiter.abort);
    }
    waiter.resolve(this.grant(waiter.kind));
  }
}

function bindingGateAbortError(): DatabaseCapabilityError {
  return new DatabaseCapabilityError(
    'ABORTED',
    'Database operation was cancelled before it acquired the active connection.',
    false,
  );
}
