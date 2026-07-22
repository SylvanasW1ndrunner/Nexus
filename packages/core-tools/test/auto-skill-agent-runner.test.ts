import { describe, expect, it } from 'vitest';
import { createDefaultBuiltinSkills } from '@dbagent/core-skills';
import type { AgentRunResult } from '@dbagent/core-agent';
import {
  runAutoSkillAgent,
  type SkillAgent,
  type SkillAgentRunOptionsForAgent,
} from '../src/index.js';

describe('Auto Skill Agent runner', () => {
  it('selects an eligible imported-style workflow from runtime tools', async () => {
    const calls: SkillAgentRunOptionsForAgent[] = [];
    const agent: SkillAgent = {
      run(options) {
        calls.push(options);
        return Promise.resolve(doneResult());
      },
    };

    const output = await runAutoSkillAgent(agent, {
      providerId: 'fake',
      model: 'fake-model',
      userInput: '检查数据库里有没有长事务',
      skills: createDefaultBuiltinSkills(),
      toolPolicy: {
        runtimeTools: [
          { name: 'diagnose_long_transactions', dangerLevel: 'safe', readonly: true, source: 'database' },
        ],
      },
    });

    expect(output.autoPlan.candidate.skill.name).toBe('long_transaction_diagnosis');
    expect(calls[0]?.allowedTools).toEqual(['diagnose_long_transactions']);
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
