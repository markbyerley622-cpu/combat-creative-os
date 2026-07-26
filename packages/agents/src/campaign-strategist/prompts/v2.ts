import { withCampaignBrief } from '../../shared/campaign-brief-prompt';
import { V1 } from './v1';

export const V2 = withCampaignBrief(
  V1,
  2,
  'AAMP prompt-driven generation: accepts the requester’s verbatim campaignPrompt and binding factualConstraints, so strategy is grounded in the actual brief rather than only in its derived objective/keyMessages summary.',
);
