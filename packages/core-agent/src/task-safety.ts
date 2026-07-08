import type { AgentTaskSafetyPolicy } from './types.js';

export type AgentTaskSafetyDecision = {
  blocked: boolean;
  reason?: 'pii_exfiltration';
  finalText?: string;
  matchedTerms: string[];
};

const DEFAULT_BLOCKED_TEXT =
  '该请求涉及直接提取、解密或导出敏感个人信息，我不能执行。可以改为做脱敏后的统计、分布分析或权限合规检查。';

const SENSITIVE_TERMS = [
  'phone',
  'mobile',
  '手机号',
  '手机号码',
  '电话',
  'email',
  '邮箱',
  '身份证',
  'id_card',
  'identity',
  'password',
  '密码',
  'api key',
  'apikey',
  'token',
  'secret',
  'decrypt_phone',
  'phone_enc',
  '解密手机号',
];

const EXTRACTION_VERBS = [
  'show',
  'list',
  'dump',
  'export',
  'extract',
  'decrypt',
  'plaintext',
  'reveal',
  'print',
  '查出来',
  '列出',
  '导出',
  '提取',
  '解密',
  '明文',
  '显示',
  '打印',
  '查看每个',
  '全部',
];

const AGGREGATE_TERMS = [
  'count',
  '统计',
  '汇总',
  '分布',
  '占比',
  '趋势',
  '脱敏',
  'mask',
  'masked',
  'anonymized',
  '匿名',
];

export function assessAgentTaskSafety(
  userMessage: string,
  policy: AgentTaskSafetyPolicy | undefined,
): AgentTaskSafetyDecision {
  if (policy === false || policy?.pii === 'allow') return allow();

  const text = normalize(userMessage);
  const sensitiveTerms = [...SENSITIVE_TERMS, ...(policy?.extraSensitiveTerms ?? [])];
  const extractionVerbs = [...EXTRACTION_VERBS, ...(policy?.extraExtractionVerbs ?? [])];
  const matchedTerms = sensitiveTerms.filter((term) => text.includes(normalize(term)));
  if (matchedTerms.length === 0) return allow();

  const asksForRawSensitiveData = extractionVerbs.some((verb) => text.includes(normalize(verb)));
  if (!asksForRawSensitiveData) return allow();

  const appearsAggregateOnly = AGGREGATE_TERMS.some((term) => text.includes(normalize(term)));
  if (
    appearsAggregateOnly &&
    !text.includes('明文') &&
    !text.includes('解密') &&
    !text.includes('decrypt') &&
    !text.includes('plaintext')
  ) {
    return allow();
  }

  return {
    blocked: true,
    reason: 'pii_exfiltration',
    finalText: policy?.blockedFinalText ?? DEFAULT_BLOCKED_TEXT,
    matchedTerms,
  };
}

function allow(): AgentTaskSafetyDecision {
  return { blocked: false, matchedTerms: [] };
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase();
}
