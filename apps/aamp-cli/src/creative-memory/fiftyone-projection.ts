import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { listReferenceScenes, listReferences, type ReferenceDataSource } from '@combat/database';
import { NodeCommandRunner, type CommandRunner } from '@combat/media';

/**
 * Projects Creative Memory into a FiftyOne video dataset for human browsing.
 *
 * FiftyOne is a **disposable projection**, never the source of truth. Rights,
 * provenance, annotations and processing state live in PostgreSQL; this
 * exporter reads them and writes a dataset that can be deleted and rebuilt at
 * any time without losing anything. Treating a curation UI's database as the
 * rights record is how a "just for browsing" tool quietly becomes the thing
 * nobody dares delete.
 *
 * Projection is idempotent: the export is keyed by `referenceKey`, and the
 * generated loader replaces samples rather than appending, so re-running never
 * doubles a dataset. References that are no longer retrievable are exported
 * with `available: false` so a reviewer sees a withdrawal rather than a
 * silently vanished row.
 *
 * FiftyOne is a Python package and is **not installed by this repository**.
 * When it is absent, `launchCommand()` still returns the exact command to run,
 * and `assertFiftyOneAvailable` raises a typed, actionable error — ingestion
 * itself never depends on it.
 */

export const FIFTYONE_PINNED_VERSION = '1.0.1';
export const FIFTYONE_INSTALL_COMMAND = 'python -m pip install "fiftyone==1.0.1"';
export const FIFTYONE_DATASET_NAME = 'combat_creative_reference_library';

export class FiftyOneUnavailableError extends Error {
  constructor(detail: string) {
    super(
      [
        'FiftyOne is not available, so the reference browser cannot be launched.',
        `Install the pinned release: ${FIFTYONE_INSTALL_COMMAND}`,
        '',
        'Ingestion does not require FiftyOne — the projection files have still been written',
        'and can be loaded later.',
        '',
        `Detail: ${detail}`,
      ].join('\n'),
    );
    this.name = 'FiftyOneUnavailableError';
  }
}

/**
 * One projected sample. Field names and types are stable and documented,
 * because a FiftyOne dataset is browsed by humans who will build filters
 * against these names.
 */
export interface ProjectedSample {
  /** Absolute path to the *analysis proxy*, never the original reference file. */
  readonly filepath: string;
  readonly reference_key: string;
  readonly title: string;
  readonly brand: string;
  readonly agency: string | null;
  readonly platform: string | null;
  readonly publication_year: number | null;
  readonly rights_classification: string;
  readonly processing_state: string;
  readonly business_roles: string[];
  /** Always true. Present on every sample so a browsing reviewer cannot miss it. */
  readonly analysis_only: true;
  /** Always false. Reference material is never output-eligible. */
  readonly output_permitted: false;
  readonly available: boolean;
  readonly scene_count: number;
  readonly scenes: {
    readonly index: number;
    readonly start_seconds: number;
    readonly end_seconds: number;
    readonly duration_seconds: number;
  }[];
  readonly transferable_principle: string | null;
  readonly prohibited_direct_similarity: string | null;
}

export interface ProjectionResult {
  readonly datasetName: string;
  readonly samplesPath: string;
  readonly loaderPath: string;
  readonly sampleCount: number;
  readonly skippedLinkOnly: number;
}

export interface ProjectOptions {
  readonly db: ReferenceDataSource;
  readonly workspaceId: string;
  readonly outputDirectory: string;
  readonly datasetName?: string;
}

