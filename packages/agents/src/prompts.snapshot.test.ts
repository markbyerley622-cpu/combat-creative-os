import { describe, expect, it } from 'vitest';
import { AGENT_REGISTRY, SPECIALIST_AGENT_NAMES } from './registry';
import { CREATIVE_MEMORY_ADDENDUM } from './shared/creative-memory-prompt';

/** The four planning agents Creative Memory reaches. Nothing else should carry the addendum. */
const CREATIVE_MEMORY_AGENTS = [
  'campaign-strategist',
  'creative-director',
  'script-timing-director',
  'shot-prompt-engineer',
] as const;

/**
 * Snapshots every agent's versioned system prompt so an accidental edit to
 * prompt text (as opposed to a deliberate new `PromptTemplate` version) is
 * caught in review rather than silently shipped. Updating a snapshot is a
 * deliberate `vitest -u`, which is exactly the friction requirement 10
 * ("prompts must be stored as versioned files") is meant to introduce.
 */
describe('agent prompt snapshots', () => {
  it.each(SPECIALIST_AGENT_NAMES)('%s prompt version %s', (name) => {
    const definition = AGENT_REGISTRY[name];
    expect({
      version: definition.promptVersion.version,
      changelog: definition.promptVersion.changelog,
      systemPrompt: definition.promptVersion.systemPrompt,
    }).toMatchSnapshot();
  });

  it('every implemented agent prompt contains all five required prompt sections', () => {
    for (const name of SPECIALIST_AGENT_NAMES) {
      const definition = AGENT_REGISTRY[name];
      if (!definition.implemented) continue;
      const prompt = definition.promptVersion.systemPrompt;
      for (const section of [
        '# Role',
        '# Objective',
        '# Input Contract',
        '# Output Contract',
        '# Decision Rules',
        '# Rejection Rules',
        '# Escalation Rules',
        '# Quality Rubric',
        '# Prohibited Behavior',
        '# Reasoning Discipline',
      ]) {
        expect(prompt, `${name} prompt missing "${section}"`).toContain(section);
      }
    }
  });

  /**
   * The snapshots above deliberately include the bounded Creative Memory
   * section. This states that intent as an assertion, so a future edit that
   * drops the section from one of the four planning prompts fails with a
   * readable message rather than as an unexplained snapshot diff — and so the
   * *other* agents are proven not to have acquired it by accident.
   */
  it('carries the bounded Creative Memory section in exactly the four planning prompts', () => {
    const marker = '# Creative Memory (bounded benchmark context)';
    for (const name of SPECIALIST_AGENT_NAMES) {
      const prompt = AGENT_REGISTRY[name].promptVersion.systemPrompt;
      const expected = (CREATIVE_MEMORY_AGENTS as readonly string[]).includes(name);
      expect(prompt.includes(marker), `${name} Creative Memory section presence`).toBe(expected);
      if (expected) expect(prompt).toContain(CREATIVE_MEMORY_ADDENDUM.trim());
    }
  });

  it('tells the four planning agents to return a divergence record', () => {
    for (const name of CREATIVE_MEMORY_AGENTS) {
      expect(AGENT_REGISTRY[name].promptVersion.systemPrompt).toContain('creativeMemoryDivergence');
    }
  });
});
