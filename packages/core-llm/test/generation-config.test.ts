import { describe, expect, it } from 'vitest';
import { resolveLlmOutputReservation } from '../src/index.js';

describe('resolveLlmOutputReservation', () => {
  it('uses an explicit caller limit without replacing it with model metadata', () => {
    expect(resolveLlmOutputReservation(1_000_000, 160_000, 4_096)).toBe(4_096);
  });

  it('bounds a theoretical maximum output by context ratio and an engineering cap', () => {
    expect(resolveLlmOutputReservation(8_000, 4_096)).toBe(2_000);
    expect(resolveLlmOutputReservation(131_000, 131_000)).toBe(8_192);
  });

  it('keeps the reservation unknown when no reliable model limits exist', () => {
    expect(resolveLlmOutputReservation(null, null)).toBeNull();
  });
});