export async function projectToFiftyOne(options: ProjectOptions): Promise<ProjectionResult> {
  const datasetName = options.datasetName ?? FIFTYONE_DATASET_NAME;
  await mkdir(options.outputDirectory, { recursive: true });

  const references = await listReferences(options.db, options.workspaceId);
  const samples: ProjectedSample[] = [];
  let skippedLinkOnly = 0;

  for (const reference of references) {
    // A link-only reference has no media, so there is nothing for a video
    // dataset to show. Skipped rather than projected with a fabricated path.
    if (!reference.mediaAcquired) {
      skippedLinkOnly += 1;
      continue;
    }

    // eslint-disable-next-line no-await-in-loop -- projected in stable reference order
    const proxies = await options.db.referenceDerivedArtifact.findMany({
      where: {
        workspaceId: options.workspaceId,
        referenceAdvertisementId: reference.id,
        kind: 'PROXY',
      },
    });
    const proxy = proxies[0];
    if (!proxy) continue;

    // eslint-disable-next-line no-await-in-loop -- same ordering rationale
    const scenes = await listReferenceScenes(options.db, options.workspaceId, reference.id);
    // eslint-disable-next-line no-await-in-loop -- same ordering rationale
    const annotations = await options.db.referenceAnnotation.findMany({
      where: { workspaceId: options.workspaceId, referenceAdvertisementId: reference.id },
      orderBy: { version: 'desc' },
    });
    const latest = annotations[0];

    samples.push({
      filepath: proxy.localPath,
      reference_key: reference.referenceKey,
      title: reference.title,
      brand: reference.brand,
      agency: reference.agency ?? null,
      platform: reference.platform ?? null,
      publication_year: reference.publicationYear ?? null,
      rights_classification: 'ANALYSIS_SIDE',
      processing_state: reference.processingState,
      business_roles: [...reference.businessRoles],
      analysis_only: true,
      output_permitted: false,
      // A failed or withdrawn reference is exported as unavailable rather than
      // dropped, so a reviewer sees the withdrawal.
      available: reference.processingState !== 'FAILED',
      scene_count: scenes.length,
      scenes: scenes.map((scene) => ({
        index: scene.sceneIndex,
        start_seconds: scene.startSeconds,
        end_seconds: scene.endSeconds,
        duration_seconds: scene.durationSeconds,
      })),
      transferable_principle: (latest?.transferablePrinciple as string) ?? null,
      prohibited_direct_similarity: (latest?.prohibitedDirectSimilarity as string) ?? null,
    });
  }

  const samplesPath = join(options.outputDirectory, 'fiftyone-samples.json');
  await writeFile(samplesPath, `${JSON.stringify({ datasetName, samples }, null, 2)}\n`, 'utf8');

  const loaderPath = join(options.outputDirectory, 'load_reference_library.py');
  await writeFile(loaderPath, buildLoaderScript(datasetName), 'utf8');

  return {
    datasetName,
    samplesPath,
    loaderPath,
    sampleCount: samples.length,
    skippedLinkOnly,
  };
}

/**
 * The generated loader.
 *
 * Written as a file rather than executed: this repository does not run Python,
 * and the operator should be able to read what will touch their FiftyOne
 * install before it does. Deletes samples whose `reference_key` is no longer
 * exported, which is what makes re-projection idempotent rather than additive.
 */
function buildLoaderScript(datasetName: string): string {
  return `"""Load the Combat Creative reference library into FiftyOne.

Generated by \`pnpm aamp:reference project\`. Safe to re-run: samples are keyed
by reference_key and replaced, and keys no longer exported are removed.

PostgreSQL remains the canonical record for rights, provenance and annotations.
This dataset is a disposable browsing projection — deleting it loses nothing.

    ${FIFTYONE_INSTALL_COMMAND}
    python load_reference_library.py
    # then: fiftyone app launch ${datasetName}
"""

import json
import os

import fiftyone as fo

HERE = os.path.dirname(os.path.abspath(__file__))

with open(os.path.join(HERE, "fiftyone-samples.json"), "r", encoding="utf-8") as handle:
    payload = json.load(handle)

dataset_name = payload["datasetName"]
dataset = (
    fo.load_dataset(dataset_name)
    if fo.dataset_exists(dataset_name)
    else fo.Dataset(dataset_name, persistent=True)
)

exported_keys = {sample["reference_key"] for sample in payload["samples"]}

# Idempotence: drop anything previously projected that is no longer exported.
stale = [
    sample.id
    for sample in dataset
    if sample.has_field("reference_key") and sample["reference_key"] not in exported_keys
]
if stale:
    dataset.delete_samples(stale)

existing = {
    sample["reference_key"]: sample.id
    for sample in dataset
    if sample.has_field("reference_key")
}

new_samples = []
for record in payload["samples"]:
    if record["reference_key"] in existing:
        dataset.delete_samples([existing[record["reference_key"]]])

    sample = fo.Sample(filepath=record["filepath"])
    for field, value in record.items():
        if field == "filepath":
            continue
        if field == "scenes":
            sample["scenes"] = [
                fo.TemporalDetection(
                    label=f"scene-{scene['index']}",
                    support=[scene["start_seconds"], scene["end_seconds"]],
                )
                for scene in value
            ]
            continue
        sample[field] = value
    new_samples.append(sample)

if new_samples:
    dataset.add_samples(new_samples)

dataset.save()
print(f"projected {len(new_samples)} reference(s) into '{dataset_name}'")
print("ANALYSIS ONLY - no reference in this dataset is permitted in any produced advertisement")
`;
}

/** Exact commands an operator runs to review the library locally. */
export function launchCommand(projection: ProjectionResult): string[] {
  return [
    FIFTYONE_INSTALL_COMMAND,
    `python "${projection.loaderPath}"`,
    `fiftyone app launch ${projection.datasetName}`,
  ];
}

/**
 * Confirms FiftyOne can actually be imported. Never called during ingestion —
 * only when the operator explicitly asks to launch the browser.
 */
export async function assertFiftyOneAvailable(
  runner: CommandRunner = new NodeCommandRunner(),
  pythonExecutable = 'python',
): Promise<void> {
  try {
    await runner.run(pythonExecutable, ['-c', 'import fiftyone'], { timeoutMs: 120_000 });
  } catch (error) {
    throw new FiftyOneUnavailableError(error instanceof Error ? error.message : String(error));
  }
}
