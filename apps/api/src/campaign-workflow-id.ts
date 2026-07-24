/**
 * The deterministic Temporal workflow ID for a campaign's
 * `CampaignProductionWorkflow` run. No `WorkflowRun` mapping table exists
 * yet (see docs/architecture.md §7.1) — rather than add one, this session
 * uses Temporal's own recommended pattern of deriving the workflow ID from
 * the business key. Whatever eventually calls `client.workflow.start(...)`
 * for a campaign must use this exact same convention, or these two halves
 * will silently talk to different workflow executions.
 */
export function campaignProductionWorkflowId(campaignId: string): string {
  return `campaign-production:${campaignId}`;
}
