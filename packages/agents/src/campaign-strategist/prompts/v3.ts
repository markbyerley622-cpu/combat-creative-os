import { withCreativeMemory } from '../../shared/creative-memory-prompt';
import { V2 } from './v2';

export const V3 = withCreativeMemory(
  V2,
  3,
  'AAMP Creative Memory injection: accepts bounded, governed benchmark craft context for audience tension, positioning, hook strategy and CTA strategy, and must return a creativeMemoryDivergence record describing the campaign-specific transformation.',
);
