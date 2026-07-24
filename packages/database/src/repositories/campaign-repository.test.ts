import { describe, expect, it } from 'vitest';
import { createCampaign, getCampaign } from './campaign-repository';
import { InMemoryCampaignStore } from './test-helpers/in-memory-campaign-store';

describe('createCampaign', () => {
  it('creates a new campaign in DRAFT', async () => {
    const store = new InMemoryCampaignStore();
    const campaign = await createCampaign(store, 'ws-1', { name: 'Q3 Launch' });
    expect(campaign.currentStage).toBe('DRAFT');
    expect(campaign.workspaceId).toBe('ws-1');
  });

  it('is idempotent by (workspaceId, idempotencyKey): a duplicate request returns the original campaign', async () => {
    const store = new InMemoryCampaignStore();
    const first = await createCampaign(store, 'ws-1', {
      name: 'Q3 Launch',
      idempotencyKey: 'client-req-1',
    });
    const second = await createCampaign(store, 'ws-1', {
      name: 'Q3 Launch (retry, ignored)',
      idempotencyKey: 'client-req-1',
    });
    expect(second.id).toBe(first.id);
    expect(second.name).toBe('Q3 Launch');
    expect(store.campaigns).toHaveLength(1);
  });

  it('does not dedupe the same idempotencyKey across different workspaces', async () => {
    const store = new InMemoryCampaignStore();
    const a = await createCampaign(store, 'ws-1', { name: 'A', idempotencyKey: 'k' });
    const b = await createCampaign(store, 'ws-2', { name: 'B', idempotencyKey: 'k' });
    expect(a.id).not.toBe(b.id);
  });
});

describe('getCampaign', () => {
  it('404s (returns null) for a campaign looked up under the wrong workspace', async () => {
    const store = new InMemoryCampaignStore();
    const campaign = store.seedCampaign();
    expect(await getCampaign(store, 'wrong-workspace', campaign.id)).toBeNull();
    expect(await getCampaign(store, campaign.workspaceId, campaign.id)).not.toBeNull();
  });
});
