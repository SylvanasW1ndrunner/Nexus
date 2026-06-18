import { describe, expect, it } from 'vitest';
import { buildDiagnosticReport, redactDiagnosticText } from '../src/diagnostic-report.js';

describe('diagnostic report', () => {
  it('builds a redacted report with app metadata, config, recent logs and crash snapshots', () => {
    const report = buildDiagnosticReport({
      generatedAt: '2026-06-18T10:00:00.000Z',
      app: {
        name: 'DBAgent',
        version: '0.1.0',
        commit: 'abcdef1',
      },
      runtime: {
        platform: 'win32',
        arch: 'x64',
        nodeVersion: '24.14.0',
        electronVersion: '33.0.0',
      },
      configs: [
        {
          path: 'settings.json',
          content: JSON.stringify({
            theme: 'dark',
            apiKey: ['sk', 'testsecretsecretsecret'].join('-'),
            connection: { host: 'db.internal', password: 'postgres' },
          }),
        },
      ],
      logs: [
        {
          path: 'C:\\Users\\demo\\.dbagent\\logs\\app-2026-06-18.log',
          createdAt: '2026-06-18T09:00:00.000Z',
          content:
            'authorization=Bearer abcdefghijklmnopqrstuvwxyz\nsql=select * from customers where phone = 13800138000;\nconnection timeout',
        },
      ],
      crashSnapshots: [
        {
          path: '../crash-2026-06-18.dump',
          createdAt: '2026-06-18T09:30:00.000Z',
          content: 'uncaught error password=super-secret',
        },
      ],
    });

    const combined = report.files.map((file) => file.content).join('\n');

    expect(report.files.map((file) => file.path)).toEqual([
      'manifest.json',
      'configs/settings.json',
      'logs/Users/demo/.dbagent/logs/app-2026-06-18.log',
      'crash/crash-2026-06-18.dump',
    ]);
    expect(JSON.parse(report.files[0]!.content)).toMatchObject({
      app: { name: 'DBAgent', version: '0.1.0' },
      runtime: { platform: 'win32', arch: 'x64' },
    });
    expect(combined).toContain('Bearer [REDACTED_TOKEN]');
    expect(combined).toContain('[REDACTED_SECRET]');
    expect(combined).toContain('[REDACTED_SQL]');
    expect(combined).toContain('connection timeout');
    expect(combined).not.toContain(['sk', 'testsecretsecretsecret'].join('-'));
    expect(combined).not.toContain('postgres');
    expect(combined).not.toContain('13800138000');
    expect(report.summary).toMatchObject({
      configCount: 1,
      logCount: 1,
      crashSnapshotCount: 1,
      omittedCount: 0,
    });
    expect(report.summary.redactionCount).toBeGreaterThanOrEqual(5);
  });

  it('omits logs outside the retention window and keeps entries with unknown dates', () => {
    const report = buildDiagnosticReport({
      generatedAt: '2026-06-18T10:00:00.000Z',
      app: { name: 'DBAgent', version: '0.1.0' },
      runtime: { platform: 'linux', arch: 'x64' },
      logs: [
        { path: 'old.log', createdAt: '2026-06-01T10:00:00.000Z', content: 'old failure' },
        { path: 'unknown-date.log', content: 'still useful' },
      ],
      options: { retentionDays: 7 },
    });

    expect(report.files.map((file) => file.path)).toEqual(['manifest.json', 'logs/unknown-date.log']);
    expect(report.summary.omittedCount).toBe(1);
  });

  it('keeps the tail of oversized entries so recent errors remain visible', () => {
    const report = buildDiagnosticReport({
      generatedAt: '2026-06-18T10:00:00.000Z',
      app: { name: 'DBAgent', version: '0.1.0' },
      runtime: { platform: 'darwin', arch: 'arm64' },
      logs: [{ path: 'large.log', content: `${'x'.repeat(200)}recent failure` }],
      options: { maxEntryBytes: 32 },
    });

    const log = report.files.find((file) => file.path === 'logs/large.log.tail');

    expect(log?.content).toContain('[TRUNCATED_TO_LAST_32_BYTES]');
    expect(log?.content).toContain('recent failure');
  });

  it('redacts SQL-like lines and secret fields in free-form text', () => {
    const redacted = redactDiagnosticText(
      'password=hunter2\nquery="delete from orders where user_id=1"\nselect * from payments where card_no=1234;\n',
    );

    expect(redacted.text).toContain('password=[REDACTED_SECRET]');
    expect(redacted.text).toContain('query="[REDACTED_SQL]"');
    expect(redacted.text).toContain('[REDACTED_SQL];');
    expect(redacted.text).not.toContain('hunter2');
    expect(redacted.text).not.toContain('payments');
    expect(redacted.redactionCount).toBe(3);
  });
});
