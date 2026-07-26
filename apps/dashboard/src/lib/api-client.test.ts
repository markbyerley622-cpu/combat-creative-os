import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient } from './api-client';

function mockFetchOnce(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

/**
 * AAMP-1 step 2: every client is built with a token getter, never a user id.
 * `apps/api` derives the caller from the token this returns.
 */
const tokenGetter = vi.fn(async () => 'session-token');

afterEach(() => {
  vi.unstubAllGlobals();
  tokenGetter.mockClear();
});

describe('createApiClient', () => {
  it('builds workspace-scoped URLs that carry no caller identity', async () => {
    const fetchMock = mockFetchOnce(200, { campaigns: [] });
    vi.stubGlobal('fetch', fetchMock);

    const client = createApiClient('ws-1', tokenGetter, { baseUrl: 'http://api.test' });
    await client.listCampaigns();

    // AAMP-1 step 2: the URL says which workspace, never who is asking.
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/workspaces/ws-1/campaigns',
      expect.objectContaining({
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: 'Bearer session-token',
        }),
      }),
    );
  });

  it('presents the session token as a bearer credential on every call', async () => {
    const fetchMock = mockFetchOnce(200, { campaigns: [] });
    vi.stubGlobal('fetch', fetchMock);

    const client = createApiClient('ws-1', tokenGetter, { baseUrl: 'http://api.test' });
    await client.listCampaigns();
    await client.listCampaigns();

    // Minted per request, not captured once: a rotated or refreshed session
    // token reaches apps/api without rebuilding the client.
    expect(tokenGetter).toHaveBeenCalledTimes(2);
  });

  it('omits the Authorization header entirely when signed out', async () => {
    const fetchMock = mockFetchOnce(401, { error: 'UNAUTHENTICATED' });
    vi.stubGlobal('fetch', fetchMock);

    const client = createApiClient('ws-1', async () => null, { baseUrl: 'http://api.test' });
    await client.listCampaigns().catch(() => undefined);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).not.toHaveProperty('Authorization');
  });

  it('POSTs a JSON body for mutating calls', async () => {
    const fetchMock = mockFetchOnce(201, { campaign: { id: 'c1' } });
    vi.stubGlobal('fetch', fetchMock);

    const client = createApiClient('ws-1', tokenGetter, { baseUrl: 'http://api.test' });
    await client.createCampaign('Q3 Launch');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    // No `userId`: apps/api derives the caller from the bearer token, and its
    // strict body schemas reject one if a client ever sends it again.
    expect(JSON.parse(init.body as string)).toEqual({
      name: 'Q3 Launch',
      idempotencyKey: undefined,
    });
  });

  it('throws ApiError with the response status and body on a non-2xx response', async () => {
    const fetchMock = mockFetchOnce(403, { error: 'FORBIDDEN', message: 'nope' });
    vi.stubGlobal('fetch', fetchMock);

    const client = createApiClient('ws-1', tokenGetter, { baseUrl: 'http://api.test' });

    await expect(client.createCampaign('Q3 Launch')).rejects.toMatchObject({
      status: 403,
      body: { error: 'FORBIDDEN', message: 'nope' },
    });
    await expect(client.createCampaign('Q3 Launch')).rejects.toBeInstanceOf(ApiError);
  });
});

