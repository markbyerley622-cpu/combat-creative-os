import type { CampaignDataSource, PerformanceDataSource } from '@combat/database';
import {
  ingestPerformanceObservation,
  InvalidPerformanceMetricsError,
  OpenReportingWindowError,
} from '@combat/database';
import type { PerformanceSource, RawPerformanceMetrics } from '@combat/domain';

export interface PerformanceObservationInput {
  readonly platform: 'TIKTOK' | 'INSTAGRAM_REELS' | 'YOUTUBE_SHORTS' | 'GENERIC';
  readonly externalPostId: string;
  readonly externalAccountId?: string;
  readonly creativeVariantId?: string;
  readonly variantAssetId?: string;
  readonly durationSeconds?: number;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly raw: RawPerformanceMetrics;
}

export interface IngestPerformanceObservationsInput {
  readonly workspaceId: string;
  readonly campaignId: string;
  readonly source: PerformanceSource;
  readonly observations: readonly PerformanceObservationInput[];
  readonly ingestedByUserId?: string;
  readonly fixtureRef?: string;
  /** Injected so ingestion stays deterministic under test; defaults to now. */
  readonly now?: Date;
}

export interface IngestedObservationSummary {
  readonly observationId: string;
  readonly externalPostId: string;
  readonly alreadyExisted: boolean;
}

export type IngestPerformanceObservationsOutput =
  | {
      readonly ok: true;
      readonly ingested: number;
      readonly deduplicated: number;
      readonly observations: readonly IngestedObservationSummary[];
    }
  | { readonly ok: false; readonly reason: 'CAMPAIGN_NOT_FOUND'; readonly detail: string }
  | {
      readonly ok: false;
      readonly reason: 'INVALID_METRICS';
      readonly externalPostId: string;
      readonly detail: string;
    }
  | {
      readonly ok: false;
      readonly reason: 'OPEN_WINDOW';
      readonly externalPostId: string;
      readonly detail: string;
    };

export interface IngestPerformanceObservationsActivityDeps {
  readonly campaignDb: CampaignDataSource;
  readonly performanceDb: PerformanceDataSource;
}

/**
 * M13: ingests a batch of closed-window performance observations from a
 * deterministic fixture or a manual entry.
 *
 * **No platform connector is involved.** There is no ad-platform API client, no
 * scraper and no credential anywhere in M13 — `source` is `FIXTURE` or
 * `MANUAL_ENTRY` only. A real connector is deferred (docs/architecture.md §8's
 * M13 entry) and would land as an additional `PerformanceSource` feeding this
 * same Activity, without changing normalization, confidence or learning.
 *
 * The whole batch is refused on the first invalid or still-open entry rather
 * than partially applied, so a fixture either loads or it doesn't. Individual
 * entries are idempotent on `(post, platform, window)`, which is what makes
 * re-running a fixture a no-op.
 */
export function createIngestPerformanceObservationsActivity(
  deps: IngestPerformanceObservationsActivityDeps,
): (input: IngestPerformanceObservationsInput) => Promise<IngestPerformanceObservationsOutput> {
  return async function ingestPerformanceObservationsActivity(
    input: IngestPerformanceObservationsInput,
  ): Promise<IngestPerformanceObservationsOutput> {
    const { workspaceId, campaignId } = input;
    const now = input.now ?? new Date();

    const campaign = await deps.campaignDb.campaign.findFirst({
      where: { id: campaignId, workspaceId },
    });
    if (!campaign) {
      return {
        ok: false,
        reason: 'CAMPAIGN_NOT_FOUND',
        detail: `Campaign ${campaignId} not found in workspace ${workspaceId}`,
      };
    }

    const summaries: IngestedObservationSummary[] = [];
    for (const entry of input.observations) {
      try {
        // eslint-disable-next-line no-await-in-loop -- small, per-batch set; sequential keeps dedup deterministic
        const { observation, alreadyExisted } = await ingestPerformanceObservation(
          deps.performanceDb,
          workspaceId,
          {
            subject: {
              platform: entry.platform,
              externalPostId: entry.externalPostId,
              externalAccountId: entry.externalAccountId,
              campaignId,
              creativeVariantId: entry.creativeVariantId,
              variantAssetId: entry.variantAssetId,
              durationSeconds: entry.durationSeconds,
            },
            source: input.source,
            periodStart: new Date(entry.periodStart),
            periodEnd: new Date(entry.periodEnd),
            raw: entry.raw,
            ingestedByUserId: input.ingestedByUserId,
            fixtureRef: input.fixtureRef,
            now,
          },
        );
        summaries.push({
          observationId: observation.id,
          externalPostId: entry.externalPostId,
          alreadyExisted,
        });
      } catch (error) {
        if (error instanceof OpenReportingWindowError) {
          return {
            ok: false,
            reason: 'OPEN_WINDOW',
            externalPostId: entry.externalPostId,
            detail: error.message,
          };
        }
        if (error instanceof InvalidPerformanceMetricsError) {
          return {
            ok: false,
            reason: 'INVALID_METRICS',
            externalPostId: entry.externalPostId,
            detail: error.message,
          };
        }
        throw error;
      }
    }

    return {
      ok: true,
      ingested: summaries.filter((s) => !s.alreadyExisted).length,
      deduplicated: summaries.filter((s) => s.alreadyExisted).length,
      observations: summaries,
    };
  };
}
