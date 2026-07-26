#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

import {
  approveReferenceAnnotation,
  listReferenceScenes,
  listReferences,
  setReferenceState,
  type ReferenceDataSource,
} from '@combat/database';
import { ReferenceIngestionManifestV1Schema } from '@combat/domain';
import { NodeCommandRunner, resolveFfmpegBinaries, type CommandRunner } from '@combat/media';
import {
  FfmpegSceneDetectionProvider,
  PySceneDetectProvider,
  UnavailableTranscriptionProvider,
  WhisperCliTranscriptionProvider,
  type SceneDetectionProvider,
  type TranscriptionProvider,
} from '@combat/providers';

import { findRepositoryRoot } from '../generate-cli';
import { launchCommand, projectToFiftyOne } from './fiftyone-projection';
import { ingestReferences } from './ingest-references';

/**
 * `pnpm aamp:reference <command>` — the Creative Memory operator surface.
 *
 * Exit codes are distinct per failure class so a script can branch on what
 * went wrong. Rights failures in particular get their own code: "this manifest
 * claims permission it does not have" needs a different response from "this
 * file is missing", and collapsing them into a generic failure is how a rights
 * problem gets retried instead of escalated.
 */

export const REFERENCE_EXIT_CODES = {
  SUCCESS: 0,
  INVALID_MANIFEST: 2,
  INVALID_RIGHTS: 3,
  UNSAFE_PATH: 4,
  MISSING_MEDIA: 5,
  INSPECTION_FAILED: 6,
  SCENE_DETECTION_FAILED: 7,
  DERIVATION_FAILED: 8,
  TRANSCRIPTION_UNAVAILABLE: 9,
  PERSISTENCE_FAILED: 10,
} as const;
export type ReferenceExitCode = (typeof REFERENCE_EXIT_CODES)[keyof typeof REFERENCE_EXIT_CODES];

const FAILURE_EXIT: Readonly<Record<string, ReferenceExitCode>> = {
  INVALID_MANIFEST: REFERENCE_EXIT_CODES.INVALID_MANIFEST,
  INVALID_RIGHTS: REFERENCE_EXIT_CODES.INVALID_RIGHTS,
  UNSAFE_PATH: REFERENCE_EXIT_CODES.UNSAFE_PATH,
  MISSING_MEDIA: REFERENCE_EXIT_CODES.MISSING_MEDIA,
  INSPECTION_FAILED: REFERENCE_EXIT_CODES.INSPECTION_FAILED,
  SCENE_DETECTION_FAILED: REFERENCE_EXIT_CODES.SCENE_DETECTION_FAILED,
  DERIVATION_FAILED: REFERENCE_EXIT_CODES.DERIVATION_FAILED,
  TRANSCRIPTION_UNAVAILABLE: REFERENCE_EXIT_CODES.TRANSCRIPTION_UNAVAILABLE,
  DUPLICATE_REFERENCE: REFERENCE_EXIT_CODES.SUCCESS,
  PERSISTENCE_FAILED: REFERENCE_EXIT_CODES.PERSISTENCE_FAILED,
};

export interface ReferenceCliContext {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** Injected so tests run against the in-memory store rather than PostgreSQL. */
  readonly db: ReferenceDataSource;
  readonly runner?: CommandRunner;
  readonly sceneDetector?: SceneDetectionProvider;
  readonly transcriber?: TranscriptionProvider;
}

function usage(): string {
  return [
    'Usage: aamp:reference <command> [options]',
    '',
    'Commands:',
    '  ingest    --manifest <reference-manifest.json> [--analysis-dir <dir>] [--force] [--scene-clips]',
    '  register  --manifest <reference-manifest.json>     (link-only entries; acquires no media)',
    '  list      --workspace <uuid> [--state <STATE>] [--role <ROLE>]',
    '  inspect   --workspace <uuid> --reference <key>',
    '  approve   --workspace <uuid> --annotation <uuid>',
    '  project   --workspace <uuid> [--output-dir <dir>]  (FiftyOne projection)',
    '',
    'Reference material is analysis-only. No command here can make a reference',
    'usable in a produced advertisement.',
  ].join('\n');
}

