import type {
  AgentOutputRedactionReason,
  AgentOutputSafetyPolicy,
} from './types.js';
import { redactPersistedAgentString } from './redaction.js';

export type AgentOutputSafetyResult<T> = {
  value: T;
  redacted: boolean;
  reasons: AgentOutputRedactionReason[];
};

const DEFAULT_REPLACEMENT = '[REDACTED_PII]';
const REDACTED_FIELD_PREFIX = 'redacted';

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_PATTERN = /(?<!\d)(?:\+?\d[\d()\-\s]{8,}\d)(?!\d)/g;
const ID_CARD_PATTERN = /(?<!\d)\d{17}[\dXx](?!\d)/g;
const SECRET_PATTERN = /\b(?:sk|pk|ak)-[A-Za-z0-9_-]{8,}\b/g;
const CIPHERTEXT_PATTERN = /\bciphertext-[A-Za-z0-9_-]{4,}\b/gi;
const SENSITIVE_LABEL_VALUE_PATTERN =
  /["']?\b(phone_enc|[a-z0-9_]*(?:_enc|_encrypted|_cipher)|email|phone|mobile|id_card|identity|password|token|secret|api_key|apikey)\b["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;，。}]+)/gi;
const SENSITIVE_FIELD_NAME_PATTERN = /\b(phone_enc|[a-z0-9_]*(?:_enc|_encrypted|_cipher))\b/gi;

const SENSITIVE_KEY_PATTERN =
  /(?:^|[_-])(?:phone|mobile|email|mail|id[_-]?card|identity|ssn|password|passwd|pwd|token|secret|api[_-]?key|apikey)(?:$|[_-])|(?:^|[_-])(?:.*_enc|.*_encrypted|.*_cipher)(?:$|[_-])|phone_enc/i;

const AGGREGATE_KEY_PATTERN =
  /(?:count|total|sum|avg|average|rate|ratio|percent|pct|share|distribution|bucket|masked|mask|prefix|suffix|domain)$/i;

export function sanitizeAgentOutputValue<T>(
  value: T,
  policy?: AgentOutputSafetyPolicy,
): AgentOutputSafetyResult<T> {
  if (policy === false || policy?.pii === 'allow') {
    return { value, redacted: false, reasons: [] };
  }

  const reasons = new Set<AgentOutputRedactionReason>();
  const replacement = policy?.replacementText ?? DEFAULT_REPLACEMENT;
  const sanitized = sanitizeValue(value, {
    reasons,
    replacement,
    extraSensitiveKeys: policy?.extraSensitiveKeys ?? [],
  });

  return {
    value: sanitized as T,
    redacted: reasons.size > 0,
    reasons: [...reasons].sort(),
  };
}

export function sanitizeAgentOutputText(
  value: string,
  policy?: AgentOutputSafetyPolicy,
): AgentOutputSafetyResult<string> {
  if (policy === false || policy?.pii === 'allow') {
    return { value, redacted: false, reasons: [] };
  }

  const reasons = new Set<AgentOutputRedactionReason>();
  const replacement = policy?.replacementText ?? DEFAULT_REPLACEMENT;
  const sanitized = sanitizeString(value, reasons, replacement);
  return {
    value: sanitized,
    redacted: reasons.size > 0,
    reasons: [...reasons].sort(),
  };
}

function sanitizeValue(
  value: unknown,
  options: {
    reasons: Set<AgentOutputRedactionReason>;
    replacement: string;
    extraSensitiveKeys: string[];
    parentSensitive?: boolean;
  },
): unknown {
  if (typeof value === 'string') {
    if (options.parentSensitive && !looksMasked(value)) {
      options.reasons.add('sensitive_key');
      return options.replacement;
    }
    return sanitizeString(value, options.reasons, options.replacement);
  }

  if (options.parentSensitive) {
    options.reasons.add('sensitive_key');
    return options.replacement;
  }

  if (value instanceof Uint8Array) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, options));
  }

  if (!value || typeof value !== 'object') return value;

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const sensitiveKey = isSensitiveKey(key, options.extraSensitiveKeys);
    const aggregateKey = AGGREGATE_KEY_PATTERN.test(key);
    const outputKey = sensitiveKey && !aggregateKey ? redactedKeyName(key) : key;
    if (sensitiveKey && !aggregateKey) addSensitiveKeyReasons(key, options.reasons);
    output[outputKey] = sanitizeValue(child, {
      ...options,
      parentSensitive: sensitiveKey && !aggregateKey,
    });
  }
  return output;
}

function sanitizeString(
  value: string,
  reasons: Set<AgentOutputRedactionReason>,
  replacement: string,
): string {
  let text = redactPersistedAgentString(value);
  if (text !== value) reasons.add('secret');

  text = text.replace(SENSITIVE_LABEL_VALUE_PATTERN, (match, key: string) => {
    addSensitiveKeyReasons(key, reasons);
    return `${redactedKeyName(key)}=${replacement}`;
  });
  text = text.replace(SENSITIVE_FIELD_NAME_PATTERN, (match: string) => {
    addSensitiveKeyReasons(match, reasons);
    return redactedKeyName(match);
  });
  text = text.replace(EMAIL_PATTERN, () => {
    reasons.add('email');
    return replacement;
  });
  text = text.replace(ID_CARD_PATTERN, () => {
    reasons.add('id_card');
    return replacement;
  });
  text = text.replace(SECRET_PATTERN, () => {
    reasons.add('secret');
    return replacement;
  });
  text = text.replace(CIPHERTEXT_PATTERN, () => {
    reasons.add('sensitive_key');
    return replacement;
  });
  text = text.replace(PHONE_PATTERN, (match) => {
    if (match.replace(/\D/g, '').length < 10) return match;
    if (looksMasked(match)) return match;
    reasons.add('phone');
    return replacement;
  });
  return text;
}

function isSensitiveKey(key: string, extraSensitiveKeys: string[]): boolean {
  const normalized = key.trim().toLocaleLowerCase();
  return (
    SENSITIVE_KEY_PATTERN.test(normalized) ||
    extraSensitiveKeys.some((term) => normalized.includes(term.trim().toLocaleLowerCase()))
  );
}

function addSensitiveKeyReasons(key: string, reasons: Set<AgentOutputRedactionReason>): void {
  reasons.add('sensitive_key');
  if (/email|mail/i.test(key)) reasons.add('email');
  if (/phone|mobile/i.test(key)) reasons.add('phone');
  if (/id[_-]?card|identity|ssn/i.test(key)) reasons.add('id_card');
  if (/password|passwd|pwd|token|secret|api[_-]?key|apikey/i.test(key)) reasons.add('secret');
}

function redactedKeyName(key: string): string {
  if (/_enc|_encrypted|_cipher|phone_enc/i.test(key)) return `${REDACTED_FIELD_PREFIX}_encrypted`;
  if (/email|mail/i.test(key)) return `${REDACTED_FIELD_PREFIX}_email`;
  if (/phone|mobile/i.test(key)) return `${REDACTED_FIELD_PREFIX}_phone`;
  if (/id[_-]?card|identity|ssn/i.test(key)) return `${REDACTED_FIELD_PREFIX}_id`;
  if (/password|passwd|pwd|token|secret|api[_-]?key|apikey/i.test(key)) return `${REDACTED_FIELD_PREFIX}_secret`;
  return `${REDACTED_FIELD_PREFIX}_sensitive`;
}

function looksMasked(value: string): boolean {
  return /[*•xX]{2,}/.test(value);
}
