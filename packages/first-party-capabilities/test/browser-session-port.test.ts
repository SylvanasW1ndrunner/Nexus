import { describe, expect, it } from 'vitest';
import type { BrowserSessionPort } from '../src/browser-session-port.js';

describe('BrowserSession Host Port', () => {
  it('exposes only bounded page operations and no Cookie or Storage authority', () => {
    const methods: Readonly<Record<keyof BrowserSessionPort, true>> = {
      probe: true,
      connect: true,
      navigate: true,
      read: true,
      click: true,
      interact: true,
      screenshot: true,
      close: true,
    };
    expect(Object.keys(methods).sort()).toEqual(['click', 'close', 'connect', 'interact', 'navigate', 'probe', 'read', 'screenshot']);
    expect(JSON.stringify(methods)).not.toMatch(/cookie|storage|header|authorization/i);
  });
});
