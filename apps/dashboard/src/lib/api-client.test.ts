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
