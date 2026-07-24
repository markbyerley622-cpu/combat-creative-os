import { describe, expect, it } from 'vitest';
import { AGENT_REGISTRY, SPECIALIST_AGENT_NAMES } from './registry';

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
});
