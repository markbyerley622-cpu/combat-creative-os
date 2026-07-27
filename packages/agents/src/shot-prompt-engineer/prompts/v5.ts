import { withProductLaunch } from '../../shared/product-launch-prompt';
import { V4 } from './v4';

export const V5 = withProductLaunch(
  V4,
  5,
  'AAMP agent-led product launch: accepts the productLaunch brief, so on-screen copy and shot direction can never land a prohibited claim or describe an invented screen.',
);
