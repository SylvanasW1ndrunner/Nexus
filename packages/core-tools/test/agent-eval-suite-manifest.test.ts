import { describe, expect, it } from 'vitest';
import { parseAgentEvalSuiteManifest, parseAgentEvalSuiteManifestJson } from '../src/index.js';

describe('Agent eval suite manifest parser', () => {
  it('parses only evaluator-owned expectations and neutral Run configuration', () => {
    const suite = parseAgentEvalSuiteManifest({
      version: 1,
      suite: {
        suiteId: 'database-eval', suiteName: 'Database evaluation', environment: 'postgres',
        notes: ['No provider, credential, or model selection is accepted here.'],
        cases: [{
          id: 'DATABASE-001', userTask: 'Find GMV by channel.', expectedStatus: 'completed',
          requiredToolCalls: ['search_schema', 'query_database'],
          requiredToolStatuses: [{ toolName: 'query_database', status: 'success' }],
          toolExpectations: [{
            toolName: 'query_database', status: 'success', minCalls: 1, maxCalls: 1,
            argumentIncludes: ['analytics.traffic_sessions'], resultIncludes: ['paid_search'],
          }],
          finalTextIncludes: ['GMV'], finalTextExcludes: ['credential'], minTurns: 1, maxTurns: 5,
          configuration: {
            mode: 'default', allowedTools: ['search_schema', 'query_database'], maxTurns: 5,
          },
        }],
      },
    });

    expect(suite).toMatchObject({
      suiteId: 'database-eval', environment: 'postgres',
      cases: [{
        expectation: {
          id: 'DATABASE-001', expectedStatus: 'completed', minTurns: 1, maxTurns: 5,
          requiredToolStatuses: [{ toolName: 'query_database', status: 'success' }],
        },
        configuration: { mode: 'default', maxTurns: 5 },
      }],
    });
  });

  it('parses JSON text and rejects invalid JSON with a targeted error', () => {
    const suite = parseAgentEvalSuiteManifestJson(JSON.stringify({
      version: 1,
      suite: { suiteId: 'json-suite', suiteName: 'JSON Suite', cases: [{
        id: 'JSON-001', userTask: 'Run one case.',
      }] },
    }));
    expect(suite.cases[0]?.expectation).toMatchObject({ id: 'JSON-001', userTask: 'Run one case.' });
    expect(() => parseAgentEvalSuiteManifestJson('{')).toThrow(
      /Agent eval suite manifest JSON is invalid:/,
    );
  });

  it('rejects duplicate ids, invalid ranges, and old Agent execution controls', () => {
    expect(() => parseAgentEvalSuiteManifest({
      version: 1,
      suite: { suiteId: 'duplicate', suiteName: 'Duplicate', cases: [
        { id: 'CASE-001', userTask: 'First.' }, { id: 'CASE-001', userTask: 'Second.' },
      ] },
    })).toThrow('Duplicate Agent eval suite case id: CASE-001.');

    expect(() => parseAgentEvalSuiteManifest({
      version: 1,
      suite: { suiteId: 'range', suiteName: 'Range', cases: [{
        id: 'CASE-001', userTask: 'Task.', minTurns: 3, maxTurns: 2,
      }] },
    })).toThrow('minTurns cannot be greater than maxTurns');

    expect(() => parseAgentEvalSuiteManifest({
      version: 1,
      suite: { suiteId: 'old', suiteName: 'Old', cases: [{
        id: 'CASE-001', userTask: 'Task.', configuration: { model: 'other-model' },
      }] },
    })).toThrow('configuration has unsupported key: model.');

    expect(() => parseAgentEvalSuiteManifest({
      version: 1,
      suite: { suiteId: 'old-case', suiteName: 'Old case', cases: [{
        id: 'CASE-001', userTask: 'Task.', maxIterations: 3,
      }] },
    })).toThrow('has unsupported key: maxIterations.');
  });

  it('rejects unknown fields, unsupported statuses, empty suites, and unsupported versions', () => {
    expect(() => parseAgentEvalSuiteManifest({
      version: 1,
      suite: { suiteId: 'bad-status', suiteName: 'Bad status', cases: [{
        id: 'CASE-001', userTask: 'Task.', expectedStatus: 'done',
      }] },
    })).toThrow('expectedStatus is not supported: done.');

    expect(() => parseAgentEvalSuiteManifest({
      version: 1,
      suite: { suiteId: 'empty', suiteName: 'Empty', cases: [] },
    })).toThrow('Agent eval suite manifest suite must contain at least one case.');

    expect(() => parseAgentEvalSuiteManifest({
      version: 2,
      suite: { suiteId: 'future', suiteName: 'Future', cases: [] },
    })).toThrow('Agent eval suite manifest version is not supported: 2.');

    expect(() => parseAgentEvalSuiteManifest({
      version: 1, extra: true,
      suite: { suiteId: 'unknown', suiteName: 'Unknown', cases: [{ id: 'ONE', userTask: 'One.' }] },
    })).toThrow('Agent eval suite manifest has unsupported key: extra.');
  });
});
