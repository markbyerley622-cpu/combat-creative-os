import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createPromptTemplate,
  createPromptVersion,
  getGenerationPrompt,
  nextPromptVersionNumber,
  recordGenerationPrompt,
} from './prompt-repository';
import { InMemoryCampaignStore } from './test-helpers/in-memory-campaign-store';

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

  it('recordGenerationPrompt always pins a promptVersionId, and it is reconstructible afterward', async () => {
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

    const generationPrompt = await recordGenerationPrompt(store, workspaceId, {
      shotId: randomUUID(),
      promptVersionId: version.id,
      providerId: 'veo',
      promptText: 'A boxer throwing a jab in slow motion',
    });

    expect(generationPrompt.promptVersionId).toBe(version.id);

    const reloaded = await getGenerationPrompt(store, workspaceId, generationPrompt.id);
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
});
