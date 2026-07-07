import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, open, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { buildDiagnosticReport, type DiagnosticReport, type DiagnosticTextEntry } from '@dbagent/core-tools';
import type { DesktopDiagnosticReportResult } from '@dbagent/shared';

export type DesktopDiagnosticReportServiceOptions = {
  userDataDir: string;
  dataDir: string;
  logsDir: string;
  reportsDir?: string;
  app: {
    name: string;
    version: string;
    commit?: string;
  };
  runtime?: {
    platform?: string;
    arch?: string;
    nodeVersion?: string;
    electronVersion?: string;
  };
  maxSourceBytes?: number;
};

export type GenerateDesktopDiagnosticReportOptions = {
  generatedAt?: string;
  retentionDays?: number;
  maxEntryBytes?: number;
};

const DEFAULT_MAX_SOURCE_BYTES = 768 * 1024;
const CONFIG_FILE_NAMES = ['connections.json', 'workspace-state.json', 'workspaces.json', 'plugins.json', 'ide-settings.json'];
const LOG_FILE_PATTERNS = [/^main\.log$/i, /^app-.*\.log$/i, /^renderer-.*\.log$/i, /^agent-.*\.jsonl$/i];
const CRASH_FILE_PATTERNS = [/^crash-.*\.(dump|log|txt|json)$/i];

export class DesktopDiagnosticReportService {
  private readonly reportsDir: string;
  private readonly maxSourceBytes: number;

  constructor(private readonly options: DesktopDiagnosticReportServiceOptions) {
    this.reportsDir = options.reportsDir ?? join(options.userDataDir, 'diagnostic-reports');
    this.maxSourceBytes = normalizePositiveInteger(options.maxSourceBytes, DEFAULT_MAX_SOURCE_BYTES);
  }

  async generate(options: GenerateDesktopDiagnosticReportOptions = {}): Promise<DesktopDiagnosticReportResult> {
    const generatedAt = options.generatedAt ?? new Date().toISOString();
    const report = buildDiagnosticReport({
      generatedAt,
      app: this.options.app,
      runtime: {
        platform: this.options.runtime?.platform ?? process.platform,
        arch: this.options.runtime?.arch ?? process.arch,
        nodeVersion: this.options.runtime?.nodeVersion ?? process.version,
        ...(this.options.runtime?.electronVersion === undefined ? {} : { electronVersion: this.options.runtime.electronVersion }),
      },
      configs: await this.collectConfigs(),
      logs: await this.collectLogs(),
      crashSnapshots: await this.collectCrashSnapshots(),
      options: {
        ...(options.retentionDays === undefined ? {} : { retentionDays: options.retentionDays }),
        ...(options.maxEntryBytes === undefined ? {} : { maxEntryBytes: options.maxEntryBytes }),
      },
    });
    const reportPath = await this.writeReport(report);

    return {
      reportPath,
      artifactKind: 'directory',
      generatedAt: report.generatedAt,
      fileCount: report.files.length,
      totalBytes: report.files.reduce((sum, file) => sum + file.bytes, 0),
      summary: report.summary,
    };
  }

  private async collectConfigs(): Promise<DiagnosticTextEntry[]> {
    const entries: DiagnosticTextEntry[] = [];
    for (const fileName of CONFIG_FILE_NAMES) {
      const filePath = join(this.options.dataDir, fileName);
      const entry = await this.readTextEntry(filePath, fileName);
      if (entry) entries.push(entry);
    }
    return entries;
  }

  private async collectLogs(): Promise<DiagnosticTextEntry[]> {
    const entries: DiagnosticTextEntry[] = [];
    const mainLog = await this.readTextEntry(join(this.options.userDataDir, 'main.log'), 'main.log');
    if (mainLog) entries.push(mainLog);

    const logFiles = await listMatchingFiles(this.options.logsDir, LOG_FILE_PATTERNS);
    for (const filePath of logFiles) {
      const entry = await this.readTextEntry(filePath, basename(filePath));
      if (entry) entries.push(entry);
    }
    return entries;
  }

  private async collectCrashSnapshots(): Promise<DiagnosticTextEntry[]> {
    const crashFiles = [
      ...(await listMatchingFiles(this.options.userDataDir, CRASH_FILE_PATTERNS)),
      ...(await listMatchingFiles(this.options.logsDir, CRASH_FILE_PATTERNS)),
    ];
    const uniqueFiles = Array.from(new Set(crashFiles));
    const entries: DiagnosticTextEntry[] = [];
    for (const filePath of uniqueFiles) {
      const entry = await this.readTextEntry(filePath, basename(filePath));
      if (entry) entries.push(entry);
    }
    return entries;
  }

  private async readTextEntry(filePath: string, reportPath: string): Promise<DiagnosticTextEntry | undefined> {
    try {
      const info = await stat(filePath);
      if (!info.isFile()) return undefined;
      return {
        path: reportPath,
        content: await readTextTail(filePath, this.maxSourceBytes),
        createdAt: info.mtime.toISOString(),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private async writeReport(report: DiagnosticReport): Promise<string> {
    const reportDir = join(this.reportsDir, reportDirectoryName(report.generatedAt, report.files.length));
    await mkdir(reportDir, { recursive: true });
    for (const file of report.files) {
      const filePath = resolveReportFilePath(reportDir, file.path);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, file.content, 'utf8');
    }
    return reportDir;
  }
}

export function reportDirectoryName(generatedAt: string, fileCount: number): string {
  const safeTimestamp = generatedAt.replace(/[:.]/g, '-').replace(/[^0-9TZ-]/g, '_');
  const suffix = createHash('sha256').update(`${generatedAt}:${fileCount}`).digest('hex').slice(0, 8);
  return `diagnostic-${safeTimestamp}-${suffix}`;
}

export function resolveReportFilePath(reportDir: string, relativePath: string): string {
  const root = resolve(reportDir);
  const target = resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error(`Diagnostic report file escapes report directory: ${relativePath}`);
  }
  return target;
}

async function listMatchingFiles(directory: string, patterns: RegExp[]): Promise<string[]> {
  try {
    await access(directory, constants.R_OK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && patterns.some((pattern) => pattern.test(entry.name)))
    .map((entry) => join(directory, entry.name))
    .sort();
}

async function readTextTail(filePath: string, maxBytes: number): Promise<string> {
  const info = await stat(filePath);
  const bytesToRead = Math.min(info.size, maxBytes);
  const start = Math.max(0, info.size - bytesToRead);
  const buffer = Buffer.alloc(bytesToRead);
  const file = await open(filePath, 'r');
  try {
    await file.read(buffer, 0, bytesToRead, start);
  } finally {
    await file.close();
  }
  const prefix = info.size > maxBytes ? `[SOURCE_TRUNCATED_TO_LAST_${maxBytes}_BYTES]\n` : '';
  return `${prefix}${buffer.toString('utf8')}`;
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}