interface ParsedArgs {
  readonly command: string;
  readonly values: Readonly<Record<string, string>>;
  readonly flags: ReadonlySet<string>;
}

export function parseReferenceArgs(argv: readonly string[]): ParsedArgs {
  const [command = '', ...rest] = argv;
  const values: Record<string, string> = {};
  const flags = new Set<string>();

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token?.startsWith('--')) continue;
    const name = token.slice(2);
    const next = rest[index + 1];
    if (next && !next.startsWith('--')) {
      values[name] = next;
      index += 1;
    } else {
      flags.add(name);
    }
  }
  return { command, values, flags };
}

export async function runReferenceCli(
  argv: readonly string[],
  context: ReferenceCliContext,
): Promise<number> {
  const { command, values, flags } = parseReferenceArgs(argv);
  const repositoryRoot = await findRepositoryRoot(context.cwd);
  const absolute = (candidate: string): string =>
    isAbsolute(candidate) ? candidate : resolve(repositoryRoot, candidate);

  switch (command) {
    case 'ingest':
    case 'register':
      return ingestCommand(
        values,
        flags,
        context,
        repositoryRoot,
        absolute,
        command === 'register',
      );
    case 'list':
      return listCommand(values, context);
    case 'inspect':
      return inspectCommand(values, context);
    case 'approve':
      return approveCommand(values, context);
    case 'project':
      return projectCommand(values, context, absolute, repositoryRoot);
    default:
      context.stderr(`${usage()}\n`);
      return REFERENCE_EXIT_CODES.INVALID_MANIFEST;
  }
}

