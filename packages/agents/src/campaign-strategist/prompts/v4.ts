import { withProductLaunch } from '../../shared/product-launch-prompt';
import { V3 } from './v3';

export const V4 = withProductLaunch(
  V3,
  4,
  'AAMP agent-led product launch: accepts the productLaunch brief — positioning, desired audience perception, brand identity, creative constraints and binding prohibited claims.',
);
