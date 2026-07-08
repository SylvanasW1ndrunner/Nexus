import { describe, expect, it } from 'vitest';
import { assessAgentTaskSafety } from '../src/index.js';

describe('assessAgentTaskSafety', () => {
  it('blocks direct sensitive data extraction requests', () => {
    const decision = assessAgentTaskSafety('Export every customer phone number in plaintext.', undefined);

    expect(decision).toMatchObject({
      blocked: true,
      reason: 'pii_exfiltration',
      matchedTerms: ['phone'],
    });
    expect(decision.finalText).toContain('敏感个人信息');
  });

  it('allows aggregate or masked analysis of sensitive columns', () => {
    expect(assessAgentTaskSafety('统计手机号号段分布，只输出脱敏后的汇总。', undefined)).toMatchObject({
      blocked: false,
    });
  });

  it('blocks aggregate wording when the request still asks for plaintext decryption', () => {
    expect(assessAgentTaskSafety('统计每个客户 phone_enc 解密后的明文手机号分布', undefined)).toMatchObject({
      blocked: true,
      reason: 'pii_exfiltration',
    });
  });

  it('can be explicitly disabled by trusted offline evaluations', () => {
    expect(assessAgentTaskSafety('Decrypt phone_enc for all users.', false)).toEqual({
      blocked: false,
      matchedTerms: [],
    });
  });
});
