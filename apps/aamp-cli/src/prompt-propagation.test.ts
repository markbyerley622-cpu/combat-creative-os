import { describe, expect, it } from 'vitest';

import { AGENT_REGISTRY } from '@combat/agents';

import { hashPrompt, type CampaignRequest } from './campaign-request';
import { buildPlanningInputs } from './plan-campaign';

/**
 * The claim this milestone rests on is that the requester's brief actually
 * reaches the agents and actually changes what they are asked. These tests
 * check that claim at the only place it can be checked without a model: the
 * inputs handed to `executeAgent`.
 */

function request(overrides: Partial<CampaignRequest> = {}): CampaignRequest {
  const campaignPrompt =
    overrides.campaignPrompt ??
    'Promote this weekend’s coverage. Open on the number of events available.';
  return {
    requestVersion: 1,
    name: 'combat-reviews-weekend',
    workspaceId: '6f1d5f6c-6d3a-4a2e-9c5f-0f2a1b3c4d5e',
    campaignId: '3c9b7a24-8f61-4d0e-9a37-5b2c8e14d7f0',
    brandName: 'Combat Reviews',
    objective: 'Drive installs',
    targetAudience: 'Combat sports fans 18-34',
    platform: 'TIKTOK',
    targetDurationSeconds: 15,
    productFacts: [{ id: 'coverage', label: 'Coverage', detail: 'Every promotion, one app.' }],
    eventFacts: [{ id: 'weekend', label: 'Events this weekend', detail: '12 events scheduled.' }],
    keyMessages: ['12 events this weekend'],
    mandatories: ['End on Download Free'],
    cta: { headline: 'Download Free', durationSeconds: 3 },
    brandKit: {
      logoAssetId: 'logo-primary',
      primaryColorHex: '#0B0B0F',
      accentColorHex: '#FF3B30',
      captionFontFamily: 'Arial',
      safeAreaTopPx: 220,
      safeAreaBottomPx: 420,
    },
    sourceAssetManifest: './assets.json',
    outputDirectory: '.aamp-output/runs',
    generation: {
      source: 'SOURCE_ONLY',
      comfyuiProfile: 'LTX_2_3_DRAFT',
      generatedShotCount: 0,
      maxGeneratedShotSeconds: 4,
    },
    ...overrides,
    campaignPrompt,
    promptSha256: hashPrompt(campaignPrompt),
    sourceAssetManifestPath: 'C:/campaign/assets.json',
    requestPath: 'C:/campaign/request.json',
  } as CampaignRequest;
}

describe('the prompt reaches the agents', () => {
  it('carries the brief verbatim, not a truncated summary', () => {
    const prompt =
      'Open on the number of events. Then event details, then predictions, then discussion. Finish on Download Free.';
    const { strategist } = buildPlanningInputs(request({ campaignPrompt: prompt }));

    expect(strategist.campaignPrompt).toBe(prompt);
  });

  it('passes product and event facts as ordered, labelled constraints', () => {
    const { strategist, factualConstraints } = buildPlanningInputs(request());

    expect(factualConstraints).toEqual([
      'PRODUCT — Coverage: Every promotion, one app.',
      'EVENT — Events this weekend: 12 events scheduled.',
    ]);
    expect(strategist.factualConstraints).toEqual(factualConstraints);
  });

  it('does not discard the prompt when a derived objective is also present', () => {
    const { strategist } = buildPlanningInputs(request());
    expect(strategist.objective).toBe('Drive installs');
    expect(String(strategist.campaignPrompt)).toContain('number of events');
  });
});

describe('planning inputs are deterministic and prompt-sensitive', () => {
  it('produces identical inputs for identical requests', () => {
    const a = buildPlanningInputs(request());
    const b = buildPlanningInputs(request());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('produces different inputs for different prompts', () => {
    const a = buildPlanningInputs(request({ campaignPrompt: 'Lead with the free price point.' }));
    const b = buildPlanningInputs(
      request({ campaignPrompt: 'Lead with the community arguments.' }),
    );

    expect(a.strategist.campaignPrompt).not.toBe(b.strategist.campaignPrompt);
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it('produces different constraints for different facts', () => {
    const a = buildPlanningInputs(request());
    const b = buildPlanningInputs(
      request({
        eventFacts: [
          { id: 'weekend', label: 'Events this weekend', detail: '4 events scheduled.' },
        ],
      }),
    );
    expect(a.factualConstraints).not.toEqual(b.factualConstraints);
  });

  it('changes the prompt hash when the prompt changes, and only then', () => {
    expect(request().promptSha256).toBe(request().promptSha256);
    expect(request({ campaignPrompt: 'A different brief entirely.' }).promptSha256).not.toBe(
      request().promptSha256,
    );
  });
});

describe('the agents declare the new input fields', () => {
  it.each([
    'campaign-strategist',
    'creative-director',
    'script-timing-director',
    'shot-prompt-engineer',
  ])('%s accepts campaignPrompt and factualConstraints', (agentName) => {
    const definition = AGENT_REGISTRY[agentName as 'campaign-strategist'];
    const parsed = definition.inputSchema.safeParse(
      agentName === 'campaign-strategist'
        ? {
            brandName: 'Combat Reviews',
            objective: 'x',
            targetPlatforms: ['TIKTOK'],
            durationsSeconds: [15],
            budgetCents: 0,
            campaignPrompt: 'a brief',
            factualConstraints: ['PRODUCT — Price: Free'],
          }
        : agentName === 'creative-director'
          ? {
              brandName: 'Combat Reviews',
              strategy: {
                positioning: 'p',
                targetAudienceSummary: 's',
                keyMessages: ['k'],
                toneGuidelines: ['t'],
              },
              durationsSeconds: [15],
              campaignPrompt: 'a brief',
              factualConstraints: ['PRODUCT — Price: Free'],
            }
          : agentName === 'script-timing-director'
            ? {
                logline: 'l',
                visualDirection: 'v',
                narrativeArc: 'n',
                targetDurationsSeconds: [15],
                callToAction: 'Download Free',
                campaignPrompt: 'a brief',
                factualConstraints: ['PRODUCT — Price: Free'],
              }
            : {
                shot: { index: 0, description: 'd', durationFrames: 90 },
                visualDirection: 'v',
                providerId: 'source-library',
                campaignPrompt: 'a brief',
                factualConstraints: ['PRODUCT — Price: Free'],
              },
    );

    expect(parsed.success).toBe(true);
  });

  it('every planning agent’s prompt tells it what to do with the brief', () => {
    for (const agentName of [
      'campaign-strategist',
      'creative-director',
      'script-timing-director',
      'shot-prompt-engineer',
    ] as const) {
      const prompt = AGENT_REGISTRY[agentName].promptVersion.systemPrompt;
      expect(prompt).toContain('# Campaign Brief and Factual Constraints');
      expect(prompt).toContain('campaignPrompt');
      expect(prompt).toContain('factualConstraints');
      // No agency-imitation prompting anywhere in the chain.
      expect(prompt).toContain('Do not name, imitate, or reference any advertising agency');
    }
  });
});
