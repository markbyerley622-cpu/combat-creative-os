import { createHash } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { canonicalJson } from '@combat/domain';

import type {
  AampExecutionMode,
  DependencyEvidence,
  ExecutionModeLabel,
} from './aamp-execution-mode';
import type { ProviderIdentity } from './provider-identity';

/**
 * The durable record of what a run actually did.
 *
 * **Why a checksummed artefact rather than a new table.** Every existing
 * campaign-lifecycle table (`AgentInvocation`, `RenderJob`, `QualityAssessment`)
 * is keyed to a `Campaign` row that only the workflow path creates, and those
 * rows drive the three human approval gates. Fabricating campaign rows so a CLI
 * run had somewhere to hang provenance would put records the workflow never
 * made into the tables the gates read — a worse outcome than the one it solves.
 * So the run record is written to the run directory, canonically serialised and
 * self-checksummed, and it *references* the PostgreSQL rows that are already
 * canonical (benchmark profile id and version, reference ids, annotation ids)
 * rather than copying them. `docs/architecture.md` §8 records this decision.
 *
 * **What is deliberately absent.** No credential, no signed URL, no reference
 * media byte, no transcript, no advertising copy taken from a reference, and no
 * agency name. `assertRunProvenanceSafe` walks the serialised record and fails
 * closed, so a field added later cannot quietly start carrying one.
 */

export const RUN_PROVENANCE_VERSION = 1 as const;

export interface RetrievalEvidenceRecord {
  readonly agentRole: string;
  readonly shotIndex?: number;
  readonly planKey: string;
  readonly planVersion: number;
  readonly benchmarkProfileId: string | null;
  readonly benchmarkProfileName: string | null;
  readonly benchmarkProfileVersion: number | null;
  readonly governingChecksumSha256: string | null;
  readonly queryHash: string | null;
  readonly contextHash: string | null;
  readonly retrievalProfile: string | null;
  readonly rerankingProfile: string | null;
  readonly fallbackStatus: string | null;
  readonly qdrantCollection: string | null;
  readonly governanceDecision: string;
  readonly notUsedReason?: string;
  readonly items: readonly {
    readonly referenceId: string;
    readonly annotationId: string;
    readonly annotationVersion: number;
    readonly sceneId: string;
    readonly retrievalScore: number;
    readonly rerankScore: number;
    readonly finalRank: number;
  }[];
  /** Always false, always written — never left to be inferred from an absence. */
  readonly anyReferenceOutputEligible: false;
}

export interface AampRunProvenance {
  readonly provenanceVersion: typeof RUN_PROVENANCE_VERSION;
  readonly workspaceId: string;
  readonly campaignId: string;
  readonly campaignName: string;
  readonly workflowRunId: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  /** sha256 over the canonical campaign request. Two runs of the same brief agree. */
  readonly requestHashSha256: string;
  readonly promptSha256: string;

  readonly requestedExecutionMode: AampExecutionMode | null;
  readonly executionMode: AampExecutionMode;
  readonly evidence: DependencyEvidence;
  readonly label: ExecutionModeLabel;
  readonly providers: readonly ProviderIdentity[];

  readonly creativeMemoryMode: string;
  readonly retrievals: readonly RetrievalEvidenceRecord[];

  readonly agents: readonly string[];
  readonly reasoningProvider: string;
  readonly reasoningModel: string;
  readonly generationProvider: string | null;
  readonly generationProfile: string | null;
  readonly renderProvider: string;
  readonly renderProviderVersion: string;

  readonly outputChecksumSha256: string | null;
  readonly outputRelativePath: string | null;
  readonly qaVerdict: string | null;
  readonly qaFailedChecks: readonly string[];
  readonly originality: {
    readonly riskLevel: string;
    readonly blocked: boolean;
    readonly requiresHumanReview: boolean;
  } | null;

  readonly costEstimateCents: number;
  readonly costActualCents: number;
  readonly costBasis: string;

  readonly failureReason: string | null;
  readonly fallbackReason: string | null;
  readonly requiresHumanApproval: true;
  readonly startedAt: string;
  readonly completedAt: string;
  /** sha256 of the canonical form of every other field. Recomputable, so tampering shows. */
  readonly provenanceChecksumSha256: string;
}

export class UnsafeRunProvenanceError extends Error {
  constructor(
    public readonly violations: readonly string[],
    where: string,
  ) {
    super(
      `${where} carries material that must never be persisted:\n  - ${violations.join('\n  - ')}`,
    );
    this.name = 'UnsafeRunProvenanceError';
  }
}

