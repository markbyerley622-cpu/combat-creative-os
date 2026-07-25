import type { CampaignStrategistInput } from '../campaign-strategist/schema';
import type { CampaignStrategistResult } from '../campaign-strategist/schema';
import type { CreativeDirectorResult } from '../creative-director/schema';
import type { ScriptTimingDirectorResult } from '../script-timing-director/schema';
import type { ShotPromptEngineerResult } from '../shot-prompt-engineer/schema';

/**
 * The golden fixture for a 15-second Combat Reviews advertisement, used to
 * test agent handoffs from campaign strategy through shot prompts (see
 * `handoff.test.ts`). Hook / promise / feature journey / CTA are exactly the
 * brief given for this framework's acceptance:
 *
 *   Hook:     "12 Fight Events This Weekend"
 *   Promise:  "Every Combat Sport. One App."
 *   Feature:  Event discovery -> information -> prediction -> discussion
 *   CTA:      "Download Free"
 */
export const COMBAT_REVIEWS_BRIEF: CampaignStrategistInput = {
  brandName: 'Combat Reviews',
  objective:
    'Drive app installs by showing combat-sports fans that Combat Reviews is the one app that covers every promotion, every weekend.',
  targetPlatforms: ['TIKTOK', 'INSTAGRAM_REELS', 'YOUTUBE_SHORTS'],
  durationsSeconds: [15, 10, 6],
  budgetCents: 500_000,
  keyMessages: ['12 Fight Events This Weekend', 'Every Combat Sport. One App.'],
  mandatories: ['Download Free'],
  priorLearnings: [],
};

export const COMBAT_REVIEWS_STRATEGY_RESULT: CampaignStrategistResult = {
  audienceProfile: {
    name: 'Combat-sports super-fans',
    demographics: { ageRange: '18-34', gender: 'majority male, growing female audience' },
    psychographics: { values: ['loyalty to multiple promotions, not just one'] },
    painPoints: [
      'Following MMA, boxing, and other combat sports means juggling several apps and sites.',
      "It's hard to know what's even on this weekend across every promotion.",
    ],
    platformBehavior: {
      TIKTOK: 'short highlight-driven clips',
      INSTAGRAM_REELS: 'fast-cut hook-first content',
    },
  },
  strategy: {
    positioning: 'Combat Reviews is the single home base for every combat sport, every weekend.',
    targetAudienceSummary:
      'Combat-sports fans who currently follow multiple promotions across scattered apps.',
    keyMessages: ['12 Fight Events This Weekend', 'Every Combat Sport. One App.'],
    toneGuidelines: [
      'High-energy, short declarative sentences.',
      'No jargon — speak like a fan, not a marketer.',
    ],
  },
};

export const COMBAT_REVIEWS_CONCEPT_RESULT: CreativeDirectorResult = {
  logline: 'One weekend, twelve fight cards, one app that already has you covered.',
  visualDirection:
    'Fast-cut montage of distinct combat-sports arenas and crowd energy, punchy on-screen numerals counting up events, cool arena lighting with a single accent color tying every clip together.',
  narrativeArc:
    'Open on the sheer volume of fights happening this weekend (hook), promise one app covers all of it, walk through discovering/checking/predicting/discussing a fight, close on the download CTA.',
  referenceNotes: ['Countdown-style hook similar to sports-recap highlight reels.'],
};

export const COMBAT_REVIEWS_SCRIPT_RESULT: ScriptTimingDirectorResult = {
  totalDurationFrames: 450,
  shots: [
    {
      index: 0,
      description:
        'Fast-cut montage of fight cards with an on-screen counter ticking up to "12 Fight Events This Weekend".',
      durationFrames: 90,
      beat: 'HOOK',
      dependsOnShotIndices: [],
    },
    {
      index: 1,
      description:
        'Split-screen of different combat sports (MMA, boxing, kickboxing) unifying into the Combat Reviews app icon, text "Every Combat Sport. One App."',
      durationFrames: 90,
      beat: 'PROMISE',
      dependsOnShotIndices: [0],
    },
    {
      index: 2,
      description:
        "Phone screen recording: user browsing the event-discovery feed for this weekend's cards.",
      durationFrames: 60,
      beat: 'FEATURE',
      dependsOnShotIndices: [1],
    },
    {
      index: 3,
      description:
        'Phone screen recording: user tapping into fighter/event information detail page.',
      durationFrames: 45,
      beat: 'FEATURE',
      dependsOnShotIndices: [2],
    },
    {
      index: 4,
      description: 'Phone screen recording: user submitting a fight-outcome prediction.',
      durationFrames: 45,
      beat: 'FEATURE',
      dependsOnShotIndices: [3],
    },
    {
      index: 5,
      description:
        'Phone screen recording: user posting in the fight-discussion thread as replies stack up.',
      durationFrames: 45,
      beat: 'FEATURE',
      dependsOnShotIndices: [4],
    },
    {
      index: 6,
      description:
        'App logo full-screen with bold on-screen text "Download Free" and app-store badges.',
      durationFrames: 75,
      beat: 'CTA',
      dependsOnShotIndices: [5],
    },
  ],
};

export const COMBAT_REVIEWS_SHOT_PROMPT_RESULT: ShotPromptEngineerResult = {
  providerId: 'mock-video-gen',
  promptText:
    'Fast-paced highlight montage: quick cuts between five distinct combat-sports arenas (MMA cage, boxing ring, kickboxing ring), crowd energy, bold on-screen numeral counter ticking up from 1 to 12, cool blue arena lighting, energetic pacing, static wide shots intercut with handheld crowd shots.',
  negativePrompt: 'no real athlete likenesses, no readable real brand logos, no text glitches',
  params: { aspectRatio: '9:16', targetDurationFrames: 90 },
  visualObjective: 'Hook the viewer with the sheer volume of fights happening this weekend.',
  action: 'Quick cuts between five distinct arenas as an on-screen counter ticks up to 12.',
  subject: 'Combat-sports arenas and crowd energy',
  environment: 'MMA cage, boxing ring, kickboxing ring — five distinct arenas',
  cameraMovement: 'Static wide shots intercut with handheld crowd shots',
  lensFraming: 'Wide shot',
  lighting: 'Cool blue arena lighting',
  colorTreatment: 'Cool blue accent, high-energy contrast',
  motionIntensity: 'HIGH',
  transitionIn: 'FADE_IN',
  transitionOut: 'CUT',
  textSafeAreas: ['CENTER'],
  continuityRequirements: ['Counter must read exactly "12" by the final cut of this shot.'],
  qualityRubric: [
    'On-screen numeral counter must tick up to exactly 12, not stop short or overshoot.',
    'No readable real brand logos or real athlete likenesses in any cut.',
  ],
};
