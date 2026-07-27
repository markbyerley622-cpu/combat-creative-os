import {
  MEDIA_ACQUISITION_NOTICE,
  requiresAttribution,
  type AcquiredProductionAsset,
  type MediaAcquisitionRun,
} from '@combat/providers';

import { SOURCE_QUALITY_PROFILE_VERSION } from './source-quality';

/**
 * The five evidence artefacts a campaign carries.
 *
 * Their job is to make one question answerable months later, by somebody who
 * was not there: *where did this frame come from and who said we could use it?*
 * The chain they preserve runs finished MP4 → production manifest → asset id →
 * acquired asset → candidate → provider asset → landing page → creator →
 * licence → named approver → downloaded checksum.
 *
 * Not one of them holds a credential, a signed URL, a local path or a byte of
 * media. `assertMediaArtefactSafe` walks all of them before they are written —
 * see `writeRunArtefact`, which is the only writer.
 *
 * `CREDITS.md` is the one an operator actually publishes. It lists only the
 * assets whose licence *compels* a credit, plus a courtesy section for the ones
 * that merely deserve one, because a credits file that lists everything is a
 * credits file nobody reads.
 */

/**
 * The canonical record of what was acquired.
 *
 * The four reports below are *projections* of this file — each answers one
 * question for one reader. This is the one `build-manifest` reads, so the
 * manifest is never reconstructed by recombining three partial views that could
 * disagree with each other.
 */
export const ACQUIRED_ASSETS_FILENAME = 'acquired-assets.json';

export const REPORT_FILENAMES = {
  credits: 'credits.json',
  creditsMarkdown: 'CREDITS.md',
  rights: 'rights-report.json',
  provenance: 'acquisition-provenance.json',
  sourceQuality: 'source-quality-report.json',
} as const;

export interface ReportInput {
  readonly run: MediaAcquisitionRun;
  readonly assets: readonly AcquiredProductionAsset[];
  readonly campaignId?: string;
  readonly manifestPath?: string;
  readonly now: Date;
}

export interface CreditEntry {
  readonly assetId: string;
  readonly candidateId: string;
  readonly provider: string;
  readonly creator: string;
  readonly declaredLicence: string;
  readonly licenceUrl: string | null;
  readonly landingPageUrl: string;
  readonly attribution: string;
  readonly attributionRequired: boolean;
}

export function buildCredits(input: ReportInput): {
  readonly creditsVersion: 1;
  readonly runId: string;
  readonly campaignId: string | null;
  readonly generatedAt: string;
  readonly notice: string;
  readonly entries: readonly CreditEntry[];
} {
  const entries: CreditEntry[] = input.assets.map((asset) => ({
    assetId: asset.assetId,
    candidateId: asset.candidateId,
    provider: asset.provider,
    creator: asset.rights.creator,
    declaredLicence: asset.rights.declaredLicence,
    licenceUrl: asset.rights.licenceUrl ?? null,
    landingPageUrl: asset.landingPageUrl,
    attribution:
      asset.rightsDecision.requiredAttribution ??
      asset.rights.attributionText ??
      `${asset.rights.creator} — ${asset.rights.declaredLicence}`,
    attributionRequired: requiresAttribution(asset.rights.licenceFamily),
  }));

  return {
    creditsVersion: 1,
    runId: input.run.runId,
    campaignId: input.campaignId ?? null,
    generatedAt: input.now.toISOString(),
    notice: MEDIA_ACQUISITION_NOTICE,
    // Sorted by asset id so two runs over the same library produce identical
    // credits, which is what makes a diff of this file meaningful.
    entries: [...entries].sort((a, b) => a.assetId.localeCompare(b.assetId)),
  };
}

function escapeMarkdown(text: string): string {
  // Pipes would break the table; backslashes and brackets would turn a creator
  // name into a link. A credit line is prose supplied by a third party.
  return text.replace(/[|\\]/g, ' ').replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim();
}

