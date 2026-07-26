import { Buffer } from 'node:buffer';

export function estimateRetainedValueBytes(value: unknown, limit: number): number {
  const seen = new WeakSet<object>();
  let total = 0;

  const add = (bytes: number): boolean => {
    total += bytes;
    return total <= limit;
  };
  const visit = (item: unknown): boolean => {
    if (item === null) return add(4);
    if (typeof item === 'string') return add(Buffer.byteLength(item, 'utf8') + 8);
    if (typeof item === 'number' || typeof item === 'bigint') {
      return add(Buffer.byteLength(String(item), 'utf8') + 8);
    }
    if (typeof item === 'boolean') return add(4);
    if (item === undefined) return add(4);
    if (typeof item !== 'object') return add(8);
    if (seen.has(item)) return add(8);
    seen.add(item);

    if (item instanceof ArrayBuffer) return add(item.byteLength + 32);
    if (ArrayBuffer.isView(item)) return add(item.byteLength + 32);
    if (item instanceof Date) return add(24);
    if (item instanceof RegExp) {
      return add(
        Buffer.byteLength(item.source, 'utf8') + Buffer.byteLength(item.flags, 'utf8') + 32,
      );
    }
    if (item instanceof Map) {
      if (!add(32)) return false;
      for (const [key, child] of item) {
        if (!visit(key) || !visit(child)) return false;
      }
      return true;
    }
    if (item instanceof Set) {
      if (!add(32)) return false;
      for (const child of item) {
        if (!visit(child)) return false;
      }
      return true;
    }
    if (item instanceof Error) {
      return (
        add(32) &&
        visit(item.name) &&
        visit(item.message) &&
        (item.stack === undefined || visit(item.stack))
      );
    }
    if (typeof Blob !== 'undefined' && item instanceof Blob) return add(item.size + 32);

    if (!add(32)) return false;
    if (Array.isArray(item)) {
      for (const child of item) {
        if (!visit(child)) return false;
      }
      return true;
    }
    for (const [key, child] of Object.entries(item)) {
      if (!add(Buffer.byteLength(key, 'utf8') + 8) || !visit(child)) return false;
    }
    return true;
  };

  return visit(value) ? total : limit + 1;
}
