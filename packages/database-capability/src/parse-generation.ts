import { DatabaseCapabilityError } from './errors.js';
import type { ParsedGeneratedSql } from './types.js';

const SQL_FENCE = /```sql\s*([\s\S]*?)```/i;
const JSON_FENCE = /```(?:json)?\s*([\s\S]*?)```/i;

export function parseGeneratedSqlResponse(text: string): ParsedGeneratedSql {
  const trimmed = text.trim();
  if (!trimmed) throw invalidResponse('模型没有返回内容。');
  for (const candidate of jsonCandidates(trimmed)) {
    const parsed = tryParseJson(candidate);
    if (!isRecord(parsed) || typeof parsed.sql !== 'string') continue;
    const sql = normalizeSql(parsed.sql);
    if (!sql) continue;
    return {
      sql,
      explanation: typeof parsed.explanation === 'string' && parsed.explanation.trim()
        ? parsed.explanation.trim() : '模型生成的只读查询。',
      assumptions: normalizeAssumptions(parsed.assumptions),
    };
  }
  const sqlFence = trimmed.match(SQL_FENCE);
  if (sqlFence?.[1]) {
    const sql = normalizeSql(sqlFence[1]);
    if (sql) return { sql, explanation: trimmed.replace(sqlFence[0], '').trim() || '模型生成的只读查询。', assumptions: [] };
  }
  if (/^(select|with|values)\b/i.test(trimmed)) {
    return { sql: normalizeSql(trimmed), explanation: '模型生成的只读查询。', assumptions: [] };
  }
  throw invalidResponse('模型响应中没有可解析的 SQL。');
}

function jsonCandidates(text: string): string[] {
  const candidates = [text];
  const fenced = text.match(JSON_FENCE)?.[1];
  if (fenced) candidates.push(fenced);
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(text.slice(firstBrace, lastBrace + 1));
  return [...new Set(candidates.map((item) => item.trim()).filter(Boolean))];
}

function tryParseJson(text: string): unknown { try { return JSON.parse(text); } catch { return undefined; } }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function normalizeSql(value: string): string { return (value.match(SQL_FENCE)?.[1] ?? value).trim(); }
function normalizeAssumptions(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean) : [];
}
function invalidResponse(message: string): DatabaseCapabilityError { return new DatabaseCapabilityError('LLM_RESPONSE_INVALID', message, true); }
