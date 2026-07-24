import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineAgent } from './agent-definition';
import { DEFAULT_MODEL_POLICY } from './model-policy';
import { DEFAULT_TOKEN_BUDGET } from './token-budget';
import { NO_TOOL_POLICY } from './tool-policy';
import { definePromptTemplate } from './prompt-template';

const base = {
  displayName: 'X',
  description: 'x',
  inputSchema: z.object({}),
  resultSchema: z.object({}),
  promptVersion: definePromptTemplate({ version: 1, changelog: 'initial', systemPrompt: 'x' }),
  modelPolicy: DEFAULT_MODEL_POLICY,
  tokenBudget: DEFAULT_TOKEN_BUDGET,
  toolPolicy: NO_TOOL_POLICY,
};

describe('defineAgent', () => {
  it('rejects an agent that lists itself in reviewsOutputOf (requirement 12)', () => {
    expect(() =>
      defineAgent({
        ...base,
        name: 'final-qa-controller',
        implemented: true,
        disabledByDefault: false,
        reviewsOutputOf: ['edit-director', 'final-qa-controller'],
      }),
    ).toThrow(/review its own creative work/);
  });

  it('requires a futureMilestone for any unimplemented agent', () => {
    expect(() =>
      defineAgent({ ...base, name: 'asset-manager', implemented: false, disabledByDefault: true }),
    ).toThrow(/futureMilestone/);
  });

  it('requires disabledByDefault=true for any unimplemented agent', () => {
    expect(() =>
      defineAgent({
        ...base,
        name: 'asset-manager',
        implemented: false,
        disabledByDefault: false,
        futureMilestone: 'M6',
      }),
    ).toThrow(/disabledByDefault/);
  });

  it('accepts a well-formed implemented agent', () => {
    const definition = defineAgent({
      ...base,
      name: 'creative-director',
      implemented: true,
      disabledByDefault: false,
    });
    expect(definition.name).toBe('creative-director');
  });

  it('accepts a well-formed placeholder agent', () => {
    const definition = defineAgent({
      ...base,
      name: 'asset-manager',
      implemented: false,
      disabledByDefault: true,
      futureMilestone: 'M6',
    });
    expect(definition.implemented).toBe(false);
  });
});
