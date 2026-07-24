import { describe, expect, it } from 'vitest';
import { createDefaultBuiltinSkills } from '@dbagent/core-skills';
import type { AgentRunResult } from '@dbagent/core-agent';
import {
  runAutoSkillAgent,
  type SkillAgent,
  type SkillAgentRunOptionsForAgent,
} from '../src/index.js';

const tools = [
  'resource_list',
  'resource_get',
  'knowledge_search',
  'sql_execute',
  'sql_explain',
  'result_read',
];

describe('Auto Skill Agent runner', () => {
  it('selects a generic query workflow and applies its iteration limit', async () => {
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
      userInput: '统计过去七天的订单数和支付金额趋势',
      skills: createDefaultBuiltinSkills(),
      toolPolicy: {
        runtimeTools: tools.map((name) => ({
          name,
          dangerLevel: name === 'sql_execute' ? ('high' as const) : ('safe' as const),
          readonly: name !== 'sql_execute',
          source: name.startsWith('resource') || name === 'knowledge_search'
            ? ('schema-rag' as const)
            : ('database' as const),
        })),
      },
      mode: 'read',
    });

    expect(output.autoPlan.candidate.skill.name).toBe('query-and-answer');
    expect(calls[0]?.allowedTools).toEqual(tools);
    expect(calls[0]).toMatchObject({
      mode: 'read',
      maxIterations: 12,
    });
  });
});

function doneResult(): AgentRunResult {
  return {
    status: 'done',
    session: {
      id: 'session',
      title: 'skill',
      mode: 'read',
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
