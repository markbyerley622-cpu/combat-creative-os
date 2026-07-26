import { withCreativeMemory } from '../../shared/creative-memory-prompt';
import { V3 } from './v3';

export const V4 = withCreativeMemory(
  V3,
  4,
  'AAMP Creative Memory injection: accepts bounded, governed benchmark craft context for camera movement, motion design and transition mechanics, and must return a creativeMemoryDivergence record describing the campaign-specific transformation.',
);
