import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { redactPersistedAgentValue } from './redaction.js';
import type { AgentBehaviorEvaluationReport } from './types.js';

export type AgentBehaviorEvaluationReportRecord = {
  report: AgentBehaviorEvaluationReport;
  createdAt: string;
};

export type AgentBehaviorEvaluationReportSummary = {
  reportId: string;
  suiteId: string;
  suiteName: string;
  generatedAt: string;
  environment: AgentBehaviorEvaluationReport['environment'];
  providerId?: string;
  model?: string;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  passRate: number;
  createdAt: string;
};

export class AgentBehaviorEvaluationReportStore {
  constructor(private readonly filePath: string) {}

  async save(
    report: AgentBehaviorEvaluationReport,
    now = new Date().toISOString(),
  ): Promise<AgentBehaviorEvaluationReportSummary> {
    const records = await this.readAll();
    const redacted = redactPersistedAgentValue(report) as AgentBehaviorEvaluationReport;
    const existingIndex = records.findIndex(
      (record) => record.report.reportId === redacted.reportId,
    );
    const record: AgentBehaviorEvaluationReportRecord = {
      report: redacted,
      createdAt: existingIndex >= 0 ? records[existingIndex]!.createdAt : now,
    };
    const next =
      existingIndex >= 0
        ? records.map((item, index) => (index === existingIndex ? record : item))
        : [...records, record];
    await writeJsonFileAtomic(this.filePath, next);
    return summarize(record);
  }

  async load(reportId: string): Promise<AgentBehaviorEvaluationReport | undefined> {
    const record = (await this.readAll()).find((item) => item.report.reportId === reportId);
    return record ? cloneJson(record.report) : undefined;
  }

  async list(limit = 100): Promise<AgentBehaviorEvaluationReportSummary[]> {
    if (!Number.isInteger(limit) || limit <= 0)
      throw new Error('limit must be a positive integer.');
    return (await this.readAll()).sort(byGeneratedAtDesc).slice(0, limit).map(summarize);
  }

  private async readAll(): Promise<AgentBehaviorEvaluationReportRecord[]> {
    return redactPersistedAgentValue(
      await readJsonFile<AgentBehaviorEvaluationReportRecord[]>(this.filePath, []),
    ) as AgentBehaviorEvaluationReportRecord[];
  }
}

function summarize(
  record: AgentBehaviorEvaluationReportRecord,
): AgentBehaviorEvaluationReportSummary {
  return {
    reportId: record.report.reportId,
    suiteId: record.report.suiteId,
    suiteName: record.report.suiteName,
    generatedAt: record.report.generatedAt,
    environment: record.report.environment,
    ...(record.report.run.providerId === undefined
      ? {}
      : { providerId: record.report.run.providerId }),
    ...(record.report.run.model === undefined ? {} : { model: record.report.run.model }),
    totalCases: record.report.summary.totalCases,
    passedCases: record.report.summary.passedCases,
    failedCases: record.report.summary.failedCases,
    passRate: record.report.summary.passRate,
    createdAt: record.createdAt,
  };
}

function byGeneratedAtDesc(
  left: AgentBehaviorEvaluationReportRecord,
  right: AgentBehaviorEvaluationReportRecord,
): number {
  return (
    right.report.generatedAt.localeCompare(left.report.generatedAt) ||
    right.createdAt.localeCompare(left.createdAt)
  );
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

async function writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tempPath, filePath);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