describe('createApiClient — M8 shot review', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('GETs the shot-review workspace scoped to workspace + user', async () => {
    const fetchMock = mockFetchOnce(200, { shots: [] });
    vi.stubGlobal('fetch', fetchMock);
    const client = createApiClient('ws-1', tokenGetter, { baseUrl: 'http://api.test' });
    await client.getShotReview('camp-1');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/workspaces/ws-1/campaigns/camp-1/shot-review',
      expect.anything(),
    );
  });

  it('POSTs a candidate selection with the optimistic-concurrency revision', async () => {
    const fetchMock = mockFetchOnce(200, { set: { id: 's1' } });
    vi.stubGlobal('fetch', fetchMock);
    const client = createApiClient('ws-1', tokenGetter, { baseUrl: 'http://api.test' });
    await client.selectShotCandidate('camp-1', {
      setId: 's1',
      shotId: 'shot-1',
      candidateId: 'cand-1',
      expectedRevision: 2,
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://api.test/workspaces/ws-1/campaigns/camp-1/shot-review/select');
    expect(JSON.parse(init.body as string)).toEqual({
      setId: 's1',
      shotId: 'shot-1',
      candidateId: 'cand-1',
      expectedRevision: 2,
    });
  });

  it('POSTs an approval to the shot-review approve endpoint (not a generic gate route)', async () => {
    const fetchMock = mockFetchOnce(202, { approvalId: 'a1', replayed: false, set: { id: 's1' } });
    vi.stubGlobal('fetch', fetchMock);
    const client = createApiClient('ws-1', tokenGetter, { baseUrl: 'http://api.test' });
    await client.approveShotSelection('camp-1', { setId: 's1', expectedRevision: 3 });
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://api.test/workspaces/ws-1/campaigns/camp-1/shot-review/approve');
  });

  it('surfaces a 409 ineligible/stale conflict as an ApiError with reasons', async () => {
    const fetchMock = mockFetchOnce(409, {
      error: 'INELIGIBLE_CANDIDATE',
      reasons: ['VISUAL_QA_NOT_PASSED'],
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = createApiClient('ws-1', tokenGetter, { baseUrl: 'http://api.test' });
    await expect(
      client.selectShotCandidate('camp-1', {
        setId: 's1',
        shotId: 'x',
        candidateId: 'y',
        expectedRevision: 0,
      }),
    ).rejects.toMatchObject({ status: 409, body: { error: 'INELIGIBLE_CANDIDATE' } });
  });
});

describe('createApiClient — M9 compositing', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('GETs the compositing status scoped to workspace + user', async () => {
    const fetchMock = mockFetchOnce(200, { attempts: [] });
    vi.stubGlobal('fetch', fetchMock);
    const client = createApiClient('ws-1', tokenGetter, { baseUrl: 'http://api.test' });
    await client.getCompositing('camp-1');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/workspaces/ws-1/campaigns/camp-1/compositing',
      expect.anything(),
    );
  });

  it('POSTs a cancel request to the compositing cancel endpoint', async () => {
    const fetchMock = mockFetchOnce(202, { cancelRequested: true });
    vi.stubGlobal('fetch', fetchMock);
    const client = createApiClient('ws-1', tokenGetter, { baseUrl: 'http://api.test' });
    await client.cancelCompositing('camp-1');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://api.test/workspaces/ws-1/campaigns/camp-1/compositing/cancel');
    expect(init.method).toBe('POST');
  });

  it('surfaces a 403 cancel rejection as an ApiError', async () => {
    const fetchMock = mockFetchOnce(403, { error: 'FORBIDDEN' });
    vi.stubGlobal('fetch', fetchMock);
    const client = createApiClient('ws-1', tokenGetter, { baseUrl: 'http://api.test' });
    await expect(client.cancelCompositing('camp-1')).rejects.toMatchObject({ status: 403 });
  });
});

describe('createApiClient — M10 sound design', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('GETs the sound-design status scoped to workspace + user', async () => {
    const fetchMock = mockFetchOnce(200, { cues: [] });
    vi.stubGlobal('fetch', fetchMock);
    const client = createApiClient('ws-1', tokenGetter, { baseUrl: 'http://api.test' });
    await client.getSoundDesign('camp-1');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/workspaces/ws-1/campaigns/camp-1/sound-design',
      expect.anything(),
    );
  });
});

