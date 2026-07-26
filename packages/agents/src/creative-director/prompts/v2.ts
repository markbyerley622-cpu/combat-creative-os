import { withCampaignBrief } from '../../shared/campaign-brief-prompt';
import { V1 } from './v1';

export const V2 = withCampaignBrief(
  V1,
  2,
  'AAMP prompt-driven generation: accepts the requester’s verbatim campaignPrompt and binding factualConstraints, so the concept answers the actual brief and never contradicts a stated product or event fact.',
);
