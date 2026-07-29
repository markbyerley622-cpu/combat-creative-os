import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { assertStoryboardVideoArtefactSafe } from './artefact-safety';
import { StoryboardVideoError } from './failures';
import {
  computeDecisionId,
  MotionReviewDecisionSchema,
  MOTION_REVIEW_LEDGER_VERSION,
  type MotionReviewDecision,
  type UnsignedMotionReviewDecision,
} from './motion-review-contracts';

/**
 * The review ledger: every human decision ever recorded, in the order they
 * were made, and none of them ever edited.
 *
 * JSON Lines, appended to, never rewritten. That shape is the point rather
 * than a convenience: a reviewer's approval is evidence about what somebody
 * looked at and when, and evidence that can be silently amended is not
 * evidence. A changed mind is a *new* line naming the one it supersedes, so
 * the record shows both the first judgement and the second — an audit that
 * only ever shows the current answer cannot distinguish "approved once" from
 * "approved after two rejections".
 *
 * Every line carries the digest of its own content, so a hand-edited approval
 * is refused on read rather than honoured. And a decision applies to a scene
 * only while its `identitySha256` still matches what is on disk, which is what
 * makes a changed clip, a changed keyframe, a changed prompt or a changed
 * scene contract invalidate an approval automatically, without anybody
 * remembering to.
 *
 * The ledger lives under `.aamp-output`, is git-ignored, and holds no path,
 * URL or credential — only checksums, a reviewer's name and their words.
 */

export const MOTION_REVIEW_LEDGER_FILENAME = 'motion-review-ledger.jsonl';

/**
 * The default review directory, resolved against the working directory.
 *
 * Deliberately *not* inside a run directory: a run directory is per-invocation
 * and a decision outlives the run that prompted it. An approval that vanished
 * because the next run wrote somewhere else would make the gate something an
 * operator clears again every time, which is how a gate becomes a formality.
 */
export const DEFAULT_MOTION_REVIEW_DIRECTORY = join('.aamp-output', 'motion-review');

export interface AppendDecisionInput {
  readonly decision: UnsignedMotionReviewDecision;
}

export class MotionReviewLedger {
  private constructor(
    readonly directory: string,
    readonly filePath: string,
    private readonly decisions: MotionReviewDecision[],
  ) {}

  /**
   * Reads the ledger, refusing a tampered line rather than skipping it.
   *
   * An absent file is an empty ledger — the normal first run. A *malformed*
   * one is an error: a line that will not parse is a decision somebody wrote
   * and something corrupted, and continuing as though the scene had never been
   * reviewed would quietly discard a human judgement.
   */
  static async open(directoryInput: string): Promise<MotionReviewLedger> {
    const directory = resolve(directoryInput);
    const filePath = join(directory, MOTION_REVIEW_LEDGER_FILENAME);

    let text: string;
    try {
      text = await readFile(filePath, 'utf8');
    } catch {
      return new MotionReviewLedger(directory, filePath, []);
    }

    const decisions: MotionReviewDecision[] = [];
    const problems: string[] = [];
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .forEach((line, index) => {
        const lineNumber = index + 1;
        let raw: unknown;
        try {
          raw = JSON.parse(line);
        } catch {
          problems.push(`line ${lineNumber} is not valid JSON`);
          return;
        }
        const parsed = MotionReviewDecisionSchema.safeParse(raw);
        if (!parsed.success) {
          problems.push(
            `line ${lineNumber}: ${parsed.error.issues
              .map((issue) => `${issue.path.join('.') || '<root>'} ${issue.message}`)
              .join('; ')}`,
          );
          return;
        }
        const { decisionId, ...unsigned } = parsed.data;
        if (computeDecisionId(unsigned) !== decisionId) {
          problems.push(
            `line ${lineNumber}: the recorded decisionId does not match the line's content, so this decision was edited after it was written`,
          );
          return;
        }
        decisions.push(parsed.data);
      });

    if (problems.length > 0) {
      throw new StoryboardVideoError(
        'MOTION_REVIEW_BLOCKED',
        `the review ledger at ${filePath} could not be trusted:\n${problems
          .map((problem) => `  - ${problem}`)
          .join(
            '\n',
          )}\n\nA ledger line is evidence about what a person approved. A damaged one is refused rather than skipped, because skipping it would silently discard a human judgement.`,
      );
    }

    return new MotionReviewLedger(directory, filePath, decisions);
  }

  get all(): readonly MotionReviewDecision[] {
    return this.decisions;
  }

  /** Every decision ever recorded for a scene, oldest first. */
  forScene(sceneNumber: number): readonly MotionReviewDecision[] {
    return this.decisions.filter((decision) => decision.sceneNumber === sceneNumber);
  }

  /**
   * The most recent decision that still describes what is on disk.
   *
   * "Still describes" is the whole contract: a decision whose identity digest
   * no longer matches is not a stale approval to be refreshed, it is a
   * judgement about a different clip.
   */
  latestApplicable(sceneNumber: number, identitySha256: string): MotionReviewDecision | null {
    return (
      [...this.forScene(sceneNumber)]
        .filter((decision) => decision.identitySha256 === identitySha256)
        .pop() ?? null
    );
  }

  /** The most recent decision for a scene whatever it was about. Used to explain a supersede. */
  latestAny(sceneNumber: number): MotionReviewDecision | null {
    return [...this.forScene(sceneNumber)].pop() ?? null;
  }

  /**
   * Appends one decision.
   *
   * Idempotent on content: recording the identical decision twice is a no-op
   * rather than a second line, because a reviewer re-running the same command
   * has not made a second judgement. Anything that differs is a new line.
   */
  async append(input: AppendDecisionInput): Promise<MotionReviewDecision> {
    const decisionId = computeDecisionId(input.decision);
    const decision: MotionReviewDecision = { ...input.decision, decisionId };

    const parsed = MotionReviewDecisionSchema.safeParse(decision);
    if (!parsed.success) {
      throw new StoryboardVideoError(
        'MOTION_REVIEW_BLOCKED',
        `refusing to record an invalid decision: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '<root>'} ${issue.message}`)
          .join('; ')}`,
        input.decision.sceneNumber,
      );
    }

    if (this.decisions.some((existing) => existing.decisionId === decisionId)) {
      return decision;
    }

    // Walked before it is written, exactly like every other artefact on this
    // path: a reviewer's free-text feedback is the one field on the whole run
    // where a person could paste a signed URL without thinking.
    assertStoryboardVideoArtefactSafe(decision, MOTION_REVIEW_LEDGER_FILENAME);

    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(decision)}\n`, 'utf8');
    this.decisions.push(decision);
    return decision;
  }
}

export { MOTION_REVIEW_LEDGER_VERSION };