export function buildCreditsMarkdown(input: ReportInput): string {
  const credits = buildCredits(input);
  const required = credits.entries.filter((entry) => entry.attributionRequired);
  const courtesy = credits.entries.filter((entry) => !entry.attributionRequired);

  const lines: string[] = [
    '# Credits',
    '',
    `Generated ${credits.generatedAt} from acquisition run \`${credits.runId}\`.`,
    ...(credits.campaignId ? [`Campaign: \`${credits.campaignId}\`.`] : []),
    '',
    '> ' + MEDIA_ACQUISITION_NOTICE,
    '',
  ];

  lines.push('## Attribution required by licence', '');
  if (required.length === 0) {
    lines.push('_None of the acquired material carries a licence that compels a credit._', '');
  } else {
    lines.push('| Credit | Licence | Source |', '| --- | --- | --- |');
    for (const entry of required) {
      lines.push(
        `| ${escapeMarkdown(entry.attribution)} | ${escapeMarkdown(entry.declaredLicence)}${
          entry.licenceUrl ? ` (${entry.licenceUrl})` : ''
        } | ${entry.landingPageUrl} |`,
      );
    }
    lines.push('');
  }

  lines.push('## Courtesy credits', '');
  if (courtesy.length === 0) {
    lines.push('_None._', '');
  } else {
    lines.push(
      'These licences do not compel a credit. They are listed because naming the person who made the work costs nothing and is the difference between "we believe this is licensed" and a record of where it came from.',
      '',
      '| Credit | Licence | Source |',
      '| --- | --- | --- |',
    );
    for (const entry of courtesy) {
      lines.push(
        `| ${escapeMarkdown(entry.attribution)} | ${escapeMarkdown(entry.declaredLicence)} | ${entry.landingPageUrl} |`,
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * The rights position of every acquired asset, plus the decisions behind it.
 *
 * Deliberately verbose. The reader of this file is somebody being asked whether
 * a published advertisement was lawful, and a summary that omitted the review
 * reasons would be the summary that made the answer unavailable.
 */
export function buildRightsReport(input: ReportInput): Record<string, unknown> {
  return {
    rightsReportVersion: 1,
    runId: input.run.runId,
    campaignId: input.campaignId ?? null,
    generatedAt: input.now.toISOString(),
    notice: MEDIA_ACQUISITION_NOTICE,
    requiresHumanApproval: true,
    anyReferenceMaterialIncluded: false,
    assets: input.assets.map((asset) => ({
      assetId: asset.assetId,
      candidateId: asset.candidateId,
      provider: asset.provider,
      providerAssetId: asset.providerAssetId,
      landingPageUrl: asset.landingPageUrl,
      creator: asset.rights.creator,
      declaredLicence: asset.rights.declaredLicence,
      licenceFamily: asset.rights.licenceFamily,
      licenceUrl: asset.rights.licenceUrl ?? null,
      commercialUse: asset.rights.commercialUse,
      derivativeUse: asset.rights.derivativeUse,
      paidAdvertisingUse: asset.rights.paidAdvertisingUse,
      recognizablePersonRisk: asset.rights.recognizablePersonRisk,
      trademarkOrLogoRisk: asset.rights.trademarkOrLogoRisk,
      endorsementRisk: asset.rights.endorsementRisk,
      modelReleaseStatus: asset.rights.modelReleaseStatus,
      propertyReleaseStatus: asset.rights.propertyReleaseStatus,
      sourceRestrictions: asset.rights.sourceRestrictions,
      policy: {
        outcome: asset.rightsDecision.outcome,
        version: asset.rightsDecision.policyVersion,
        reasons: asset.rightsDecision.reasons,
        requiredAttribution: asset.rightsDecision.requiredAttribution ?? null,
      },
      approval: {
        approvedBy: asset.approval.approvedBy,
        approvedUsages: asset.approval.approvedUsages,
        approvedPlatforms: asset.approval.approvedPlatforms,
        effectiveDate: asset.approval.effectiveDate,
        expiresAt: asset.approval.expiresAt ?? null,
        approvedAt: asset.approval.approvedAt,
        notes: asset.approval.notes,
        evidenceReferences: asset.approval.evidenceReferences,
      },
    })),
  };
}

/**
 * The chain from a delivered file back to its origin.
 *
 * `downloadHost` rather than a download URL, and no local path anywhere: a
 * provider's direct file URL is frequently signed, and an absolute path names a
 * machine. What survives is everything an auditor needs and nothing an attacker
 * could replay.
 */
export function buildAcquisitionProvenance(input: ReportInput): Record<string, unknown> {
  return {
    acquisitionProvenanceVersion: 1,
    runId: input.run.runId,
    workspaceId: input.run.workspaceId,
    campaignId: input.campaignId ?? null,
    productionManifest: input.manifestPath ?? null,
    origin: input.run.origin,
    providersQueried: input.run.providersQueried,
    generatedAt: input.now.toISOString(),
    paidProviderCalls: 0,
    requiresHumanApproval: true,
    notice: MEDIA_ACQUISITION_NOTICE,
    assets: input.assets.map((asset) => ({
      assetId: asset.assetId,
      relativePath: asset.relativePath,
      checksumSha256: asset.checksumSha256,
      fileSizeBytes: asset.fileSizeBytes,
      candidateId: asset.candidateId,
      provider: asset.provider,
      providerAssetId: asset.providerAssetId,
      landingPageUrl: asset.landingPageUrl,
      creator: asset.rights.creator,
      declaredLicence: asset.rights.declaredLicence,
      approvedBy: asset.approval.approvedBy,
      approvedAt: asset.approval.approvedAt,
      downloadHost: asset.downloadHost,
      downloadedAt: asset.downloadedAt,
      lifecycleState: asset.state,
      measuredWidthPx: asset.measurements.widthPx,
      measuredHeightPx: asset.measurements.heightPx,
      measuredDurationSeconds: asset.measurements.durationSeconds,
    })),
  };
}

/**
 * What was measured, what was not, and what a person still has to look at.
 *
 * `humanChecksRequired` travels on every asset rather than on the suspicious
 * ones, because a check that appears selectively reads as an accusation instead
 * of a checklist — and because no measurement establishes whether there is a
 * watermark in the corner.
 */
export function buildSourceQualityReport(input: ReportInput): Record<string, unknown> {
  return {
    sourceQualityReportVersion: 1,
    runId: input.run.runId,
    profileVersion: SOURCE_QUALITY_PROFILE_VERSION,
    generatedAt: input.now.toISOString(),
    notice:
      'Every value here was measured from the delivered bytes with ffprobe and FFmpeg. None is a declared or catalogued figure. This profile makes no claim about cinematic quality — there is no reliable machine measurement of lighting, subject separation or composition, so none is reported, and humanChecksRequired names what a person must still judge.',
    assets: input.assets.map((asset) => ({
      assetId: asset.assetId,
      candidateId: asset.candidateId,
      outcome: asset.qualityDecision.outcome,
      scores: asset.qualityDecision.scores,
      reasons: asset.qualityDecision.reasons,
      humanChecksRequired: asset.qualityDecision.humanChecksRequired,
      measurements: asset.measurements,
    })),
  };
}
