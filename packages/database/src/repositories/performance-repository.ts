import type {
  PerformanceObservation,
  PerformanceSource,
  PerformanceSubject,
  RawPerformanceMetrics,
} from '@combat/domain';
import { normalizePerformanceMetrics, validateRawMetrics } from '@combat/domain';

export type PerformanceObservationRecord = PerformanceObservation;

/**
 * M13 persistence for ingested performance data. Every function takes
 * `workspaceId` first and folds it into the query (CLAUDE.md security rule);
 * an observation is never looked up by id alone.
 *
 * Observations are **immutable** — there is deliberately no `update`. A
 * corrected measurement is a new observation for a new window, so a learning's
 * evidence can never change out from under it after the fact.
 */
export interface PerformanceDataSource {
  performanceObservation: {
    create(args: {
      data: Omit<PerformanceObservationRecord, 'id' | 'createdAt'>;
    }): Promise<PerformanceObservationRecord>;
    findFirst(args: {
      where: { id: string; workspaceId: string } | { idempotencyKey: string; workspaceId: string };
    }): Promise<PerformanceObservationRecord | null>;
    findMany(args: {
      where: { workspaceId: string; campaignId?: string; creativeVariantId?: string };
    }): Promise<PerformanceObservationRecord[]>;
  };
}

/** Thrown when raw counters are internally inconsistent (a 300% CTR, conversions with no clicks). */
export class InvalidPerformanceMetricsError extends Error {
  constructor(public readonly violations: readonly { code: string; detail: string }[]) {
    super(`performance metrics are invalid: ${violations.map((v) => v.code).join(', ')}`);
    this.name = 'InvalidPerformanceMetricsError';
  }
}

/**
 * Thrown when the reporting window has not closed yet. A learning may only ever
 * be derived from **completed** performance data, so a still-open window is
 * refused at the persistence boundary rather than silently averaged in.
 */
export class OpenReportingWindowError extends Error {
  constructor(periodEnd: Date, now: Date) {
    super(
      `reporting window ends at ${periodEnd.toISOString()}, which has not elapsed as of ${now.toISOString()}`,
    );
    this.name = 'OpenReportingWindowError';
  }
}

export interface IngestPerformanceObservationInput {
  readonly subject: PerformanceSubject;
  readonly source: PerformanceSource;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly raw: RawPerformanceMetrics;
  /**
   * Caller-supplied dedup key. Omitted, one is derived from the subject +
   * window, which is what makes a repeated fixture load or a double-submitted
   * manual entry idempotent rather than duplicative.
   */
  readonly idempotencyKey?: string;
  readonly ingestedByUserId?: string;
  readonly fixtureRef?: string;
  /** Injected so ingestion stays deterministic under test; defaults to now. */
  readonly now?: Date;
}

/** Derived dedup key: one observation per (post, platform, window) unless the caller overrides it. */
export function performanceIdempotencyKey(
  subject: PerformanceSubject,
  periodStart: Date,
  periodEnd: Date,
): string {
  return [
    subject.platform,
    subject.externalPostId,
    periodStart.toISOString(),
    periodEnd.toISOString(),
  ].join('|');
}

/**
 * Idempotently ingests one closed-window observation. Validates the counters
 * and derives the normalized rates here — a caller never supplies a rate,
 * because a supplied rate cannot be checked against its own numerator and
 * denominator.
 */
export async function ingestPerformanceObservation(
  db: PerformanceDataSource,
  workspaceId: string,
  input: IngestPerformanceObservationInput,
): Promise<{ observation: PerformanceObservationRecord; alreadyExisted: boolean }> {
  const now = input.now ?? new Date();
  if (input.periodEnd > now) {
    throw new OpenReportingWindowError(input.periodEnd, now);
  }
  if (input.periodEnd <= input.periodStart) {
    throw new InvalidPerformanceMetricsError([
      { code: 'INVALID_WINDOW', detail: 'periodEnd must be after periodStart' },
    ]);
  }

  const violations = validateRawMetrics(input.raw);
  if (violations.length > 0) {
    throw new InvalidPerformanceMetricsError(violations);
  }

  const idempotencyKey =
    input.idempotencyKey ??
    performanceIdempotencyKey(input.subject, input.periodStart, input.periodEnd);

  const existing = await db.performanceObservation.findFirst({
    where: { idempotencyKey, workspaceId },
  });
  if (existing) return { observation: existing, alreadyExisted: true };

  const observation = await db.performanceObservation.create({
    data: {
      workspaceId,
      subject: input.subject,
      source: input.source,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      raw: input.raw,
      normalized: normalizePerformanceMetrics(input.raw),
      idempotencyKey,
      ingestedByUserId: input.ingestedByUserId,
      fixtureRef: input.fixtureRef,
    },
  });
  return { observation, alreadyExisted: false };
}

export async function getPerformanceObservation(
  db: PerformanceDataSource,
  workspaceId: string,
  id: string,
): Promise<PerformanceObservationRecord | undefined> {
  return (await db.performanceObservation.findFirst({ where: { id, workspaceId } })) ?? undefined;
}

/** Every observation for a campaign, newest window first. */
export async function listPerformanceObservationsForCampaign(
  db: PerformanceDataSource,
  workspaceId: string,
  campaignId: string,
): Promise<PerformanceObservationRecord[]> {
  const rows = await db.performanceObservation.findMany({ where: { workspaceId, campaignId } });
  return [...rows].sort((a, b) => b.periodEnd.getTime() - a.periodEnd.getTime());
}

export async function listPerformanceObservationsForVariant(
  db: PerformanceDataSource,
  workspaceId: string,
  creativeVariantId: string,
): Promise<PerformanceObservationRecord[]> {
  const rows = await db.performanceObservation.findMany({
    where: { workspaceId, creativeVariantId },
  });
  return [...rows].sort((a, b) => b.periodEnd.getTime() - a.periodEnd.getTime());
}
