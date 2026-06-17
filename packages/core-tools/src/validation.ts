export function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Tool argument "${key}" must be a non-empty string.`);
  }
  return value;
}

export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`Tool argument "${key}" must be a string.`);
  return value;
}

export function optionalPositiveInteger(
  args: Record<string, unknown>,
  key: string,
  fallback?: number,
): number | undefined {
  const value = args[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Tool argument "${key}" must be a positive integer.`);
  }
  return value;
}
