import { withCreativeMemory } from '../../shared/creative-memory-prompt';
import { V2 } from './v2';

export const V3 = withCreativeMemory(
  V2,
  3,
  'AAMP Creative Memory injection: accepts bounded, governed benchmark timing context for opening-hook latency, beat density, transition timing and CTA timing, and must return a creativeMemoryDivergence record — beat lengths are derived from the brief, never reproduced from a reference.',
);
