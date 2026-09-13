import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CURRENT_CONTRACT_VERSION,
  assertConnectionProfile,
  assertContractEnvelope,
  assertDatabaseAccessError,
  assertQuerySubmission,
  assertResourceRegistrySnapshot,
  stringifyPublicJson,
  type ContractEnvelope,
} from '../src/index.js';

const fixtures = [
  {
    name: 'resource-snapshot',
    contract: 'schemanaut.resource-registry.snapshot',
    validate: assertResourceRegistrySnapshot,
  },
  {
    name: 'connection-profile',
    contract: 'schemanaut.database.connection-profile',
    validate: assertConnectionProfile,
  },
  {
    name: 'query-submission',
    contract: 'schemanaut.database.query-submission',
    validate: assertQuerySubmission,
  },
  {
    name: 'database-error',
    contract: 'schemanaut.database.error',
    validate: assertDatabaseAccessError,
  },
] as const;

describe('public contract v1 compatibility fixtures', () => {
  for (const fixture of fixtures) {
    it(`reads and preserves ${fixture.name}`, () => {
      const path = fileURLToPath(
        new URL(`./fixtures/v1/${fixture.name}.json`, import.meta.url),
      );
      const originalText = readFileSync(path, 'utf8');
      const envelope = JSON.parse(originalText) as ContractEnvelope<unknown>;

      assertContractEnvelope(envelope, fixture.contract);
      fixture.validate(envelope.payload);
      expect(envelope.version).toBe(CURRENT_CONTRACT_VERSION);
      expect(JSON.parse(stringifyPublicJson(envelope, 2))).toEqual(
        JSON.parse(originalText),
      );
    });
  }
});
