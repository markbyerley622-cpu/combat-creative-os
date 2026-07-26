import { withCampaignBrief } from '../../shared/campaign-brief-prompt';
import { V2 } from './v2';

export const V3 = withCampaignBrief(
  V2,
  3,
  'AAMP prompt-driven generation: accepts the requester’s verbatim campaignPrompt and binding factualConstraints, so a shot brief reflects the campaign’s actual subject rather than the visual direction alone.',
);
