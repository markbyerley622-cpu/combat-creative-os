import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createPromptTemplate,
  createPromptVersion,
  getOrCreatePromptVersionForAgent,
  nextPromptVersionNumber,
} from './prompt-repository';
import { createShotSpecification, getShotSpecification } from './shot-specification-repository';
import { InMemoryCampaignStore } from './test-helpers/in-memory-campaign-store';

function baseShotSpecificationInput(
  overrides: Partial<Parameters<typeof createShotSpecification>[2]> = {},
) {
  return {
    campaignId: randomUUID(),
    creativeConceptId: randomUUID(),
    creativeConceptVersion: 1,
    scriptId: randomUUID(),
    scriptVersion: 1,
    shotId: randomUUID(),
    version: 1,
    shotNumber: 0,
    sequencePosition: 0,
    intendedDurationSeconds: 5,
    visualObjective: 'Establish the product hook',
    action: 'Hands unbox the product',
    subject: 'Product',
    environment: 'Studio',
    cameraMovement: 'Static',
    lensFraming: 'Close-up',
    lighting: 'Soft key light',
    colorTreatment: 'Warm, high contrast',
    motionIntensity: 'LOW' as const,
    transitionIn: 'CUT' as const,
    transitionOut: 'CUT' as const,
    textSafeAreas: [],
    referenceAssetIds: [],
    continuityRequirements: [],
    providerId: 'veo',
    promptVersionId: randomUUID(),
    generationPrompt: 'A boxer throwing a jab in slow motion',
    generationParams: { durationSeconds: 5, aspectRatio: '9:16' as const, providerOptions: {} },
    outputRequirements: { durationSeconds: 5, aspectRatio: '9:16' as const, minCandidateCount: 1 },
    qualityRubric: [],
    licensingConstraints: [],
    createdByAgentInvocationId: randomUUID(),
    ...overrides,
  };
}

describe('prompt versioning — every generation records the exact prompt version used', () => {
  it('assigns monotonically increasing version numbers per template', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const template = await createPromptTemplate(store, workspaceId, {
      agentKey: 'shot-prompt-engineer',
      name: 'hero-shot-v1',
    });

    const v1Number = await nextPromptVersionNumber(store, template.id);
    expect(v1Number).toBe(1);
    const v1 = await createPromptVersion(store, workspaceId, {
      promptTemplateId: template.id,
      version: v1Number,
      systemPrompt: 'Generate a hero shot...',
    });

    const v2Number = await nextPromptVersionNumber(store, template.id);
    expect(v2Number).toBe(2);
    await createPromptVersion(store, workspaceId, {
      promptTemplateId: template.id,
      version: v2Number,
      systemPrompt: 'Generate a hero shot, revised...',
    });

    expect(v1.version).toBe(1);
  });

  it('createShotSpecification always pins a promptVersionId, and it is reconstructible afterward', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const template = await createPromptTemplate(store, workspaceId, {
      agentKey: 'shot-prompt-engineer',
      name: 'hero-shot-v1',
    });
    const version = await createPromptVersion(store, workspaceId, {
      promptTemplateId: template.id,
      version: 1,
      systemPrompt: 'Generate a hero shot...',
    });

    const shotSpecification = await createShotSpecification(
      store,
      workspaceId,
      baseShotSpecificationInput({ promptVersionId: version.id }),
    );

    expect(shotSpecification.promptVersionId).toBe(version.id);

    const reloaded = await getShotSpecification(store, workspaceId, shotSpecification.id);
    expect(reloaded?.promptVersionId).toBe(version.id);
  });

  it('a revised prompt for the same agent is a new version, not a mutation of the old one', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const template = await createPromptTemplate(store, workspaceId, {
      agentKey: 'shot-prompt-engineer',
      name: 'hero-shot-v1',
    });
    const v1 = await createPromptVersion(store, workspaceId, {
      promptTemplateId: template.id,
      version: 1,
      systemPrompt: 'v1 text',
    });
    const v2 = await createPromptVersion(store, workspaceId, {
      promptTemplateId: template.id,
      version: 2,
      systemPrompt: 'v2 text',
    });

    expect(store.promptVersions).toHaveLength(2);
    expect(v1.systemPrompt).toBe('v1 text');
    expect(v2.systemPrompt).toBe('v2 text');
    expect(v1.id).not.toBe(v2.id);
  });

  it('getOrCreatePromptVersionForAgent is idempotent — a retried call never violates the unique template/version constraints', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();

    const first = await getOrCreatePromptVersionForAgent(store, workspaceId, {
      agentKey: 'shot-prompt-engineer',
      version: 2,
      systemPrompt: 'v2 system prompt',
    });
    const retried = await getOrCreatePromptVersionForAgent(store, workspaceId, {
      agentKey: 'shot-prompt-engineer',
      version: 2,
      systemPrompt: 'v2 system prompt',
    });

    expect(retried.id).toBe(first.id);
    expect(store.promptTemplates).toHaveLength(1);
    expect(store.promptVersions).toHaveLength(1);
  });
});
