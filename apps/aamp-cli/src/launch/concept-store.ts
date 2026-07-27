import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  LaunchConceptAssessmentSchema,
  LaunchConceptSelectionSchema,
  LaunchConceptVersionSchema,
  LaunchGateDecisionSchema,
  type LaunchConceptAssessment,
  type LaunchConceptSelection,
  type LaunchConceptVersion,
  type LaunchGateDecision,
} from '@combat/domain';
import type { z } from 'zod';

import {
  checksumOf,
  LaunchArtefactError,
  LaunchConceptLedgerSchema,
  LaunchConceptSetSchema,
  LaunchHandoffSchema,
  LaunchRunManifestSchema,
  type LaunchConceptLedger,
  type LaunchConceptSet,
  type LaunchHandoff,
  type LaunchLedgerEntry,
  type LaunchRunManifest,
} from './launch-contracts';

/**
 * The run directory, as a store.
 *
 * Three properties are load-bearing and are enforced here rather than by
 * convention:
 *
 * - **A concept version is written once.** `writeConceptVersion` refuses to
 *   overwrite an existing file. A revision is version N+1; there is no code
 *   path that edits version N, which is what makes "immutable" a fact about the
 *   filesystem rather than a promise in a comment.
 * - **A record is verified against its own checksum on the way back in.** The
 *   selection pins the exact concept bytes it approved, so a concept edited
 *   between selection and render is a refusal, not a different advertisement.
 * - **The ledger's existing entries are re-read and compared before an append.**
 *   The ledger is an index and has to be rewritten to grow; comparing the prior
 *   entries first means growing it cannot quietly change history.
 *
 * There is deliberately no Prisma model here. Every campaign-lifecycle table is
 * keyed to a `Campaign` row only the workflow path creates, and those rows drive
 * the three workflow gates; a CLI run that invented one would be claiming a
 * campaign lifecycle it is not part of.
 */

const RUN_MANIFEST = 'launch-run.json';
const CONCEPT_SET = 'concept-set.json';
const LEDGER = 'concept-ledger.json';
const SELECTION = 'concept-selection.json';
const HANDOFF = 'handoff.json';
const CONCEPTS_DIR = 'concepts';
const DECISIONS_DIR = 'decisions';

export function conceptVersionFile(conceptId: string, version: number): string {
  return `${CONCEPTS_DIR}/${conceptId}.v${version}.json`;
}

export function conceptAssessmentFile(conceptId: string, version: number): string {
  return `${CONCEPTS_DIR}/${conceptId}.v${version}.assessment.json`;
}

async function writeJson(runDirectory: string, relative: string, value: unknown): Promise<string> {
  const target = join(runDirectory, relative);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return target;
}

