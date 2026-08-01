import { describe, expect, it } from 'vitest';
import { CompletionController, type CompletionEvidenceProvider } from '../src/index.js';

describe('CompletionController', () => {
  it('uses the latest generic deliverable attempt instead of an earlier successful result', () => {
    const verification = new CompletionController().verify({
      toolExecutions: [
        execution('artifact-1', 'workspace_write', 'success', {
          completionRole: 'deliverable',
          completionEvidence: { kind: 'artifact', deliveryReady: true },
        }),
        execution('process-2', 'process_exec', 'failed', {
          completionRole: 'deliverable',
        }),
      ],
      proposedFinalText: 'Everything completed successfully.',
    });

    expect(verification).toMatchObject({
      verified: false,
      deliveryReady: false,
      missing: ['the latest deliverable action did not succeed'],
    });
  });

  it('accepts an explicit terminal failure delivery without pretending the action succeeded', () => {
    const verification = new CompletionController().verify({
      toolExecutions: [
        execution('process-1', 'process_exec', 'failed', {
          completionRole: 'deliverable',
        }),
      ],
      proposedFinalText: '进程已经超时并被取消；需要提高超时配置后再运行。',
    });

    expect(verification).toMatchObject({
      verified: true,
      deliveryReady: true,
      finalResponseReady: true,
    });
  });

  it('does not treat a successfully polled failed process as a successful task', () => {
    const controller = new CompletionController();
    const toolExecutions = [
      execution('process-poll-1', 'process_poll', 'success', {
        completionRole: 'deliverable',
        completionEvidence: {
          kind: 'process',
          deliveryReady: true,
          outcome: 'failed',
        },
      }),
    ];

    expect(
      controller.verify({ toolExecutions, proposedFinalText: 'The task completed.' }),
    ).toMatchObject({
      verified: false,
      missing: ['an explicit delivery of the terminal failure or cancellation'],
    });
    expect(
      controller.verify({
        toolExecutions,
        proposedFinalText: '进程退出码为 1，任务执行失败；请检查命令输出。',
      }),
    ).toMatchObject({ verified: true, deliveryReady: true });
  });

  it('lets capability packages contribute evidence without hard-coding their domain in the controller', () => {
    const provider: CompletionEvidenceProvider = {
      id: 'governance-mcp',
      evaluate(input) {
        const matched = input.toolExecutions.some(
          (item) =>
            item.toolName === 'mcp__governance__apply_policy' && item.status === 'success',
        );
        return matched
          ? {
              evidence: [{ kind: 'mcp', deliveryReady: true }],
              deliveryReady: true,
            }
          : undefined;
      },
    };
    const controller = new CompletionController([provider]);

    expect(
      controller.verify({
        toolExecutions: [execution('mcp-1', 'mcp__governance__apply_policy', 'success')],
        proposedFinalText: 'The governance policy was applied.',
      }),
    ).toMatchObject({
      verified: true,
      deliveryReady: true,
      evidenceKinds: ['mcp'],
    });
  });
});

function execution(
  id: string,
  toolName: string,
  status: 'success' | 'denied' | 'failed',
  extra: Record<string, unknown> = {},
) {
  return {
    toolCallId: id,
    toolName,
    status,
    durationMs: 1,
    resultPreview: status,
    ...extra,
  } as never;
}
