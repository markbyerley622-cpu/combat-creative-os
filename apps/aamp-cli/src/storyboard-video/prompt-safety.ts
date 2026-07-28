import { createHash } from 'node:crypto';

import { StoryboardVideoError } from './failures';
import { MOTION_PROMPT_MAX_WORDS, type SceneManifestEntry } from './scene-manifest';

/**
 * What a motion prompt may not ask a generative model to draw.
 *
 * The rule this enforces is the milestone's central one: **critical UI text,
 * fighter records, dates, rankings, factual claims, logos and CTA typography
 * are never sent to LTX for regeneration.** They are composited by the
 * deterministic renderer, from real material, after the generated footage
 * comes back.
 *
 * The gate **refuses, it never rewrites**, and that is deliberate for the same
 * reason `factual-sanitisation.ts` gives: stripping "ranked #3" out of a
 * prompt and generating anyway would be application code editing the
 * advertisement's brief. Every rule names what it protects against and what to
 * write instead, because a refusal an author cannot argue with is one they
 * work around.
 *
 * It walks the **motion prompt only** — the authored instruction to the model.
 * It says nothing about what is in the source frame, which is the operator's
 * own approved artwork and reaches the model as pixels, not as a request to
 * invent.
 */

export interface PromptRule {
  readonly code: string;
  readonly pattern: RegExp;
  readonly protects: string;
  readonly writeInstead: string;
}

