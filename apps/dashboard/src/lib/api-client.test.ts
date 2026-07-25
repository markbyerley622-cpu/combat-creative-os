import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient } from './api-client';

function mockFetchOnce(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

describe('createApiClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('builds workspace-scoped, userId-carrying request URLs', async () => {
    const fetchMock = mockFetchOnce(200, { campaigns: [] });
    vi.stubGlobal('fetch', fetchMock);

    const client = createApiClient('ws-1', 'user-1', { baseUrl: 'http://api.test' });
    await client.listCampaigns();

    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/workspaces/ws-1/campaigns?userId=user-1',
      expect.objectContaining({
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
      }),
    );
  });

  it('POSTs a JSON body for mutating calls', async () => {
    const fetchMock = mockFetchOnce(201, { campaign: { id: 'c1' } });
    vi.stubGlobal('fetch', fetchMock);

    const client = createApiClient('ws-1', 'user-1', { baseUrl: 'http://api.test' });
    await client.createCampaign('Q3 Launch');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      userId: 'user-1',
      name: 'Q3 Launch',
      idempotencyKey: undefined,
    });
  });

  it('throws ApiError with the response status and body on a non-2xx response', async () => {
    const fetchMock = mockFetchOnce(403, { error: 'FORBIDDEN', message: 'nope' });
    vi.stubGlobal('fetch', fetchMock);

    const client = createApiClient('ws-1', 'user-1', { baseUrl: 'http://api.test' });

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
    const client = createApiClient('ws-1', 'user-1', { baseUrl: 'http://api.test' });
    await client.getShotReview('camp-1');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/workspaces/ws-1/campaigns/camp-1/shot-review?userId=user-1',
      expect.anything(),
    );
  });

  it('POSTs a candidate selection with the optimistic-concurrency revision', async () => {
    const fetchMock = mockFetchOnce(200, { set: { id: 's1' } });
    vi.stubGlobal('fetch', fetchMock);
    const client = createApiClient('ws-1', 'user-1', { baseUrl: 'http://api.test' });
    await client.selectShotCandidate('camp-1', {
      setId: 's1',
      shotId: 'shot-1',
      candidateId: 'cand-1',
      expectedRevision: 2,
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://api.test/workspaces/ws-1/campaigns/camp-1/shot-review/select');
    expect(JSON.parse(init.body as string)).toEqual({
      userId: 'user-1',
      setId: 's1',
      shotId: 'shot-1',
      candidateId: 'cand-1',
      expectedRevision: 2,
    });
  });

  it('POSTs an approval to the shot-review approve endpoint (not a generic gate route)', async () => {
    const fetchMock = mockFetchOnce(202, { approvalId: 'a1', replayed: false, set: { id: 's1' } });
    vi.stubGlobal('fetch', fetchMock);
    const client = createApiClient('ws-1', 'user-1', { baseUrl: 'http://api.test' });
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
    const client = createApiClient('ws-1', 'user-1', { baseUrl: 'http://api.test' });
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
    const client = createApiClient('ws-1', 'user-1', { baseUrl: 'http://api.test' });
    await client.getCompositing('camp-1');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/workspaces/ws-1/campaigns/camp-1/compositing?userId=user-1',
      expect.anything(),
    );
  });

  it('POSTs a cancel request to the compositing cancel endpoint', async () => {
    const fetchMock = mockFetchOnce(202, { cancelRequested: true });
    vi.stubGlobal('fetch', fetchMock);
    const client = createApiClient('ws-1', 'user-1', { baseUrl: 'http://api.test' });
    await client.cancelCompositing('camp-1');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://api.test/workspaces/ws-1/campaigns/camp-1/compositing/cancel');
    expect(init.method).toBe('POST');
  });

  it('surfaces a 403 cancel rejection as an ApiError', async () => {
    const fetchMock = mockFetchOnce(403, { error: 'FORBIDDEN' });
    vi.stubGlobal('fetch', fetchMock);
    const client = createApiClient('ws-1', 'user-1', { baseUrl: 'http://api.test' });
    await expect(client.cancelCompositing('camp-1')).rejects.toMatchObject({ status: 403 });
  });
});
