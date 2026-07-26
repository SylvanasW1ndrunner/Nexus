import { describe, expect, it } from 'vitest';
import {
  CURRENT_CONTRACT_VERSION,
  ContractValidationError,
  assertContractEnvelope,
  assertNoSecretMaterial,
  assertPortableValue,
  createContractEnvelope,
  fromPortableValue,
  parsePublicJson,
  stringifyPublicJson,
  toPortableValue,
} from '../src/index.js';

describe('common public contracts', () => {
  it('creates and validates versioned envelopes without inventing domain fields', () => {
    const envelope = createContractEnvelope('schemanaut.resource.snapshot', {
      resourceId: 'resource-1',
    });

    expect(envelope).toEqual({
      contract: 'schemanaut.resource.snapshot',
      version: CURRENT_CONTRACT_VERSION,
      payload: { resourceId: 'resource-1' },
    });
    expect(() => assertContractEnvelope(envelope, 'schemanaut.resource.snapshot')).not.toThrow();
    expect(() =>
      assertContractEnvelope(
        { ...envelope, version: '2.0' },
        'schemanaut.resource.snapshot',
      ),
    ).toThrowError(ContractValidationError);
    expect(
      captureContractFailure(() =>
        assertContractEnvelope({ contract: 'x', version: '1.0' }),
      ).issues[0],
    ).toMatchObject({ path: '$.payload' });
  });

  it('round-trips JSON values and explicitly tagged Node values', () => {
    const input = {
      text: '订单',
      amount: 12.5,
      count: 9_007_199_254_740_993n,
      at: new Date('2026-07-23T00:00:00.000Z'),
      binary: Uint8Array.from([0, 1, 254, 255]),
      nested: [true, null, { value: 'ok' }],
    };

    const portable = toPortableValue(input);
    expect(portable).toMatchObject({
      count: { $schemanautType: 'bigint', value: '9007199254740993' },
      at: { $schemanautType: 'datetime', value: '2026-07-23T00:00:00.000Z' },
      binary: { $schemanautType: 'binary', encoding: 'base64', value: 'AAH+/w==' },
    });
    const decoded = fromPortableValue(portable) as typeof input;
    expect(decoded.count).toBe(input.count);
    expect(decoded.at).toEqual(input.at);
    expect([...decoded.binary]).toEqual([...input.binary]);
    expect(parsePublicJson(stringifyPublicJson(input))).toEqual(decoded);
  });

  it('rejects every non-portable value with an exact safe path', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    class Unsupported {
      value = 1;
    }
    const invalidValues: Array<{ value: unknown; path: string }> = [
      { value: { item: undefined }, path: '$.item' },
      { value: { item: Number.NaN }, path: '$.item' },
      { value: { item: Number.POSITIVE_INFINITY }, path: '$.item' },
      { value: { item: () => undefined }, path: '$.item' },
      { value: { item: Symbol('x') }, path: '$.item' },
      { value: cyclic, path: '$.self' },
      { value: { item: new Unsupported() }, path: '$.item' },
      { value: { item: new Date('invalid') }, path: '$.item' },
    ];

    for (const invalid of invalidValues) {
      expect(
        captureContractFailure(() => assertPortableValue(invalid.value))
          .issues[0],
      ).toMatchObject({ path: invalid.path });
    }
  });

  it('detects nested credentials without returning the credential value', () => {
    const credential = 'postgres://admin:do-not-return@localhost/app';
    let failure: ContractValidationError | undefined;
    try {
      assertNoSecretMaterial({
        safe: true,
        nested: [{ Api_Key: 'key-do-not-return-1234567890' }, credential],
      });
    } catch (error) {
      failure = error as ContractValidationError;
    }

    expect(failure).toBeInstanceOf(ContractValidationError);
    expect(failure?.issues[0]?.path).toBe('$.nested[0].Api_Key');
    expect(JSON.stringify(failure)).not.toContain('do-not-return');
    expect(() =>
      assertNoSecretMaterial({ credentialReference: { reference: 'vault://database/main' } }),
    ).not.toThrow();
  });
});

function captureContractFailure(operation: () => void): ContractValidationError {
  try {
    operation();
  } catch (error) {
    if (error instanceof ContractValidationError) return error;
    throw error;
  }
  throw new Error('Expected ContractValidationError');
}
