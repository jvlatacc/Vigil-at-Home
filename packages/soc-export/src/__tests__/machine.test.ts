import { describe, expect, it } from 'vitest';
import { deriveMachineId } from '../machine.js';

describe('deriveMachineId', () => {
  it('is stable for a host and unique across hosts', () => {
    const id = deriveMachineId({ hostname: 'alice-macbook.local' });
    expect(deriveMachineId({ hostname: 'alice-macbook.local' })).toBe(id);
    expect(deriveMachineId({ hostname: 'bob-desktop' })).not.toBe(id);
  });

  it('never carries the host name itself', () => {
    const id = deriveMachineId({ hostname: 'alice-macbook.local' });
    expect(id).toMatch(/^vah-host-[0-9a-f]{16}$/);
    expect(id).not.toContain('alice');
  });

  it('falls back when the machine reports no usable host name', () => {
    expect(deriveMachineId({})).toBe('vah-host-unknown');
    expect(deriveMachineId({ username: 'alice-holland' })).toBe('vah-host-unknown');
  });
});