describe('createApiClient — M13 performance and learning', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('GETs a campaign performance history scoped to workspace + user', async () => {
    const fetchMock = mockFetchOnce(200, { observations: [] });
    vi.stubGlobal('fetch', fetchMock);
    const client = createApiClient('ws-1', tokenGetter, { baseUrl: 'http://api.test' });
    await client.getCampaignPerformance('camp-1');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/workspaces/ws-1/campaigns/camp-1/performance',
      expect.anything(),
    );
  });

  it('POSTs a fixture ingestion batch', async () => {
    const fetchMock = mockFetchOnce(202, { ingested: 1, deduplicated: 0, observations: [] });
    vi.stubGlobal('fetch', fetchMock);
    const client = createApiClient('ws-1', tokenGetter, { baseUrl: 'http://api.test' });
    const observations = [
      {
        platform: 'TIKTOK' as const,
        externalPostId: 'post-1',
        periodStart: '2026-07-18T00:00:00.000Z',
        periodEnd: '2026-07-25T00:00:00.000Z',
        raw: { impressions: 10, clicks: 1, conversions: 0, spendCents: 5 },
      },
    ];
    await client.ingestPerformance('camp-1', { source: 'FIXTURE', observations });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/workspaces/ws-1/campaigns/camp-1/performance/observations',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ source: 'FIXTURE', observations }),
      }),
    );
  });

  it('GETs the workspace learning records', async () => {
    const fetchMock = mockFetchOnce(200, { learnings: [] });
    vi.stubGlobal('fetch', fetchMock);
    const client = createApiClient('ws-1', tokenGetter, { baseUrl: 'http://api.test' });
    await client.getLearnings();
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/workspaces/ws-1/learnings',
      expect.anything(),
    );
  });

  it('POSTs a learning review decision', async () => {
    const fetchMock = mockFetchOnce(200, { id: 'l-1', status: 'APPROVED', version: 1 });
    vi.stubGlobal('fetch', fetchMock);
    const client = createApiClient('ws-1', tokenGetter, { baseUrl: 'http://api.test' });
    await client.reviewLearning('l-1', 'APPROVED');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/workspaces/ws-1/learnings/l-1/review',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ decision: 'APPROVED' }),
      }),
    );
  });
});

describe('createApiClient — M12 delivery variants', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('GETs the variant list scoped to workspace + user', async () => {
    const fetchMock = mockFetchOnce(200, { variants: [] });
    vi.stubGlobal('fetch', fetchMock);
    const client = createApiClient('ws-1', tokenGetter, { baseUrl: 'http://api.test' });
    await client.getVariants('camp-1');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/workspaces/ws-1/campaigns/camp-1/variants',
      expect.anything(),
    );
  });

  it('GETs a signed variant preview URL by asset id', async () => {
    const fetchMock = mockFetchOnce(200, { hasMedia: false, url: null });
    vi.stubGlobal('fetch', fetchMock);
    const client = createApiClient('ws-1', tokenGetter, { baseUrl: 'http://api.test' });
    await client.getVariantPreview('camp-1', 'asset-1');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/workspaces/ws-1/campaigns/camp-1/variants/asset-1/preview',
      expect.anything(),
    );
  });

  it('POSTs a variant cancellation', async () => {
    const fetchMock = mockFetchOnce(202, { cancelRequested: true });
    vi.stubGlobal('fetch', fetchMock);
    const client = createApiClient('ws-1', tokenGetter, { baseUrl: 'http://api.test' });
    await client.cancelVariants('camp-1');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/workspaces/ws-1/campaigns/camp-1/variants/cancel',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({}) }),
    );
  });
});

describe('createApiClient — M11 final QA + final approval', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('GETs the final-QA status scoped to workspace + user', async () => {
    const fetchMock = mockFetchOnce(200, { findings: [] });
    vi.stubGlobal('fetch', fetchMock);
    const client = createApiClient('ws-1', tokenGetter, { baseUrl: 'http://api.test' });
    await client.getFinalQa('camp-1');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/workspaces/ws-1/campaigns/camp-1/final-qa',
      expect.anything(),
    );
  });

  it('POSTs an APPROVED final decision to the one FINAL gate endpoint', async () => {
    const fetchMock = mockFetchOnce(202, { approvalId: 'a-1', replayed: false });
    vi.stubGlobal('fetch', fetchMock);
    const client = createApiClient('ws-1', tokenGetter, { baseUrl: 'http://api.test' });
    await client.submitFinalApproval('camp-1', { decision: 'APPROVED', comments: 'ship it' });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/workspaces/ws-1/campaigns/camp-1/approvals/final',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ decision: 'APPROVED', comments: 'ship it' }),
      }),
    );
  });

  it('POSTs a changes-requested decision with the repair target', async () => {
    const fetchMock = mockFetchOnce(202, { approvalId: 'a-2', replayed: false });
    vi.stubGlobal('fetch', fetchMock);
    const client = createApiClient('ws-1', tokenGetter, { baseUrl: 'http://api.test' });
    await client.submitFinalApproval('camp-1', {
      decision: 'CHANGES_REQUESTED',
      repairTarget: 'SOUND_DESIGN',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/workspaces/ws-1/campaigns/camp-1/approvals/final',
      expect.objectContaining({
        body: JSON.stringify({
          decision: 'CHANGES_REQUESTED',
          repairTarget: 'SOUND_DESIGN',
        }),
      }),
    );
  });
});
