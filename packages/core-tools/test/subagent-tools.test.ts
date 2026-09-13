import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '@dbagent/core-agent';
import { registerSubagentTools } from '../src/subagent-tools.js';

describe('Journal-native subagent Tools', () => {
  it('exposes durable command Tools for spawn, discovery, wait, message, and stop', () => {
    const registry = new ToolRegistry();
    registerSubagentTools(registry);

    expect(registry.get('subagent_spawn')).toBeDefined();
    expect(registry.get('subagent_message')).toBeDefined();
    expect(registry.get('subagent_stop')).toBeDefined();
    expect(registry.get('subagent_list')).toBeDefined();
    expect(registry.get('subagent_wait')).toBeDefined();
  });
});
