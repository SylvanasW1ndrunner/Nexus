import { describe, expect, it } from 'vitest';
import { sanitizeAgentOutputText, sanitizeAgentOutputValue } from '../src/index.js';

describe('Agent output safety', () => {
  it('redacts sensitive result keys and raw personal identifiers', () => {
    const result = sanitizeAgentOutputValue({
      rows: [
        {
          customer_id: 1,
          customer_phone: '13800138000',
          support_phone: 13800138001,
          email: 'alice@example.com',
          phone_enc: 'ciphertext-value',
          phone_count: 12,
          email_domain: 'example.com',
          masked_phone: '138****8000',
        },
      ],
    });
    const serialized = JSON.stringify(result.value);

    expect(result.redacted).toBe(true);
    expect(result.blocked).toBe(false);
    expect(result.reasons).toEqual(expect.arrayContaining(['email', 'sensitive_key']));
    expect(serialized).toContain('redacted_phone');
    expect(serialized).toContain('redacted_email');
    expect(serialized).toContain('redacted_encrypted');
    expect(serialized).toContain('"phone_count":12');
    expect(serialized).toContain('"email_domain":"example.com"');
    expect(serialized).toContain('138****8000');
    expect(serialized).not.toContain('13800138000');
    expect(serialized).not.toContain('13800138001');
    expect(serialized).not.toContain('alice@example.com');
    expect(serialized).not.toContain('phone_enc');
    expect(serialized).not.toContain('ciphertext-value');
  });

  it('redacts final text that contains raw PII even if it came from the model', () => {
    const result = sanitizeAgentOutputText('客户 alice@example.com 的手机号是 13800138000。');

    expect(result.redacted).toBe(true);
    expect(result.reasons).toEqual(expect.arrayContaining(['email', 'phone']));
    expect(result.value).not.toContain('alice@example.com');
    expect(result.value).not.toContain('13800138000');
    expect(result.value).toContain('[REDACTED_PII]');
  });

  it('does not mistake numeric SQL identifiers, UUIDs, or hashes for phone numbers', () => {
    const value =
      'analytics.agent_refresh_probe_65652_1784890946584 result=cc3eecc6-6442-4a85-9c33-c5210e924956 hash=7842a8d5421c0dc69b36e9d390b8b495dc6c1d1dfc27a990c6fe359ccf61e54a';
    const result = sanitizeAgentOutputText(value);

    expect(result.redacted).toBe(false);
    expect(result.value).toBe(value);
  });

  it('preserves Date values so database timestamps serialize as ISO strings', () => {
    const timestamp = new Date('2026-07-24T12:34:56.000Z');
    const result = sanitizeAgentOutputValue({ received_at: timestamp });

    expect(result.redacted).toBe(false);
    expect(result.value.received_at).toBeInstanceOf(Date);
    expect(JSON.stringify(result.value)).toContain('2026-07-24T12:34:56.000Z');
  });

  it('can be disabled for trusted offline diagnostics', () => {
    const result = sanitizeAgentOutputValue({ email: 'alice@example.com' }, false);

    expect(result).toEqual({
      value: { email: 'alice@example.com' },
      redacted: false,
      blocked: false,
      reasons: [],
    });
  });

  it('marks matching output as blocked when the policy requires hard blocking', () => {
    const result = sanitizeAgentOutputValue(
      { rows: [{ email: 'alice@example.com', phone_enc: 'ciphertext-value' }] },
      { pii: 'block' },
    );

    expect(result.blocked).toBe(true);
    expect(result.redacted).toBe(true);
    expect(JSON.stringify(result.value)).not.toContain('alice@example.com');
    expect(JSON.stringify(result.value)).not.toContain('phone_enc');
  });
});
