import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CampaignRequestValidationError,
  formatFactualConstraints,
  hashPrompt,
  loadCampaignRequest,
  parseCampaignRequest,
  resolveContainedPath,
} from './campaign-request';

const VALID = {
  requestVersion: 1,
  name: 'combat-reviews-weekend',
  workspaceId: '6f1d5f6c-6d3a-4a2e-9c5f-0f2a1b3c4d5e',
  campaignId: '3c9b7a24-8f61-4d0e-9a37-5b2c8e14d7f0',
  brandName: 'Combat Reviews',
  campaignPrompt: 'Promote this weekend’s coverage. Hook on the number of events.',
  objective: 'Drive installs',
  targetAudience: 'Combat sports fans 18-34',
  targetDurationSeconds: 15,
  productFacts: [{ id: 'coverage', label: 'Coverage', detail: 'Every promotion, one app.' }],
  cta: { headline: 'Download Free' },
  brandKit: { logoAssetId: 'logo-primary' },
  sourceAssetManifest: './assets.json',
};

describe('campaign request validation', () => {
  it('accepts a well-formed request and applies defaults', () => {
    const request = parseCampaignRequest(VALID);
    expect(request.platform).toBe('TIKTOK');
    expect(request.generation.source).toBe('SOURCE_ONLY');
    expect(request.brandKit.safeAreaBottomPx).toBe(420);
    expect(request.cta.durationSeconds).toBe(3);
  });

  it('rejects an unknown key rather than ignoring it', () => {
    expect(() => parseCampaignRequest({ ...VALID, renderNow: true })).toThrow(
      CampaignRequestValidationError,
    );
  });

  it('rejects a request version it does not understand', () => {
    expect(() => parseCampaignRequest({ ...VALID, requestVersion: 2 })).toThrow(
      CampaignRequestValidationError,
    );
  });

  it('requires exactly one prompt source', () => {
    const { campaignPrompt: _drop, ...noPrompt } = VALID;
    expect(() => parseCampaignRequest(noPrompt)).toThrow(/a campaign prompt is required/);
    expect(() => parseCampaignRequest({ ...VALID, promptFile: './p.txt' })).toThrow(/not both/);
  });

  it('requires at least one product fact', () => {
    expect(() => parseCampaignRequest({ ...VALID, productFacts: [] })).toThrow(
      CampaignRequestValidationError,
    );
  });

  it('rejects duplicate fact ids', () => {
    expect(() =>
      parseCampaignRequest({
        ...VALID,
        productFacts: [...VALID.productFacts, VALID.productFacts[0]],
      }),
    ).toThrow(/duplicate productFacts id/);
  });

  it('refuses a CTA as long as the whole cut', () => {
    expect(() =>
      parseCampaignRequest({ ...VALID, cta: { headline: 'Go', durationSeconds: 15 } }),
    ).toThrow(/as long as the whole cut/);
  });

  it('refuses COMFYUI with no generated shots, and SOURCE_ONLY with some', () => {
    expect(() =>
      parseCampaignRequest({ ...VALID, generation: { source: 'COMFYUI', generatedShotCount: 0 } }),
    ).toThrow(/either request generated shots or use SOURCE_ONLY/);
    expect(() =>
      parseCampaignRequest({
        ...VALID,
        generation: { source: 'SOURCE_ONLY', generatedShotCount: 2 },
      }),
    ).toThrow(/SOURCE_ONLY but generatedShotCount/);
  });
});

describe('path containment', () => {
  it('accepts a path inside the base directory', () => {
    expect(resolveContainedPath('./assets.json', 'C:/campaign', 'f')).toContain('assets.json');
  });

  it('refuses a relative path that escapes the base directory', () => {
    expect(() => resolveContainedPath('../../secrets.json', 'C:/campaign', 'f')).toThrow(/escapes/);
  });
});

describe('prompt hashing and fact formatting', () => {
  it('hashes the trimmed prompt, stably', () => {
    expect(hashPrompt('  hello  ')).toBe(hashPrompt('hello'));
    expect(hashPrompt('a')).not.toBe(hashPrompt('b'));
    expect(hashPrompt('a')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('formats product and event facts as labelled, ordered constraint lines', () => {
    const request = {
      productFacts: [{ id: 'p', label: 'Price', detail: 'Free' }],
      eventFacts: [
        { id: 'e', label: 'Events', detail: '12 this weekend', startsAt: '2026-08-01T00:00:00Z' },
      ],
    } as never;

    expect(formatFactualConstraints(request)).toEqual([
      'PRODUCT — Price: Free',
      'EVENT — Events: 12 this weekend (starts 2026-08-01T00:00:00Z)',
    ]);
  });
});

describe('loading a request from disk', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'aamp-request-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('reads the prompt out of promptFile so a brief never has to survive shell quoting', async () => {
    const promptText = 'Line one.\n\nLine two with "quotes" and $dollars.\n';
    await writeFile(join(directory, 'brief.txt'), promptText, 'utf8');
    const { campaignPrompt: _drop, ...withFile } = VALID;
    await writeFile(
      join(directory, 'request.json'),
      JSON.stringify({ ...withFile, promptFile: './brief.txt' }),
      'utf8',
    );

    const request = await loadCampaignRequest(join(directory, 'request.json'));

    expect(request.campaignPrompt).toBe(promptText.trim());
    expect(request.promptSha256).toBe(hashPrompt(promptText));
    expect(request.sourceAssetManifestPath).toContain('assets.json');
  });

  it('refuses an empty prompt file rather than planning against nothing', async () => {
    await writeFile(join(directory, 'brief.txt'), '   \n', 'utf8');
    const { campaignPrompt: _drop, ...withFile } = VALID;
    await writeFile(
      join(directory, 'request.json'),
      JSON.stringify({ ...withFile, promptFile: './brief.txt' }),
      'utf8',
    );

    await expect(loadCampaignRequest(join(directory, 'request.json'))).rejects.toThrow(/is empty/);
  });
});