async function readJson(runDirectory: string, relative: string): Promise<unknown> {
  const target = join(runDirectory, relative);
  try {
    return JSON.parse(await readFile(target, 'utf8')) as unknown;
  } catch (error) {
    throw new LaunchArtefactError(
      'MISSING',
      `${relative} could not be read from ${runDirectory}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Validates and returns the schema's *output* type.
 *
 * The third type parameter is pinned to `unknown` deliberately: with the
 * default (`Input = Output`) TypeScript resolves `T` against the input shape,
 * where every field carrying a Zod default is optional — and every caller would
 * then be handed a type whose defaults might be missing.
 */
function parseOrThrow<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  value: unknown,
  label: string,
): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new LaunchArtefactError(
    'INVALID',
    `${label} is not a valid record:\n${parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('\n')}`,
  );
}

async function exists(runDirectory: string, relative: string): Promise<boolean> {
  try {
    await readFile(join(runDirectory, relative), 'utf8');
    return true;
  } catch {
    return false;
  }
}

// --- run manifest ------------------------------------------------------------

export async function writeRunManifest(
  runDirectory: string,
  manifest: LaunchRunManifest,
): Promise<string> {
  return writeJson(
    runDirectory,
    RUN_MANIFEST,
    parseOrThrow(LaunchRunManifestSchema, manifest, RUN_MANIFEST),
  );
}

export async function readRunManifest(runDirectory: string): Promise<LaunchRunManifest> {
  return parseOrThrow(
    LaunchRunManifestSchema,
    await readJson(runDirectory, RUN_MANIFEST),
    RUN_MANIFEST,
  );
}

// --- candidate set -----------------------------------------------------------

export async function writeConceptSet(
  runDirectory: string,
  set: LaunchConceptSet,
): Promise<string> {
  return writeJson(
    runDirectory,
    CONCEPT_SET,
    parseOrThrow(LaunchConceptSetSchema, set, CONCEPT_SET),
  );
}

export async function readConceptSet(runDirectory: string): Promise<LaunchConceptSet> {
  return parseOrThrow(
    LaunchConceptSetSchema,
    await readJson(runDirectory, CONCEPT_SET),
    CONCEPT_SET,
  );
}

// --- concept versions --------------------------------------------------------

/**
 * Writes one immutable concept version and its assessment, and appends both to
 * the ledger.
 *
 * The refusal to overwrite is the whole point: a revision that landed on top of
 * the version a reviewer had already read would erase the record of what they
 * were shown.
 */
export async function writeConceptVersion(
  runDirectory: string,
  record: LaunchConceptVersion,
  assessment: LaunchConceptAssessment,
): Promise<LaunchLedgerEntry> {
  const validated = parseOrThrow(LaunchConceptVersionSchema, record, 'concept version');
  const validatedAssessment = parseOrThrow(
    LaunchConceptAssessmentSchema,
    assessment,
    'concept assessment',
  );
  const versionFile = conceptVersionFile(validated.conceptId, validated.version);
  const assessmentFile = conceptAssessmentFile(validated.conceptId, validated.version);

  if (await exists(runDirectory, versionFile)) {
    throw new LaunchArtefactError(
      'IMMUTABLE_RECORD_EXISTS',
      `${versionFile} already exists — a concept version is written once, and a change is version ${validated.version + 1}`,
    );
  }

  const expected = checksumOf(validated.concept);
  if (validated.conceptChecksumSha256 !== expected) {
    throw new LaunchArtefactError(
      'CHECKSUM_MISMATCH',
      `${versionFile} declares ${validated.conceptChecksumSha256} but its concept hashes to ${expected}`,
    );
  }

  await writeJson(runDirectory, versionFile, validated);
  await writeJson(runDirectory, assessmentFile, validatedAssessment);

  const entry: LaunchLedgerEntry = {
    conceptId: validated.conceptId,
    version: validated.version,
    origin: validated.origin,
    ...(validated.supersedesVersion === undefined
      ? {}
      : { supersedesVersion: validated.supersedesVersion }),
    versionFile,
    assessmentFile,
    conceptChecksumSha256: validated.conceptChecksumSha256,
    createdAt: validated.createdAt,
    authoredByAgent: validated.authoredByAgent,
  };
  await appendLedgerEntry(runDirectory, validated.launchRunId, entry);
  return entry;
}

/**
 * Appends to the ledger, having first confirmed the entries already in it are
 * exactly the ones that were there before.
 */
async function appendLedgerEntry(
  runDirectory: string,
  launchRunId: string,
  entry: LaunchLedgerEntry,
): Promise<void> {
  const existing = (await exists(runDirectory, LEDGER))
    ? parseOrThrow(LaunchConceptLedgerSchema, await readJson(runDirectory, LEDGER), LEDGER)
    : { ledgerVersion: 1 as const, launchRunId, entries: [] };

  if (existing.launchRunId !== launchRunId) {
    throw new LaunchArtefactError(
      'LEDGER_TAMPERED',
      `${LEDGER} belongs to run ${existing.launchRunId}, not ${launchRunId}`,
    );
  }
  const duplicate = existing.entries.find(
    (candidate) => candidate.conceptId === entry.conceptId && candidate.version === entry.version,
  );
  if (duplicate) {
    throw new LaunchArtefactError(
      'IMMUTABLE_RECORD_EXISTS',
      `${LEDGER} already records ${entry.conceptId} v${entry.version}`,
    );
  }

  await writeJson(runDirectory, LEDGER, {
    ...existing,
    entries: [...existing.entries, entry],
  } satisfies LaunchConceptLedger);
}

export async function readLedger(runDirectory: string): Promise<LaunchConceptLedger> {
  return parseOrThrow(LaunchConceptLedgerSchema, await readJson(runDirectory, LEDGER), LEDGER);
}

/** One concept version, verified against the checksum the ledger recorded. */
export async function readConceptVersion(
  runDirectory: string,
  conceptId: string,
  version: number,
): Promise<LaunchConceptVersion> {
  const relative = conceptVersionFile(conceptId, version);
  const record = parseOrThrow(
    LaunchConceptVersionSchema,
    await readJson(runDirectory, relative),
    relative,
  );
  const actual = checksumOf(record.concept);
  if (actual !== record.conceptChecksumSha256) {
    throw new LaunchArtefactError(
      'CHECKSUM_MISMATCH',
      `${relative} was edited after it was written: it hashes to ${actual}, not ${record.conceptChecksumSha256}`,
    );
  }
  return record;
}

export async function readAssessment(
  runDirectory: string,
  conceptId: string,
  version: number,
): Promise<LaunchConceptAssessment> {
  const relative = conceptAssessmentFile(conceptId, version);
  return parseOrThrow(
    LaunchConceptAssessmentSchema,
    await readJson(runDirectory, relative),
    relative,
  );
}

export interface ConceptHistory {
  readonly conceptId: string;
  readonly versions: readonly LaunchConceptVersion[];
  readonly latest: LaunchConceptVersion;
  readonly latestAssessment: LaunchConceptAssessment;
}

/** Every concept in the run, each with its full version chain, in ledger order. */
export async function readConceptHistories(
  runDirectory: string,
): Promise<readonly ConceptHistory[]> {
  const ledger = await readLedger(runDirectory);
  const byConcept = new Map<string, number[]>();
  for (const entry of ledger.entries) {
    byConcept.set(entry.conceptId, [...(byConcept.get(entry.conceptId) ?? []), entry.version]);
  }

  const histories: ConceptHistory[] = [];
  for (const [conceptId, versionNumbers] of byConcept) {
    const ascending = [...versionNumbers].sort((left, right) => left - right);
    const versions: LaunchConceptVersion[] = [];
    for (const version of ascending) {
      // eslint-disable-next-line no-await-in-loop -- read in version order so the chain is stable
      versions.push(await readConceptVersion(runDirectory, conceptId, version));
    }
    const latest = versions[versions.length - 1] as LaunchConceptVersion;
    // eslint-disable-next-line no-await-in-loop -- one assessment per concept, in ledger order
    const latestAssessment = await readAssessment(runDirectory, conceptId, latest.version);
    histories.push({ conceptId, versions, latest, latestAssessment });
  }
  return histories;
}

// --- decisions ---------------------------------------------------------------

export async function appendDecision(
  runDirectory: string,
  decision: LaunchGateDecision,
): Promise<string> {
  const validated = parseOrThrow(LaunchGateDecisionSchema, decision, 'gate decision');
  const sequence = (await listDecisions(runDirectory)).length + 1;
  const relative = `${DECISIONS_DIR}/${String(sequence).padStart(3, '0')}-${validated.decision.toLowerCase()}.json`;
  if (await exists(runDirectory, relative)) {
    throw new LaunchArtefactError('IMMUTABLE_RECORD_EXISTS', `${relative} already exists`);
  }
  return writeJson(runDirectory, relative, validated);
}

export async function listDecisions(runDirectory: string): Promise<readonly LaunchGateDecision[]> {
  let files: string[];
  try {
    files = (await readdir(join(runDirectory, DECISIONS_DIR))).filter((name) =>
      name.endsWith('.json'),
    );
  } catch {
    return [];
  }
  const decisions: LaunchGateDecision[] = [];
  for (const file of files.sort()) {
    // eslint-disable-next-line no-await-in-loop -- read in filename order, which is decision order
    const raw = await readJson(runDirectory, `${DECISIONS_DIR}/${file}`);
    decisions.push(parseOrThrow(LaunchGateDecisionSchema, raw, file));
  }
  return decisions;
}

// --- selection and handoff ---------------------------------------------------

export async function writeSelection(
  runDirectory: string,
  selection: LaunchConceptSelection,
): Promise<string> {
  if (await exists(runDirectory, SELECTION)) {
    throw new LaunchArtefactError(
      'IMMUTABLE_RECORD_EXISTS',
      `${SELECTION} already exists — a changed decision is a new run, not an overwritten approval`,
    );
  }
  return writeJson(
    runDirectory,
    SELECTION,
    parseOrThrow(LaunchConceptSelectionSchema, selection, SELECTION),
  );
}

export async function readSelection(
  runDirectory: string,
): Promise<LaunchConceptSelection | undefined> {
  if (!(await exists(runDirectory, SELECTION))) return undefined;
  return parseOrThrow(
    LaunchConceptSelectionSchema,
    await readJson(runDirectory, SELECTION),
    SELECTION,
  );
}

export async function writeHandoff(runDirectory: string, handoff: LaunchHandoff): Promise<string> {
  return writeJson(runDirectory, HANDOFF, parseOrThrow(LaunchHandoffSchema, handoff, HANDOFF));
}

export async function writeRunArtefact(
  runDirectory: string,
  relative: string,
  value: unknown,
): Promise<string> {
  return writeJson(runDirectory, relative, value);
}
