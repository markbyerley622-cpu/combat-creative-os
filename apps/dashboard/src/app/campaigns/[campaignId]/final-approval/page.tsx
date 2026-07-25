'use client';

import { useEffect, useState } from 'react';
import { SessionGate } from '@/components/SessionGate';
import { EmptyState, ErrorState, LoadingState, PageShell } from '@/components/PageShell';
import {
  createApiClient,
  FINAL_REPAIR_TARGET_OPTIONS,
  type BudgetStatusView,
  type FinalQaFindingView,
  type FinalQaView,
  type FinalRepairTarget,
} from '@/lib/api-client';
import { useSession } from '@/lib/session';

const POLL_INTERVAL_MS = 4000;

function BudgetRow({ label, status }: { label: string; status: BudgetStatusView | null }) {
  if (!status) {
    return <p style={{ color: '#666' }}>{label}: no budget policy configured (uncapped).</p>;
  }
  return (
    <p>
      {label}: {(status.spentCents / 100).toFixed(2)} / {(status.limitCents / 100).toFixed(2)} spent
      ({(status.remainingCents / 100).toFixed(2)} remaining)
    </p>
  );
}

function FindingRow({ finding }: { finding: FinalQaFindingView }) {
  return (
    <li style={{ marginBottom: '0.5rem' }}>
      <strong>{finding.severity}</strong> · {finding.category} — {finding.description}
      {finding.suggestedAction ? (
        <div style={{ color: '#555', fontSize: 13 }}>Suggested: {finding.suggestedAction}</div>
      ) : null}
    </li>
  );
}

function FinalApproval({ campaignId }: { campaignId: string }) {
  const { session } = useSession();
  const [data, setData] = useState<FinalQaView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [comments, setComments] = useState('');
  const [repairTarget, setRepairTarget] = useState<FinalRepairTarget>('SOUND_DESIGN');

  async function load() {
    if (!session) return;
    const client = createApiClient(session.workspaceId, session.userId);
    try {
      setData(await client.getFinalQa(campaignId));
      setError(null);
    } catch {
      setError('Could not load the final QA status.');
    }
  }

  useEffect(() => {
    load();
    const id = setInterval(load, POLL_INTERVAL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, campaignId]);

  async function submit(decision: 'APPROVED' | 'CHANGES_REQUESTED') {
    if (!session) return;
    setSubmitting(true);
    setNotice(null);
    const client = createApiClient(session.workspaceId, session.userId);
    try {
      await client.submitFinalApproval(
        campaignId,
        decision === 'APPROVED'
          ? { decision, comments: comments || undefined }
          : { decision, repairTarget, comments: comments || undefined },
      );
      setNotice(
        decision === 'APPROVED'
          ? 'Final master approved.'
          : `Changes requested — sent back to ${repairTarget}.`,
      );
      await load();
    } catch {
      setNotice('The decision could not be submitted.');
    } finally {
      setSubmitting(false);
    }
  }

  if (error) return <ErrorState message={error} />;
  if (!data) return <LoadingState label="Loading final QA…" />;

  const { campaign, caller, master, assessment, findings, deliveryContext, budget } = data;
  const atGate = campaign.isFinalApprovalStage;
  const canAct = caller.canApprove && atGate && !submitting;

  return (
    <div>
      <p>
        Stage: <strong>{campaign.currentStage}</strong>
        {!atGate && (
          <span style={{ color: '#666' }}> (the final approval gate is not open yet)</span>
        )}
      </p>

      {!master && (
        <EmptyState>
          The Final QA Controller has not assessed a final master for this campaign yet.
        </EmptyState>
      )}

      {master && (
        <section style={{ marginBottom: '1.5rem' }}>
          <h2>Final master</h2>
          <p>{master.originalFilename}</p>
          <div
            style={{
              padding: '2rem',
              background: '#efefef',
              borderRadius: 6,
              color: '#555',
              textAlign: 'center',
            }}
          >
            Preview placeholder — this master carries no rendered video (no render worker is
            connected).
          </div>
          {deliveryContext && (
            <p style={{ color: '#555', fontSize: 13, marginTop: '0.5rem' }}>
              {deliveryContext.platform} · {deliveryContext.aspectRatio} ·{' '}
              {deliveryContext.resolutionWidth}×{deliveryContext.resolutionHeight} ·{' '}
              {deliveryContext.frameRate}fps · {deliveryContext.durationFrames} frames
            </p>
          )}
        </section>
      )}

      {assessment && (
        <section style={{ marginBottom: '1.5rem' }}>
          <h2>
            Final QA: {assessment.pass ? 'passed' : 'failed'} (score{' '}
            {assessment.overallScore.toFixed(2)})
          </h2>
          <ul>
            {Object.entries(assessment.scores).map(([criterionId, score]) => (
              <li key={criterionId}>
                {criterionId}: {score}
              </li>
            ))}
          </ul>
          {findings.length > 0 && (
            <>
              <h3>Findings</h3>
              <ul>
                {findings.map((f) => (
                  <FindingRow key={f.id} finding={f} />
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      <section style={{ marginBottom: '1.5rem' }}>
        <h2>Final approval</h2>
        {!caller.canApprove && (
          <p style={{ color: '#a00' }}>
            Your role ({caller.role}) cannot approve a final master. Only a Creative Director or
            Owner/Admin can.
          </p>
        )}
        <label style={{ display: 'block', marginBottom: '0.5rem' }}>
          Comments
          <textarea
            value={comments}
            onChange={(e) => setComments(e.target.value)}
            rows={3}
            style={{ display: 'block', width: '100%', maxWidth: 560 }}
          />
        </label>
        <label style={{ display: 'block', marginBottom: '0.5rem' }}>
          Send back to
          <select
            value={repairTarget}
            onChange={(e) => setRepairTarget(e.target.value as FinalRepairTarget)}
            style={{ display: 'block' }}
          >
            {FINAL_REPAIR_TARGET_OPTIONS.map((target) => (
              <option key={target} value={target}>
                {target}
              </option>
            ))}
          </select>
        </label>
        <button type="button" disabled={!canAct} onClick={() => submit('APPROVED')}>
          Approve final master
        </button>{' '}
        <button type="button" disabled={!canAct} onClick={() => submit('CHANGES_REQUESTED')}>
          Request changes
        </button>
        {notice && <p style={{ marginTop: '0.5rem' }}>{notice}</p>}
      </section>

      <section>
        <h2>Budget</h2>
        <BudgetRow label="Workspace" status={budget.workspace} />
        <BudgetRow label="Campaign" status={budget.campaign} />
      </section>
    </div>
  );
}

export default function FinalApprovalPage({ params }: { params: { campaignId: string } }) {
  return (
    <SessionGate>
      <PageShell title="Final approval">
        <FinalApproval campaignId={params.campaignId} />
      </PageShell>
    </SessionGate>
  );
}
