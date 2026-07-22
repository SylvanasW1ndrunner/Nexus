export type DiagnosticTextEntry = {
  path: string;
  content: string;
  createdAt?: string;
};

export type DiagnosticReportInput = {
  generatedAt?: string;
  app: {
    name: string;
    version: string;
    commit?: string;
  };
  runtime: {
    platform: string;
    arch: string;
    nodeVersion?: string;
  };
  configs?: DiagnosticTextEntry[];
  logs?: DiagnosticTextEntry[];
  crashSnapshots?: DiagnosticTextEntry[];
  options?: {
    retentionDays?: number;
    maxEntryBytes?: number;
  };
};

export type DiagnosticReportFile = {
  path: string;
  content: string;
  bytes: number;
};

export type DiagnosticReport = {
  generatedAt: string;
  files: DiagnosticReportFile[];
  summary: {
    configCount: number;
    logCount: number;
    crashSnapshotCount: number;
    redactionCount: number;
    omittedCount: number;
  };
};

export type RedactedText = {
  text: string;
  redactionCount: number;
};

const DEFAULT_RETENTION_DAYS = 7;
const DEFAULT_MAX_ENTRY_BYTES = 512 * 1024;

export function buildDiagnosticReport(input: DiagnosticReportInput): DiagnosticReport {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const retentionDays = normalizePositiveInteger(input.options?.retentionDays, DEFAULT_RETENTION_DAYS);
  const maxEntryBytes = normalizePositiveInteger(input.options?.maxEntryBytes, DEFAULT_MAX_ENTRY_BYTES);
  const files: DiagnosticReportFile[] = [];
  let redactionCount = 0;
  let omittedCount = 0;

  files.push(toReportFile('manifest.json', JSON.stringify(buildManifest(input, generatedAt), null, 2)));

  const appendEntries = (folder: string, entries: DiagnosticTextEntry[] | undefined) => {
    for (const entry of entries ?? []) {
      if (!isWithinRetention(entry.createdAt, generatedAt, retentionDays)) {
        omittedCount += 1;
        continue;
      }
      const limited = limitTextBytes(entry.content, maxEntryBytes);
      const redacted = redactDiagnosticText(limited.text);
      redactionCount += redacted.redactionCount;
      const reportPath = `${folder}/${sanitizeReportPath(entry.path)}${limited.truncated ? '.tail' : ''}`;
      files.push(toReportFile(reportPath, redacted.text));
    }
  };

  appendEntries('configs', input.configs);
  appendEntries('logs', input.logs);
  appendEntries('crash', input.crashSnapshots);

  return {
    generatedAt,
    files,
    summary: {
      configCount: input.configs?.length ?? 0,
      logCount: input.logs?.length ?? 0,
      crashSnapshotCount: input.crashSnapshots?.length ?? 0,
      redactionCount,
      omittedCount,
    },
  };
}

export function redactDiagnosticText(text: string): RedactedText {
  let redactionCount = 0;
  const replaceAll = (pattern: RegExp, replacement: string) => {
    text = text.replace(pattern, (match: string) => {
      if (match === replacement) return match;
      redactionCount += 1;
      return replacement;
    });
  };
  const replacePrefixed = (pattern: RegExp, replacement: string) => {
    text = text.replace(pattern, (_match: string, prefix: string) => {
      redactionCount += 1;
      return `${prefix}${replacement}`;
    });
  };

  replaceAll(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_API_KEY]');
  replaceAll(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, 'Bearer [REDACTED_TOKEN]');
  replacePrefixed(/("(?:apiKey|api_key|password|token|accessToken|refreshToken|secret)"\s*:\s*)"[^"]*"/gi, '"[REDACTED_SECRET]"');
  replacePrefixed(/((?:apiKey|api_key|password|token|accessToken|refreshToken|secret)\s*=\s*)[^\s,;]+/gi, '[REDACTED_SECRET]');
  replacePrefixed(/("(?:sql|query)"\s*:\s*)"[^"]*"/gi, '"[REDACTED_SQL]"');
  text = text.replace(/((?:sql|query)\s*=\s*)("[^"]*"|[^\r\n;]*)/gi, (_match, prefix, value) => {
    redactionCount += 1;
    const quoted = String(value ?? '').trim().startsWith('"');
    return `${String(prefix ?? '')}${quoted ? '"[REDACTED_SQL]"' : '[REDACTED_SQL]'}`;
  });
  text = text.replace(/\b(select|insert|update|delete|drop|alter|create)\s+[^;"\r\n]*(;)?/gi, (_match, _verb, semicolon) => {
    redactionCount += 1;
    return `[REDACTED_SQL]${semicolon ?? ''}`;
  });

  return { text, redactionCount };
}

function buildManifest(input: DiagnosticReportInput, generatedAt: string): Record<string, unknown> {
  return {
    generatedAt,
    app: input.app,
    runtime: input.runtime,
    retentionDays: input.options?.retentionDays ?? DEFAULT_RETENTION_DAYS,
    maxEntryBytes: input.options?.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES,
  };
}

function toReportFile(path: string, content: string): DiagnosticReportFile {
  return {
    path,
    content,
    bytes: new TextEncoder().encode(content).byteLength,
  };
}

function isWithinRetention(createdAt: string | undefined, generatedAt: string, retentionDays: number): boolean {
  if (!createdAt) return true;
  const createdTime = Date.parse(createdAt);
  const generatedTime = Date.parse(generatedAt);
  if (!Number.isFinite(createdTime) || !Number.isFinite(generatedTime)) return true;
  return createdTime >= generatedTime - retentionDays * 24 * 60 * 60 * 1000 && createdTime <= generatedTime;
}

function sanitizeReportPath(path: string): string {
  return path
    .replace(/^[a-zA-Z]:[\\/]/, '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/');
}

function limitTextBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= maxBytes) return { text, truncated: false };
  const tail = new TextDecoder().decode(bytes.slice(Math.max(0, bytes.byteLength - maxBytes)));
  return { text: `[TRUNCATED_TO_LAST_${maxBytes}_BYTES]\n${tail}`, truncated: true };
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}