async function ingestCommand(
  values: Readonly<Record<string, string>>,
  flags: ReadonlySet<string>,
  context: ReferenceCliContext,
  repositoryRoot: string,
  absolute: (candidate: string) => string,
  registerOnly: boolean,
): Promise<number> {
  const manifestArg = values.manifest;
  if (!manifestArg) {
    context.stderr(`${usage()}\n`);
    return REFERENCE_EXIT_CODES.INVALID_MANIFEST;
  }

  const manifestPath = absolute(manifestArg);
  let parsed;
  try {
    parsed = ReferenceIngestionManifestV1Schema.safeParse(
      JSON.parse(await readFile(manifestPath, 'utf8')),
    );
  } catch (error) {
    context.stderr(
      `Could not read reference manifest at ${manifestPath}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return REFERENCE_EXIT_CODES.INVALID_MANIFEST;
  }

  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `  - ${issue.path.join('.') || '<root>'}: ${issue.message}`,
    );
    context.stderr(`Reference manifest is invalid:\n${issues.join('\n')}\n`);
    // A rights problem is reported as a rights problem, not a generic
    // validation failure: the two need different human responses.
    const rightsProblem = parsed.error.issues.some(
      (issue) =>
        issue.path.includes('rightsClassification') ||
        issue.path.includes('permittedUses') ||
        issue.path.includes('prohibitedUses'),
    );
    return rightsProblem
      ? REFERENCE_EXIT_CODES.INVALID_RIGHTS
      : REFERENCE_EXIT_CODES.INVALID_MANIFEST;
  }

  const manifest = parsed.data;
  if (
    registerOnly &&
    manifest.references.some((entry) => entry.rightsClassification !== 'LINK_ONLY')
  ) {
    context.stderr(
      'register accepts LINK_ONLY entries only — use `ingest` for references with local media.\n',
    );
    return REFERENCE_EXIT_CODES.INVALID_RIGHTS;
  }

  const binaries = resolveFfmpegBinaries(context.env);
  const analysisDirectory = absolute(
    values['analysis-dir'] ?? context.env.REFERENCE_ANALYSIS_DIR ?? '.aamp-reference-analysis',
  );

  // PySceneDetect when the operator installed it; the FFmpeg detector
  // otherwise, so segmentation works with no extra dependency.
  let sceneDetector = context.sceneDetector;
  if (!sceneDetector) {
    const pySceneDetect = new PySceneDetectProvider();
    sceneDetector = (await pySceneDetect.isAvailable())
      ? pySceneDetect
      : new FfmpegSceneDetectionProvider(binaries, context.runner ?? new NodeCommandRunner());
  }

  const transcriber =
    context.transcriber ??
    (context.env.REFERENCE_WHISPER === '1'
      ? new WhisperCliTranscriptionProvider()
      : new UnavailableTranscriptionProvider(
          'transcription is optional and disabled; set REFERENCE_WHISPER=1 with a local whisper CLI to enable it',
        ));

  const result = await ingestReferences({
    manifest,
    manifestDir: dirname(manifestPath),
    db: context.db,
    sceneDetector,
    transcriber,
    binaries,
    referenceRoots: [repositoryRoot, dirname(manifestPath), analysisDirectory],
    analysisDirectory,
    ...(context.runner ? { runner: context.runner } : {}),
    ...(flags.has('force') ? { force: true } : {}),
    ...(flags.has('scene-clips') ? { extractSceneClips: true } : {}),
    onProgress: (message) => context.stderr(`  ${message}\n`),
  });

  context.stdout(
    `${JSON.stringify(
      {
        ingestionRunId: result.ingestionRunId,
        succeeded: result.succeededCount,
        failed: result.failedCount,
        skipped: result.skippedCount,
        sceneDetector: sceneDetector.name,
        transcriber: transcriber.name,
        outcomes: result.outcomes,
        notice:
          'ANALYSIS ONLY — ingestion grants no output rights. No reference here may appear in a produced advertisement.',
      },
      null,
      2,
    )}\n`,
  );

  const firstFailure = result.outcomes.find((outcome) => outcome.status === 'FAILED');
  if (firstFailure?.failureReason) {
    return FAILURE_EXIT[firstFailure.failureReason] ?? REFERENCE_EXIT_CODES.PERSISTENCE_FAILED;
  }
  return REFERENCE_EXIT_CODES.SUCCESS;
}

async function listCommand(
  values: Readonly<Record<string, string>>,
  context: ReferenceCliContext,
): Promise<number> {
  const workspaceId = values.workspace;
  if (!workspaceId) {
    context.stderr('list requires --workspace <uuid>\n');
    return REFERENCE_EXIT_CODES.INVALID_MANIFEST;
  }
  const references = await listReferences(context.db, workspaceId, {
    ...(values.state ? { processingState: values.state as never } : {}),
    ...(values.role ? { businessRole: values.role as never } : {}),
  });
  context.stdout(
    `${JSON.stringify(
      references.map((reference) => ({
        referenceKey: reference.referenceKey,
        title: reference.title,
        brand: reference.brand,
        agency: reference.agency ?? null,
        processingState: reference.processingState,
        businessRoles: reference.businessRoles,
        mediaAcquired: reference.mediaAcquired,
        outputPermitted: false,
      })),
      null,
      2,
    )}\n`,
  );
  return REFERENCE_EXIT_CODES.SUCCESS;
}

async function inspectCommand(
  values: Readonly<Record<string, string>>,
  context: ReferenceCliContext,
): Promise<number> {
  const workspaceId = values.workspace;
  const referenceKey = values.reference;
  if (!workspaceId || !referenceKey) {
    context.stderr('inspect requires --workspace <uuid> --reference <key>\n');
    return REFERENCE_EXIT_CODES.INVALID_MANIFEST;
  }

  const [reference] = await context.db.referenceAdvertisement.findMany({
    where: { workspaceId, referenceKey },
  });
  if (!reference) {
    context.stderr(`No reference "${referenceKey}" in workspace ${workspaceId}\n`);
    return REFERENCE_EXIT_CODES.MISSING_MEDIA;
  }

  const [scenes, metrics, derived, annotations] = await Promise.all([
    listReferenceScenes(context.db, workspaceId, reference.id),
    context.db.referenceCraftMetrics.findFirst({
      where: { workspaceId, referenceAdvertisementId: reference.id },
    }),
    context.db.referenceDerivedArtifact.findMany({
      where: { workspaceId, referenceAdvertisementId: reference.id },
    }),
    context.db.referenceAnnotation.findMany({
      where: { workspaceId, referenceAdvertisementId: reference.id },
      orderBy: { version: 'desc' },
    }),
  ]);

  context.stdout(
    `${JSON.stringify(
      {
        referenceKey: reference.referenceKey,
        processingState: reference.processingState,
        mediaAcquired: reference.mediaAcquired,
        outputPermitted: false,
        scenes: scenes.map((scene) => ({
          index: scene.sceneIndex,
          startSeconds: scene.startSeconds,
          endSeconds: scene.endSeconds,
          durationSeconds: scene.durationSeconds,
          detectionMethod: scene.detectionMethod,
        })),
        craftMetrics: metrics,
        derivedArtifacts: derived.map((artifact) => ({
          kind: artifact.kind,
          localPath: artifact.localPath,
          checksumSha256: artifact.checksumSha256,
          sourceChecksumSha256: artifact.sourceChecksumSha256,
          toolVersion: artifact.toolVersion,
          analysisOnly: artifact.analysisOnly,
        })),
        annotations,
      },
      (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
      2,
    )}\n`,
  );
  return REFERENCE_EXIT_CODES.SUCCESS;
}

async function approveCommand(
  values: Readonly<Record<string, string>>,
  context: ReferenceCliContext,
): Promise<number> {
  const workspaceId = values.workspace;
  const annotationId = values.annotation;
  if (!workspaceId || !annotationId) {
    context.stderr('approve requires --workspace <uuid> --annotation <uuid>\n');
    return REFERENCE_EXIT_CODES.INVALID_MANIFEST;
  }

  try {
    const annotation = await approveReferenceAnnotation(context.db, workspaceId, annotationId);
    // Approval advances the reference to retrievable. That still grants no
    // output rights — it means "a human has read this and the principle is
    // sound", nothing more.
    await setReferenceState(
      context.db,
      workspaceId,
      annotation.referenceAdvertisementId,
      'READY_FOR_RETRIEVAL',
    );
    context.stdout(
      `${JSON.stringify(
        {
          annotationId,
          approved: true,
          processingState: 'READY_FOR_RETRIEVAL',
          notice:
            'READY_FOR_RETRIEVAL means analysis is complete and reviewed. It does not permit output use.',
        },
        null,
        2,
      )}\n`,
    );
    return REFERENCE_EXIT_CODES.SUCCESS;
  } catch (error) {
    context.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return REFERENCE_EXIT_CODES.PERSISTENCE_FAILED;
  }
}

async function projectCommand(
  values: Readonly<Record<string, string>>,
  context: ReferenceCliContext,
  absolute: (candidate: string) => string,
  repositoryRoot: string,
): Promise<number> {
  const workspaceId = values.workspace;
  if (!workspaceId) {
    context.stderr('project requires --workspace <uuid>\n');
    return REFERENCE_EXIT_CODES.INVALID_MANIFEST;
  }

  const outputDirectory = absolute(
    values['output-dir'] ?? resolve(repositoryRoot, '.aamp-reference-analysis/_fiftyone'),
  );
  const projection = await projectToFiftyOne({
    db: context.db,
    workspaceId,
    outputDirectory,
  });

  context.stdout(
    `${JSON.stringify(
      {
        ...projection,
        launch: launchCommand(projection),
        notice:
          'FiftyOne is a disposable browsing projection. PostgreSQL remains canonical for rights, provenance and annotations.',
      },
      null,
      2,
    )}\n`,
  );
  return REFERENCE_EXIT_CODES.SUCCESS;
}
