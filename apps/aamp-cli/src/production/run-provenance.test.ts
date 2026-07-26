import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assertRunProvenanceSafe,
  computeProvenanceChecksum,
  RUN_PROVENANCE_FILENAME,
  RUN_PROVENANCE_VERSION,
  sealRunProvenance,
  UnsafeRunProvenanceError,
  verifyRunProvenance,
  writeRunProvenance,
  type AampRunProvenance,
} from './run-provenance';

/**
 * The provenance record is the artefact most likely to outlive the shell that
 * produced it and most likely to be read by somebody deciding whether a
 * deliverable is legitimate. So it gets two guarantees, both tested here: it
 * carries nothing it must not, and it can prove it has not been edited.
 */

function baseRecord(): Omit<AampRunProvenance, 'provenanceChecksumSha256'> {
  return {
    provenanceVersion: RUN_PROVENANCE_VERSION,
    workspaceId: '6f1d5f6c-6d3a-4a2e-9c5f-0f2a1b3c4d5e',
    campaignId: '99999999-9999-4999-8999-999999999999',
    campaignName: 'combat-reviews-weekend',
    workflowRunId: 'aamp-cli-test',
    correlationId: 'aamp-cli-test',
    idempotencyKey: 'a'.repeat(64),
    requestHashSha256: 'b'.repeat(64),
    promptSha256: 'c'.repeat(64),
    requestedExecutionMode: 'LOCAL_PRODUCTION',
    executionMode: 'LOCAL_PRODUCTION',
    evidence: {
      persistence: 'PRISMA_POSTGRESQL',
      vectorSearch: 'QDRANT_LIVE',
      reasoning: 'FIXTURE_REPLAY',
      videoGeneration: 'NOT_REQUIRED',
      rendering: 'FFMPEG_REAL',
      qa: 'ACTUAL_MEDIA',
    },
    label: {
      executionMode: 'LOCAL_PRODUCTION',
      isRealCampaignRun: false,
      demonstrationOnly: false,
      partiallySimulated: true,
      realComponents: ['rendering: FFMPEG_REAL'],
      simulatedComponents: ['reasoning provider: FIXTURE_REPLAY'],
      caveat: 'LOCAL_PRODUCTION — PARTIALLY SIMULATED.',
    },
    providers: [
      {
        role: 'reasoning',
        identity: 'fixture-replay',
        version: 'NONE-FIXTURE-REPLAY',
        capability: 'replays committed golden fixtures',
        simulated: true,
      },
    ],
    creativeMemoryMode: 'required',
    retrievals: [],
    agents: ['campaign-strategist@v1'],
    reasoningProvider: 'fixture-replay',
    reasoningModel: 'NONE-FIXTURE-REPLAY',
    generationProvider: null,
    generationProfile: null,
    renderProvider: 'ffmpeg',
    renderProviderVersion: 'ffmpeg version 8.1.2',
    outputChecksumSha256: 'd'.repeat(64),
    outputRelativePath: 'combat-reviews-weekend.mp4',
    qaVerdict: 'PASS',
    qaFailedChecks: [],
    originality: { riskLevel: 'LOW', blocked: false, requiresHumanReview: false },
    costEstimateCents: 0,
    costActualCents: 0,
    costBasis: 'NOT_METERED_BY_CLI',
    failureReason: null,
    fallbackReason: null,
    requiresHumanApproval: true,
    startedAt: '2026-07-27T00:00:00.000Z',
    completedAt: '2026-07-27T00:01:00.000Z',
  };
}

