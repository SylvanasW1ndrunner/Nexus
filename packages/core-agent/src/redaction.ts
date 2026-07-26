const REDACTED = '[REDACTED]';
const SENSITIVE_KEY_PATTERN =
  /^(?:access[_-]?token|api[_-]?key|authorization|bearer|connection[_-]?string|credential|credentials|database[_-]?url|db[_-]?url|dsn|password|passwd|pwd|refresh[_-]?token|secret|session[_-]?token|token)$/i;

type StringReplacement = string | ((match: string, ...groups: string[]) => string);

const STRING_REDACTIONS: Array<[RegExp, StringReplacement]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED}`],
  [/\bsk-[A-Za-z0-9_-]{8,}/gi, `sk-${REDACTED}`],
  [
    /\b(postgres(?:ql)?|mysql|mariadb):\/\/([^:\s/@]+):([^@\s]+)@/gi,
    (_match, protocol: string, user: string) => `${protocol}://${user}:${REDACTED}@`,
  ],
  [
    /(["']?(?:api[_-]?key|authorization|connection[_-]?string|credential|database[_-]?url|db[_-]?url|dsn|password|passwd|pwd|secret|session[_-]?token|token)["']?\s*[:=]\s*["'])([^"',}\s]+)(["']?)/gi,
    `$1${REDACTED}$3`,
  ],
];

export function redactPersistedAgentValue(value: unknown): unknown {
  if (typeof value === 'string') return redactPersistedAgentString(value);
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (Array.isArray(value)) return value.map((item) => redactPersistedAgentValue(item));
  if (!value || typeof value !== 'object') return value;

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redactPersistedAgentValue(child);
  }
  return output;
}

export function redactPersistedAgentString(value: string): string {
  return STRING_REDACTIONS.reduce((text, [pattern, replacement]) => {
    return typeof replacement === 'string' ? text.replace(pattern, replacement) : text.replace(pattern, replacement);
  }, value);
}
