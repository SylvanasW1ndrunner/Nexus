import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  McpHealthManager,
  McpToolAbortedError,
  McpToolTimeoutError,
  McpUnavailableError,
  invokeMcpToolWithTimeout,
} from '../src/mcp-health.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('McpHealthManager', () => {
  it('tracks startup and healthy states for available MCP servers', () => {
    const health = new McpHealthManager({ now: () => '2026-06-18T10:00:00.000Z' });

    expect(health.markStarting('filesystem')).toMatchObject({
      serverId: 'filesystem',
      status: 'starting',
      healthy: false,
      lastStartedAt: '2026-06-18T10:00:00.000Z',
    });
    expect(health.markHealthy('filesystem')).toMatchObject({
      status: 'healthy',
      healthy: true,
      lastHealthyAt: '2026-06-18T10:00:00.000Z',
    });
    expect(() => health.assertAvailable('filesystem')).not.toThrow();
  });

  it('rejects tool calls for unavailable servers without affecting other servers', () => {
    const health = new McpHealthManager();

    health.markHealthy('time');
    health.markUnhealthy('filesystem', 'spawn ENOENT');

    expect(() => health.assertAvailable('filesystem')).toThrow(McpUnavailableError);
    expect(() => health.assertAvailable('time')).not.toThrow();
  });

  it('schedules exponential restarts and stops after the restart cap', () => {
    let now = '2026-06-18T10:00:00.000Z';
    const health = new McpHealthManager({
      maxRestarts: 2,
      baseRestartDelayMs: 1_000,
      maxRestartDelayMs: 5_000,
      now: () => now,
    });

    expect(health.recordExit('smithery', { code: 1 })).toMatchObject({
      status: 'restarting',
      restartCount: 1,
      nextRestartAt: '2026-06-18T10:00:01.000Z',
    });

    now = '2026-06-18T10:00:01.000Z';
    expect(health.recordExit('smithery', { signal: 'SIGTERM' })).toMatchObject({
      status: 'restarting',
      restartCount: 2,
      nextRestartAt: '2026-06-18T10:00:03.000Z',
    });

    now = '2026-06-18T10:00:03.000Z';
    const finalExit = health.recordExit('smithery', { code: 1 });
    expect(finalExit).toMatchObject({
      status: 'unhealthy',
      restartCount: 3,
      lastError: 'Process exited; restart limit reached.',
    });
    expect(finalExit.nextRestartAt).toBeUndefined();
  });

  it('keeps intentionally disabled servers disabled when their process exits', () => {
    const health = new McpHealthManager({ maxRestarts: 3, now: () => '2026-06-18T10:00:00.000Z' });

    health.disable('github', 'user disabled this MCP server');
    const state = health.recordExit('github', { code: 0 });

    expect(state).toMatchObject({
      status: 'disabled',
      healthy: false,
      restartCount: 0,
      lastError: 'user disabled this MCP server',
    });
    expect(state.nextRestartAt).toBeUndefined();
  });

  it('restarts memory-leaking servers and records a single warning', () => {
    const health = new McpHealthManager({
      maxRestarts: 1,
      memoryLimitBytes: 100,
      now: () => '2026-06-18T10:00:00.000Z',
    });

    const first = health.recordResourceSample('memory', { rssBytes: 101 });
    const second = health.recordResourceSample('memory', { rssBytes: 101 });

    expect(first).toMatchObject({
      status: 'restarting',
      restartCount: 1,
      nextRestartAt: '2026-06-18T10:00:01.000Z',
    });
    expect(second).toMatchObject({
      status: 'unhealthy',
      restartCount: 2,
      lastError: 'Memory limit exceeded; restart limit reached.',
    });
    expect(second.nextRestartAt).toBeUndefined();
    expect(second.warnings).toEqual(['Memory limit exceeded: 101 bytes.']);
  });

  it('warns for sustained CPU pressure without marking the server unavailable', () => {
    let now = '2026-06-18T10:00:00.000Z';
    const health = new McpHealthManager({
      cpuLimitPercent: 80,
      cpuSustainMs: 1_000,
      now: () => now,
    });

    health.markHealthy('busy');
    health.recordResourceSample('busy', { cpuPercent: 90 });
    now = '2026-06-18T10:00:01.500Z';
    const state = health.recordResourceSample('busy', { cpuPercent: 90 });

    expect(state.status).toBe('healthy');
    expect(state.healthy).toBe(true);
    expect(state.warnings).toEqual(['CPU stayed above 80% for at least 1000ms.']);
  });
});

describe('invokeMcpToolWithTimeout', () => {
  it('returns a normal tool result and passes an active abort signal', async () => {
    await expect(
      invokeMcpToolWithTimeout((signal) => {
        expect(signal.aborted).toBe(false);
        return { ok: true };
      }),
    ).resolves.toEqual({ ok: true });
  });

  it('times out a hanging MCP tool even when the tool ignores AbortSignal', async () => {
    vi.useFakeTimers();

    const call = invokeMcpToolWithTimeout(
      () =>
        new Promise(() => {
          // Simulates an MCP server that stops responding and ignores cancellation.
        }),
      { timeoutMs: 50 },
    );

    const expectation = expect(call).rejects.toBeInstanceOf(McpToolTimeoutError);
    await vi.advanceTimersByTimeAsync(50);
    await expectation;

    vi.useRealTimers();
  });

  it('aborts the inner signal when the timeout fires', async () => {
    vi.useFakeTimers();
    let innerSignal: AbortSignal | undefined;

    const call = invokeMcpToolWithTimeout(
      (signal) => {
        innerSignal = signal;
        return new Promise(() => undefined);
      },
      { timeoutMs: 25 },
    );

    const expectation = expect(call).rejects.toBeInstanceOf(McpToolTimeoutError);
    await vi.advanceTimersByTimeAsync(25);
    await expectation;
    expect(innerSignal?.aborted).toBe(true);

    vi.useRealTimers();
  });

  it('propagates user cancellation separately from timeout', async () => {
    const controller = new AbortController();
    const call = invokeMcpToolWithTimeout(
      () =>
        new Promise(() => {
          // The caller cancellation path must complete even if the MCP server hangs.
        }),
      { signal: controller.signal, timeoutMs: 1_000 },
    );

    controller.abort();

    await expect(call).rejects.toBeInstanceOf(McpToolAbortedError);
  });
});
