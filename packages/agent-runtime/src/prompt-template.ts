/**
 * A single versioned system prompt shipped as a source file (requirement 10
 * — "Agent prompts must be stored as versioned files"). Each specialist
 * agent package holds one file per version under `src/<agent>/prompts/`
 * (e.g. `v1.ts`, `v2.ts`) exporting a `PromptTemplate` — never a mutable
 * "current prompt" string edited in place, so a prompt used months ago
 * stays reconstructible from source control.
 *
 * This is distinct from `@combat/domain`'s `PromptVersionSchema`, which is
 * the *database row* recording that a given prompt version was used for a
 * given invocation (id, workspaceId, timestamps). `PromptTemplate` here is
 * the actual authored content; a future Activity persists a `PromptVersion`
 * row whose `version`/`systemPrompt` mirror one of these files the first
 * time it's used.
 */
export interface PromptTemplate {
  /** Monotonically increasing per agent, starting at 1. Never reused. */
  readonly version: number;
  /** One-line note on what changed from the previous version, or 'initial'. */
  readonly changelog: string;
  readonly systemPrompt: string;
}

export function definePromptTemplate(template: PromptTemplate): PromptTemplate {
  if (!Number.isInteger(template.version) || template.version < 1) {
    throw new Error(`PromptTemplate.version must be a positive integer, got ${template.version}`);
  }
  if (template.systemPrompt.trim().length === 0) {
    throw new Error('PromptTemplate.systemPrompt must not be empty');
  }
  return template;
}