describe('the provenance safety guard', () => {
  it('accepts a well-formed record', () => {
    expect(() => assertRunProvenanceSafe(baseRecord())).not.toThrow();
  });

  it.each([
    ['apiKey', { apiKey: 'anything' }],
    ['DATABASE_URL', { DATABASE_URL: 'x' }],
    ['a transcript', { transcript: 'the voiceover said' }],
    ['a reference media path', { localPath: 'C:/analysis/ad.mp4' }],
    ['an agency name', { agency: 'Some Agency' }],
    ['a signed download URL field', { signedUrl: 'x' }],
  ])('refuses %s wherever it appears', (_label, extra) => {
    expect(() => assertRunProvenanceSafe({ ...baseRecord(), ...extra })).toThrow(
      UnsafeRunProvenanceError,
    );
  });

  it('refuses a credential-shaped value even under an innocent key', () => {
    // The field-name list cannot help here: the leak is in the *value*, and
    // this is the shape a provider error message actually arrives in.
    expect(() =>
      assertRunProvenanceSafe({
        ...baseRecord(),
        failureReason: 'connect failed for postgresql://user:hunter2@localhost:5432/db',
      }),
    ).toThrow(/PostgreSQL connection string/);

    expect(() =>
      assertRunProvenanceSafe({ ...baseRecord(), failureReason: 'bad key sk-ant-abc123def456' }),
    ).toThrow(/Anthropic API key/);

    expect(() =>
      assertRunProvenanceSafe({
        ...baseRecord(),
        outputRelativePath: 'out.mp4?X-Amz-Signature=deadbeefdeadbeef',
      }),
    ).toThrow(/signed storage URL/);
  });

  it('refuses a path into derived reference analysis', () => {
    expect(() =>
      assertRunProvenanceSafe({
        ...baseRecord(),
        failureReason: 'could not read .aamp-reference-analysis/scene-3.mp4',
      }),
    ).toThrow(/derived reference analysis/);
  });

  it('reports every violation at once', () => {
    try {
      assertRunProvenanceSafe({ ...baseRecord(), apiKey: 'x', transcript: 'y' });
      expect.unreachable('expected a refusal');
    } catch (error) {
      expect((error as UnsafeRunProvenanceError).violations).toHaveLength(2);
    }
  });

  it('walks into nested arrays and objects rather than only the top level', () => {
    expect(() =>
      assertRunProvenanceSafe({
        ...baseRecord(),
        providers: [{ role: 'storage', identity: 'minio', secretKey: 'leaked' }],
      }),
    ).toThrow(/providers\[0\]\.secretKey/);
  });
});

describe('the self-checksum', () => {
  it('seals a record and verifies it', () => {
    const sealed = sealRunProvenance(baseRecord());
    expect(sealed.provenanceChecksumSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyRunProvenance(sealed)).toBe(true);
  });

  it('detects an edit to any governing field', () => {
    const sealed = sealRunProvenance(baseRecord());
    expect(verifyRunProvenance({ ...sealed, executionMode: 'PRODUCTION' })).toBe(false);
    expect(verifyRunProvenance({ ...sealed, qaVerdict: 'FAIL' })).toBe(false);
  });

  it('is stable across key ordering, so two runs of the same shape agree', () => {
    const record = baseRecord();
    const reordered = Object.fromEntries(
      Object.entries(record).reverse(),
    ) as unknown as typeof record;
    expect(computeProvenanceChecksum(reordered)).toBe(computeProvenanceChecksum(record));
  });

  it('refuses to seal an unsafe record rather than checksumming a leak', () => {
    expect(() => sealRunProvenance({ ...baseRecord(), apiKey: 'x' } as never)).toThrow(
      UnsafeRunProvenanceError,
    );
  });
});

describe('writing the record', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'aamp-provenance-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  });

  it('writes the sealed record and leaves no partial file behind', async () => {
    const sealed = sealRunProvenance(baseRecord());
    const path = await writeRunProvenance(directory, sealed);

    expect(path.endsWith(RUN_PROVENANCE_FILENAME)).toBe(true);
    const parsed = JSON.parse(await readFile(path, 'utf8')) as AampRunProvenance;
    expect(verifyRunProvenance(parsed)).toBe(true);
    expect(await readdir(directory)).toEqual([RUN_PROVENANCE_FILENAME]);
  });

  it('refuses to write an unsafe record', async () => {
    const unsafe = { ...sealRunProvenance(baseRecord()), apiKey: 'leaked' } as AampRunProvenance;
    await expect(writeRunProvenance(directory, unsafe)).rejects.toThrow(UnsafeRunProvenanceError);
    expect(await readdir(directory)).toEqual([]);
  });
});
