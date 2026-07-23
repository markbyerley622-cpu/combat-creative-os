import { describe, expect, it } from 'vitest';
import { isSpecialistAgentName, SPECIALIST_AGENT_NAMES } from './registry';

describe('SPECIALIST_AGENT_NAMES', () => {
  it('lists all fourteen specialist agents from the architecture', () => {
    expect(SPECIALIST_AGENT_NAMES).toHaveLength(14);
  });

  it('isSpecialistAgentName distinguishes known from unknown names', () => {
    expect(isSpecialistAgentName('creative-director')).toBe(true);
    expect(isSpecialistAgentName('made-up-agent')).toBe(false);
  });
});
