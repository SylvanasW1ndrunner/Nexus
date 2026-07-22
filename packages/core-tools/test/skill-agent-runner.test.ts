import { describe, expect, it } from 'vitest';
import type { AgentRunResult } from '@dbagent/core-agent';
import { runSkillAgent, type SkillAgent, type SkillAgentRunOptionsForAgent } from '../src/index.js';

describe('Skill Agent runner', () => {
  it('runs with only tools allowed by both the runtime and selected Skill', async () => {
    const calls: SkillAgentRunOptionsForAgent[] = [];
    const agent: SkillAgent = {
      run(options) {
        calls.push(options);
        return Promise.resolve(doneResult());
      },
    };

    const output = await runSkillAgent(agent, {
      providerId: 'fake',
      model: 'fake-model',
      skillPlan: {
        skill: { name: 'lock_diagnosis', title: '锁等待诊断' },
        userInput: '检查阻塞链',
        allowedTools: ['diagnose_locks'],
        steps: ['采集锁信息', '解释阻塞关系'],
      },
      toolPolicy: {
        runtimeTools: [
          { name: 'diagnose_locks', dangerLevel: 'safe', readonly: true, source: 'database' },
          { name: 'execute_sql', dangerLevel: 'high', readonly: false, source: 'database' },
        ],
      },
    });

    expect(calls[0]?.allowedTools).toEqual(['diagnose_locks']);
    expect(output.toolPolicy.blockedBySkillToolNames).toEqual(['execute_sql']);
    expect(output.renderedUserMessage).toContain('当前 Skill：锁等待诊断');
  });
});

function doneResult(): AgentRunResult {
  return {
    status: 'done',
    session: {
      id: 'session',
      title: 'skill',
      mode: 'ask',
      strategy: 'react',
      messages: [],
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      aborted: false,
    },
    finalText: 'done',
    iterations: 1,
    toolExecutions: [],
  };
}