export const PROMPT_RULES: readonly PromptRule[] = [
  {
    code: 'FIGHTER_RECORD',
    pattern: /\b\d{1,3}\s*[-–]\s*\d{1,3}(\s*[-–]\s*\d{1,3})?\b(?![\s]*(?:px|fps|s\b))/i,
    protects: 'a win-loss-draw record',
    writeInstead:
      'describe the shot without the record. Records are real facts about real people and are composited from the approved frame, never generated.',
  },
  {
    code: 'RANKING_POSITION',
    pattern: /\b(?:ranked|ranking|rank)\s*#?\s*\d+|#\s?\d+\s+(?:contender|ranked|in the world)/i,
    protects: 'a ranking position',
    writeInstead:
      'describe the motion of the rankings panel, not its contents. What the rows say comes from the approved frame.',
  },
  {
    code: 'CALENDAR_DATE',
    pattern:
      /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b|\b\d{1,2}\s*\/\s*\d{1,2}\s*\/\s*\d{2,4}\b|\b20\d{2}\b/i,
    protects: 'a calendar date',
    writeInstead:
      'say "the event date card" rather than the date itself. A generated date is a claim about a real schedule.',
  },
  {
    code: 'EVENT_COUNT',
    pattern: /\b\d+\s+(?:fights?|events?|bouts?|cards?|fighters?)\b/i,
    protects: 'a countable claim about events or fights',
    writeInstead:
      'describe the panel without the count. Counts are validated facts and are composited, never generated.',
  },
  {
    code: 'ON_SCREEN_COPY',
    pattern:
      /\b(?:text|caption|headline|title|label|copy|word|typography|font)\b[^.]{0,40}\b(?:reads?|says?|saying|spelling|that says)\b|["“][A-Z0-9][^"”]{2,}["”]/i,
    protects: 'literal on-screen copy',
    writeInstead:
      'never specify what text appears. Every word on screen is drawn by the deterministic renderer from approved copy.',
  },
  {
    code: 'LOGO_OR_MARK',
    pattern: /\b(?:logo|wordmark|brand mark|app icon|badge|watermark)\b/i,
    protects: 'the brand mark',
    writeInstead:
      'omit the mark from the prompt. The real Combat Reviews mark is composited from the owned asset; a generated one is a forgery of our own brand.',
  },
  {
    code: 'CTA_TYPOGRAPHY',
    pattern: /\b(?:call to action|cta|download|app store|play store|button that|tap to)\b/i,
    protects: 'the call to action',
    writeInstead:
      'describe the plate the CTA will sit on. The CTA itself is deterministic typography over it.',
  },
  {
    code: 'PRODUCT_UI',
    pattern:
      /\b(?:rankings? (?:table|list|screen)|leaderboard|fight card screen|prediction screen|scoreboard|user interface|app screen|screenshot)\b/i,
    protects: 'the product interface',
    writeInstead:
      'a scene that shows the interface belongs in EXACT_UI_MOTION, where the real screen is animated deterministically rather than redrawn.',
  },
  {
    code: 'NAMED_PERSON',
    pattern: /\b(?:fighter|champion|boxer)\s+(?:named|called)\s+[A-Z][a-z]+/,
    protects: 'a named individual',
    writeInstead:
      'describe the figure by role and action. Naming a person asks the model to depict a real human being.',
  },
];

/**
 * A prompt must state its prohibited mutations.
 *
 * Required rather than encouraged: the whole reason a photographic plate can
 * be animated safely is that the model was told, in the request itself, not to
 * alter what it cannot be trusted to redraw. A prompt that omits it is a
 * prompt that permits it.
 */
export const REQUIRED_PROHIBITION_MARKER = 'Do not alter';

export interface PromptFinding {
  readonly sceneNumber: number;
  readonly code: string;
  readonly protects: string;
  readonly matched: string;
  readonly writeInstead: string;
}

/**
 * Splits the prohibition clause off the rest of the prompt.
 *
 * A prohibition necessarily names what it forbids — "Do not alter the mark or
 * any on-screen text" trips the mark rule and the copy rule by saying exactly
 * the thing that makes it a prohibition. So the clause is exempt from the
 * content rules and nothing else is, which is the same narrow exemption
 * `assertAgentSafeContext` already grants prohibition fields.
 *
 * The exemption runs from the marker to the end of the prompt, because the
 * clause is written last by convention and a sentence-boundary rule would let
 * a second sentence smuggle a claim in behind it.
 */
export function splitProhibitionClause(prompt: string): {
  readonly directive: string;
  readonly prohibition: string;
} {
  const index = prompt.indexOf(REQUIRED_PROHIBITION_MARKER);
  if (index < 0) return { directive: prompt, prohibition: '' };
  return { directive: prompt.slice(0, index), prohibition: prompt.slice(index) };
}

export function findPromptViolations(scene: SceneManifestEntry): readonly PromptFinding[] {
  const findings: PromptFinding[] = [];
  const { directive } = splitProhibitionClause(scene.motionPrompt);
  for (const rule of PROMPT_RULES) {
    const match = rule.pattern.exec(directive);
    if (!match) continue;
    findings.push({
      sceneNumber: scene.sceneNumber,
      code: rule.code,
      protects: rule.protects,
      matched: match[0].trim().slice(0, 80),
      writeInstead: rule.writeInstead,
    });
  }
  return findings;
}

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export interface CheckedPrompt {
  readonly sceneNumber: number;
  readonly wordCount: number;
  readonly promptSha256: string;
}

/**
 * Checks every prompt that will actually be submitted.
 *
 * Scenes that never reach a generation provider are skipped rather than
 * checked — an `EXACT_UI_MOTION` scene's prompt is documentation of intent for
 * a human reader, and holding a note nobody will send to a model to the same
 * standard as a request that will be sent is a guard that teaches operators to
 * ignore guards.
 */
export function assertPromptsAreSafe(
  scenes: readonly SceneManifestEntry[],
  submittable: (scene: SceneManifestEntry) => boolean,
): readonly CheckedPrompt[] {
  const findings: PromptFinding[] = [];
  const problems: string[] = [];
  const checked: CheckedPrompt[] = [];

  for (const scene of scenes) {
    if (!submittable(scene)) continue;

    const wordCount = countWords(scene.motionPrompt);
    if (wordCount > MOTION_PROMPT_MAX_WORDS) {
      problems.push(
        `scene ${scene.sceneNumber}'s motion prompt is ${wordCount} words, over the ${MOTION_PROMPT_MAX_WORDS}-word limit`,
      );
    }
    if (!scene.motionPrompt.includes(REQUIRED_PROHIBITION_MARKER)) {
      problems.push(
        `scene ${scene.sceneNumber}'s motion prompt states no prohibited mutations. Every submitted prompt must contain a "${REQUIRED_PROHIBITION_MARKER} …" clause naming what the model may not change — a prompt that omits it is a prompt that permits it.`,
      );
    }
    findings.push(...findPromptViolations(scene));
    checked.push({
      sceneNumber: scene.sceneNumber,
      wordCount,
      promptSha256: createHash('sha256').update(scene.motionPrompt, 'utf8').digest('hex'),
    });
  }

  if (findings.length > 0 || problems.length > 0) {
    const lines = [
      ...problems.map((problem) => `  - ${problem}`),
      ...findings.map(
        (finding) =>
          `  - scene ${finding.sceneNumber} [${finding.code}]: the prompt contains ${finding.protects} ("${finding.matched}"). ${finding.writeInstead}`,
      ),
    ];
    throw new StoryboardVideoError(
      'INVALID_STORYBOARD',
      `motion prompts were refused before any upload:\n${lines.join(
        '\n',
      )}\n\nThe gate refuses and never rewrites: editing a brief to make it pass would make this system the author of the advertisement.`,
    );
  }

  return checked;
}
