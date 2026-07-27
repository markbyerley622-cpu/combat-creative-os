import { withLaunchConceptCompetition } from '../../shared/product-launch-prompt';
import { V3 } from './v3';

export const V4 = withLaunchConceptCompetition(
  V3,
  4,
  'AAMP agent-led product launch: accepts the productLaunch brief and a launchDirective naming the structural positions earlier candidates took, and returns a structured launchConcept that must be genuinely distinct from them.',
);
