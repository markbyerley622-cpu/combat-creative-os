import { definePromptTemplate, type PromptTemplate } from '@combat/agent-runtime';

/**
 * A placeholder `PromptTemplate` for the three unimplemented agents
 * (asset-manager, video-generation-coordinator, motion-compositing-
 * coordinator). `AgentDefinition.promptVersion` is required by the type, but
 * `executeAgent` throws `AgentNotImplementedError` before this content is
 * ever sent anywhere — it exists only so the definition type-checks and so
 * the eventual real implementation has an obvious file to replace.
 */
export function definePlaceholderPrompt(
  agentName: string,
  futureMilestone: string,
): PromptTemplate {
  return definePromptTemplate({
    version: 1,
    changelog: 'placeholder — not implemented',
    systemPrompt: `Placeholder for "${agentName}", scheduled for ${futureMilestone}. This prompt is never sent to a reasoning provider.`,
  });
}
