import { describe, expect, it } from 'vitest';
import { decideAutomaticPermission } from '../src/index.js';

describe('decideAutomaticPermission', () => {
  it('allows safe tools in every mode', () => {
    expect(decideAutomaticPermission('readonly', { dangerLevel: 'safe', readonly: true })).toBe('allow');
    expect(decideAutomaticPermission('ask', { dangerLevel: 'safe' })).toBe('allow');
  });

  it('denies write-capable tools in readonly mode', () => {
    expect(decideAutomaticPermission('readonly', { dangerLevel: 'medium', readonly: false })).toBe('deny');
  });

  it('keeps critical tools behind a hard approval boundary even in full-auto', () => {
    expect(decideAutomaticPermission('full-auto', { dangerLevel: 'critical' })).toBe('ask');
  });

  it('allows high tools in full-auto but asks in normal modes', () => {
    expect(decideAutomaticPermission('full-auto', { dangerLevel: 'high' })).toBe('allow');
    expect(decideAutomaticPermission('auto', { dangerLevel: 'high' })).toBe('ask');
    expect(decideAutomaticPermission('ask', { dangerLevel: 'high' })).toBe('ask');
  });
});
