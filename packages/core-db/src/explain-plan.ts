import type { Result } from '@dbagent/shared';
import { err, ok } from '@dbagent/shared';

export type ExplainPlanWarningKind =
  | 'sequential_scan'
  | 'high_cost'
  | 'slow_node'
  | 'large_filter'
  | 'nested_loop_large_input'
  | 'sort_spill_risk';

export type ExplainPlanWarning = {
  kind: ExplainPlanWarningKind;
  nodeId: string;
  message: string;
  severity: 'info' | 'warning' | 'critical';
};

export type ExplainPlanNode = {
  id: string;
  nodeType: string;
  relationName?: string;
  indexName?: string;
  joinType?: string;
  filter?: string;
  indexCondition?: string;
  actualRows?: number;
  planRows?: number;
  actualTotalTimeMs?: number;
  totalCost?: number;
  rowsRemovedByFilter?: number;
  children: ExplainPlanNode[];
};

export type ExplainPlanAnalysis = {
  planningTimeMs?: number;
  executionTimeMs?: number;
  root: ExplainPlanNode;
  warnings: ExplainPlanWarning[];
  flattened: ExplainPlanNode[];
};

type RawPlanNode = Record<string, unknown>;

export function analyzePostgresExplainJson(input: unknown): Result<ExplainPlanAnalysis> {
  const document = normalizeExplainDocument(input);
  if (!document.ok) return document;
  const rootValue = document.data.Plan;
  if (!isRecord(rootValue)) {
    return err({ code: 'VALIDATION_ERROR', message: 'EXPLAIN JSON does not contain a Plan object.' });
  }

  const flattened: ExplainPlanNode[] = [];
  const root = normalizePlanNode(rootValue, '0', flattened);
  const analysis: ExplainPlanAnalysis = {
    root,
    flattened,
    warnings: buildWarnings(flattened),
  };
  const planningTime = readNumber(document.data, 'Planning Time');
  const executionTime = readNumber(document.data, 'Execution Time');
  if (planningTime !== undefined) analysis.planningTimeMs = planningTime;
  if (executionTime !== undefined) analysis.executionTimeMs = executionTime;
  return ok(analysis);
}

function normalizeExplainDocument(input: unknown): Result<Record<string, unknown>> {
  const value = unwrapQueryPlanCell(input);
  if (Array.isArray(value)) {
    const first: unknown = value[0];
    if (isRecord(first)) return ok(first);
  }
  if (isRecord(value)) return ok(value);
  return err({ code: 'VALIDATION_ERROR', message: 'EXPLAIN JSON must be an object or a PostgreSQL FORMAT JSON array.' });
}

function unwrapQueryPlanCell(input: unknown): unknown {
  if (isRecord(input) && 'QUERY PLAN' in input) return input['QUERY PLAN'];
  return input;
}

function normalizePlanNode(raw: RawPlanNode, id: string, flattened: ExplainPlanNode[]): ExplainPlanNode {
  const node: ExplainPlanNode = {
    id,
    nodeType: readString(raw, 'Node Type') ?? 'Unknown',
    children: [],
  };
  assignOptionalString(node, 'relationName', readString(raw, 'Relation Name'));
  assignOptionalString(node, 'indexName', readString(raw, 'Index Name'));
  assignOptionalString(node, 'joinType', readString(raw, 'Join Type'));
  assignOptionalString(node, 'filter', readString(raw, 'Filter'));
  assignOptionalString(node, 'indexCondition', readString(raw, 'Index Cond'));
  assignOptionalNumber(node, 'actualRows', readNumber(raw, 'Actual Rows'));
  assignOptionalNumber(node, 'planRows', readNumber(raw, 'Plan Rows'));
  assignOptionalNumber(node, 'actualTotalTimeMs', readNumber(raw, 'Actual Total Time'));
  assignOptionalNumber(node, 'totalCost', readNumber(raw, 'Total Cost'));
  assignOptionalNumber(node, 'rowsRemovedByFilter', readNumber(raw, 'Rows Removed by Filter'));

  flattened.push(node);
  const childPlans = raw.Plans;
  if (Array.isArray(childPlans)) {
    node.children = childPlans
      .filter(isRecord)
      .map((child, index) => normalizePlanNode(child, `${id}.${index}`, flattened));
  }
  return node;
}

function buildWarnings(nodes: ExplainPlanNode[]): ExplainPlanWarning[] {
  const warnings: ExplainPlanWarning[] = [];
  for (const node of nodes) {
    const label = describeNode(node);
    if (node.nodeType === 'Seq Scan' && (node.filter || (node.planRows ?? 0) >= 1000)) {
      warnings.push({
        kind: 'sequential_scan',
        nodeId: node.id,
        severity: (node.rowsRemovedByFilter ?? 0) > 10000 ? 'critical' : 'warning',
        message: `${label} uses a sequential scan; consider whether a selective index is missing.`,
      });
    }
    if ((node.totalCost ?? 0) >= 100000) {
      warnings.push({
        kind: 'high_cost',
        nodeId: node.id,
        severity: 'warning',
        message: `${label} has high estimated cost (${node.totalCost}).`,
      });
    }
    if ((node.actualTotalTimeMs ?? 0) >= 1000) {
      warnings.push({
        kind: 'slow_node',
        nodeId: node.id,
        severity: 'critical',
        message: `${label} took ${node.actualTotalTimeMs}ms in actual execution.`,
      });
    }
    if ((node.rowsRemovedByFilter ?? 0) >= 10000) {
      warnings.push({
        kind: 'large_filter',
        nodeId: node.id,
        severity: 'warning',
        message: `${label} removed ${node.rowsRemovedByFilter} rows by filter.`,
      });
    }
    if (node.nodeType === 'Nested Loop' && (node.actualRows ?? node.planRows ?? 0) >= 10000) {
      warnings.push({
        kind: 'nested_loop_large_input',
        nodeId: node.id,
        severity: 'warning',
        message: `${label} is a nested loop with a large row count; verify join indexes and cardinality estimates.`,
      });
    }
    if (node.nodeType === 'Sort' && (node.planRows ?? 0) >= 100000) {
      warnings.push({
        kind: 'sort_spill_risk',
        nodeId: node.id,
        severity: 'info',
        message: `${label} sorts many rows; check work_mem and supporting indexes.`,
      });
    }
  }
  return warnings;
}

function describeNode(node: ExplainPlanNode): string {
  if (node.relationName) return `${node.nodeType} on ${node.relationName}`;
  if (node.indexName) return `${node.nodeType} using ${node.indexName}`;
  return node.nodeType;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function assignOptionalString<T extends object, K extends keyof T>(target: T, key: K, value: string | undefined): void {
  if (value !== undefined) target[key] = value as T[K];
}

function assignOptionalNumber<T extends object, K extends keyof T>(target: T, key: K, value: number | undefined): void {
  if (value !== undefined) target[key] = value as T[K];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
