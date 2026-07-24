import { describe, expect, it } from 'vitest';
import { AGENT_REGISTRY, isSpecialistAgentName, SPECIALIST_AGENT_NAMES } from './registry';

const PLACEHOLDER_AGENTS = new Set([
  'asset-manager',
  'video-generation-coordinator',
  'motion-compositing-coordinator',
]);

const QA_AGENTS = new Set(['visual-quality-controller', 'continuity-controller', 'final-qa-controller']);

describe('SPECIALIST_AGENT_NAMES', () => {
  it('lists all fourteen specialist agents from the architecture', () => {
    expect(SPECIALIST_AGENT_NAMES).toHaveLength(14);
  });

  it('isSpecialistAgentName distinguishes known from unknown names', () => {
    expect(isSpecialistAgentName('creative-director')).toBe(true);
    expect(isSpecialistAgentName('made-up-agent')).toBe(false);
  });
});

describe('AGENT_REGISTRY', () => {
  it('has exactly one definition per canonical name, keyed consistently', () => {
    for (const name of SPECIALIST_AGENT_NAMES) {
      expect(AGENT_REGISTRY[name].name).toBe(name);
    }
  });

  it('implements exactly the eleven requested agents and no others', () => {
    const implemented = SPECIALIST_AGENT_NAMES.filter((name) => AGENT_REGISTRY[name].implemented);
    expect(implemented).toHaveLength(11);
    for (const name of implemented) {
      expect(PLACEHOLDER_AGENTS.has(name)).toBe(false);
    }
  });

  it('marks exactly the three deferred agents as NOT_IMPLEMENTED, disabled, with a recorded future milestone', () => {
    for (const name of PLACEHOLDER_AGENTS) {
      const definition = AGENT_REGISTRY[name as keyof typeof AGENT_REGISTRY];
      expect(definition.implemented).toBe(false);
      expect(definition.disabledByDefault).toBe(true);
      expect(definition.futureMilestone).toBeTruthy();
    }
  });

  it('never lets an agent review its own creative work (requirement 12)', () => {
    for (const name of SPECIALIST_AGENT_NAMES) {
      const definition = AGENT_REGISTRY[name];
      expect(definition.reviewsOutputOf ?? []).not.toContain(name);
    }
  });

  it('gives every QA-category agent an explicit rubric, and no non-QA agent one (requirement 13)', () => {
    for (const name of SPECIALIST_AGENT_NAMES) {
      const definition = AGENT_REGISTRY[name];
      if (QA_AGENTS.has(name)) {
        expect(definition.rubric).toBeDefined();
        expect(definition.rubric!.criteria.length).toBeGreaterThan(0);
        expect(definition.deriveEvaluation).toBeTypeOf('function');
      } else {
        expect(definition.rubric).toBeUndefined();
      }
    }
  });

  it('gives every implemented agent a versioned prompt starting at version 1', () => {
    for (const name of SPECIALIST_AGENT_NAMES) {
      const definition = AGENT_REGISTRY[name];
      expect(definition.promptVersion.version).toBeGreaterThanOrEqual(1);
      expect(definition.promptVersion.systemPrompt.length).toBeGreaterThan(0);
    }
  });

  it('canonical ids are unchanged even though display labels differ', () => {
    expect(AGENT_REGISTRY['script-timing-director'].displayName).toBe('Script Director');
    expect(AGENT_REGISTRY['visual-quality-controller'].displayName).toBe('Visual QA Controller');
  });
});