/**
 * Keys a provenance record must never contain, at any depth.
 *
 * The reference-side entries matter as much as the credential ones: a
 * `localPath` or a `transcript` in this file would put analysis-only material
 * into an artefact that ships beside a deliverable, which is exactly the
 * separation the reference rules exist to keep.
 */
export const PROVENANCE_FORBIDDEN_KEYS: readonly string[] = [
  'apiKey',
  'api_key',
  'ANTHROPIC_API_KEY',
  'QDRANT_API_KEY',
  'COMFYUI_API_KEY',
  'CREATIVE_MEMORY_EMBEDDING_API_KEY',
  'DATABASE_URL',
  'databaseUrl',
  'connectionString',
  'secret',
  'secretKey',
  'password',
  'token',
  'authorization',
  'signedUrl',
  'presignedUrl',
  'downloadUrl',
  'uploadUrl',
  'transcript',
  'transcriptText',
  'referenceMediaPath',
  'referenceLocalPath',
  'localPath',
  'advertisingCopy',
  'agency',
  'agencyName',
];

/**
 * Value shapes that betray a leak regardless of the key they sit under.
 *
 * Two of these are worth stating explicitly. A `postgres://` string is a
 * credential even when the field is called `note`; and an AWS or MinIO
 * signature query parameter is what makes a "temporary" URL a durable secret
 * once it lands in a committed-adjacent file.
 */
const FORBIDDEN_VALUE_PATTERNS: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  { pattern: /postgres(?:ql)?:\/\//i, why: 'a PostgreSQL connection string' },
  { pattern: /\bsk-ant-[A-Za-z0-9_-]+/, why: 'an Anthropic API key' },
  { pattern: /[?&]X-Amz-Signature=/i, why: 'a signed storage URL' },
  { pattern: /[?&](?:signature|sig|token)=[A-Za-z0-9%_-]{16,}/i, why: 'a signed URL' },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, why: 'a private key' },
  { pattern: /\.aamp-reference-analysis[\\/]/i, why: 'a path into derived reference analysis' },
];

/**
 * Walks the record and refuses anything that must not be persisted.
 *
 * Fails closed and reports every violation rather than the first, because the
 * response to "this leaked" is to fix the shape, and a one-at-a-time report
 * makes that several rounds instead of one.
 */
export function assertRunProvenanceSafe(record: unknown, where = 'run provenance'): void {
  const violations: string[] = [];

  const walk = (value: unknown, path: string): void => {
    if (value === null || value === undefined) return;
    if (typeof value === 'string') {
      for (const { pattern, why } of FORBIDDEN_VALUE_PATTERNS) {
        if (pattern.test(value)) violations.push(`${path || '<root>'} looks like ${why}`);
      }
      return;
    }
    if (typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(entry, `${path}[${index}]`));
      return;
    }
    for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
      if (PROVENANCE_FORBIDDEN_KEYS.includes(key)) {
        violations.push(`${path ? `${path}.` : ''}${key} is a forbidden field`);
        continue;
      }
      walk(member, path ? `${path}.${key}` : key);
    }
  };

  walk(record, '');
  if (violations.length > 0) throw new UnsafeRunProvenanceError(violations, where);
}

export function sha256Of(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** The checksum over every field except the checksum itself. */
export function computeProvenanceChecksum(
  record: Omit<AampRunProvenance, 'provenanceChecksumSha256'>,
): string {
  return sha256Of(canonicalJson(record));
}

export function sealRunProvenance(
  record: Omit<AampRunProvenance, 'provenanceChecksumSha256'>,
): AampRunProvenance {
  assertRunProvenanceSafe(record);
  return { ...record, provenanceChecksumSha256: computeProvenanceChecksum(record) };
}

/** True when the record's own checksum still matches its contents. */
export function verifyRunProvenance(record: AampRunProvenance): boolean {
  const { provenanceChecksumSha256, ...rest } = record;
  return computeProvenanceChecksum(rest) === provenanceChecksumSha256;
}

export const RUN_PROVENANCE_FILENAME = 'aamp-run-provenance.json';

/**
 * Writes the record, via a temporary file and a rename.
 *
 * A provenance file truncated by a crash mid-write is worse than an absent one:
 * it parses far enough to look authoritative and then disagrees with its own
 * checksum for a reason nobody can reconstruct.
 */
export async function writeRunProvenance(
  runDirectory: string,
  record: AampRunProvenance,
): Promise<string> {
  assertRunProvenanceSafe(record, 'run provenance');
  const target = join(runDirectory, RUN_PROVENANCE_FILENAME);
  await mkdir(dirname(target), { recursive: true });
  const temporary = join(dirname(target), `.${basename(target)}.partial`);
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  await rename(temporary, target);
  return target;
}
