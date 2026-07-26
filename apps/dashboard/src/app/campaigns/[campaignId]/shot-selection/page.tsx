'use client';

import { useEffect, useRef, useState } from 'react';
import { WorkspaceGate } from '@/components/WorkspaceGate';
import { EmptyState, ErrorState, LoadingState, PageShell } from '@/components/PageShell';
import {
  ApiError,
  createApiClient,
  type BudgetStatusView,
  type ShotReviewCandidate,
  type ShotReviewShot,
  type ShotReviewView,
} from '@/lib/api-client';
import { useWorkspace } from '@/lib/workspace';

/** Pulls the `error`/`reasons` a 409 (stale revision / ineligible candidate) carries in its JSON body. */
function conflictMessage(body: unknown): string {
  if (body && typeof body === 'object') {
    const b = body as { error?: unknown; reasons?: unknown };
    const parts: string[] = [];
    if (typeof b.error === 'string') parts.push(b.error);
    if (Array.isArray(b.reasons)) {
      for (const reason of b.reasons) {
        if (typeof reason === 'string') parts.push(reason);
      }
    }
    if (parts.length > 0) return parts.join(' — ');
  }
  return 'This selection is out of date or the candidate is no longer eligible.';
}

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

/** Never a `<video>` — mock candidates carry no real media (`hasMedia` is always `false`). A deterministic placeholder box is the only honest rendering. */
function CandidatePlaceholder() {
  return (
    <div
      style={{
        height: 90,
        borderRadius: 4,
        marginBottom: '0.5rem',
        background:
          'repeating-linear-gradient(45deg, #f0f0f0, #f0f0f0 8px, #e6e6e6 8px, #e6e6e6 16px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#999',
        fontSize: '0.75rem',
        fontStyle: 'italic',
      }}
    >
      No preview (mock provider)
    </div>
  );
}

function QaDetails({ candidate }: { candidate: ShotReviewCandidate }) {
  const { visualQa, continuityQa } = candidate;
  return (
    <div style={{ fontSize: '0.85rem', color: '#444' }}>
      {visualQa ? (
        <div style={{ marginBottom: '0.4rem' }}>
          <p style={{ margin: 0 }}>
            <strong>Visual QA:</strong>{' '}
            <span style={{ color: visualQa.pass ? '#2e7d32' : '#b00020' }}>
              {visualQa.pass ? 'PASS' : 'FAIL'}
            </span>{' '}
            (score {visualQa.overallScore.toFixed(2)})
          </p>
          {Object.keys(visualQa.scores).length > 0 && (
            <ul style={{ margin: '0.25rem 0', paddingLeft: '1.1rem' }}>
              {Object.entries(visualQa.scores).map(([criterion, score]) => (
                <li key={criterion}>
                  {criterion}: {score.toFixed(2)}
                </li>
              ))}
            </ul>
          )}
          {visualQa.defects.length > 0 && (
            <ul style={{ margin: '0.25rem 0', paddingLeft: '1.1rem' }}>
              {visualQa.defects.map((defect, i) => {
                const blocking = defect.severity === 'BLOCKING';
                return (
                  <li
                    key={`${defect.category}-${i}`}
                    style={{ color: blocking ? '#b00020' : '#8a6d00' }}
                  >
                    <strong>{blocking ? 'BLOCKING' : defect.severity}</strong> [{defect.category}]:{' '}
                    {defect.description}
                    {defect.suggestedAction ? ` — ${defect.suggestedAction}` : ''}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : (
        <p style={{ margin: '0 0 0.4rem', color: '#666' }}>Visual QA: not assessed.</p>
      )}
      {continuityQa ? (
        <p style={{ margin: 0 }}>
          <strong>Continuity QA:</strong>{' '}
          <span style={{ color: continuityQa.pass ? '#2e7d32' : '#b00020' }}>
            {continuityQa.pass ? 'PASS' : 'FAIL'}
          </span>{' '}
          (score {continuityQa.overallScore.toFixed(2)})
        </p>
      ) : (
        <p style={{ margin: 0, color: '#666' }}>Continuity QA: not assessed.</p>
      )}
    </div>
  );
}

function CandidateCard({
  candidate,
  isSelected,
  canSelect,
  onSelect,
}: {
  candidate: ShotReviewCandidate;
  isSelected: boolean;
  canSelect: boolean;
  onSelect: () => void;
}) {
  const eligible = candidate.eligibility.eligible;
  return (
    <div
      style={{
        border: isSelected ? '2px solid #2e7d32' : '1px dashed #999',
        borderRadius: 4,
        padding: '0.75rem',
        marginRight: '0.5rem',
        marginBottom: '0.5rem',
        display: 'inline-block',
        verticalAlign: 'top',
        width: 260,
        background: isSelected ? '#f2faf3' : undefined,
      }}
    >
      <p style={{ margin: '0 0 0.4rem', fontWeight: 600 }}>
        Candidate {candidate.candidateIndex}
        {isSelected && <span style={{ color: '#2e7d32' }}> · selected</span>}
      </p>
      <CandidatePlaceholder />
      <p style={{ margin: 0, color: '#666', fontSize: '0.8rem' }}>
        Provider: {candidate.providerId}
      </p>
      <p style={{ margin: 0, color: '#666', fontSize: '0.8rem' }}>
        Seed: {candidate.seed ?? '—'} · {candidate.durationSeconds ?? '—'}s ·{' '}
        {candidate.aspectRatio ?? '—'}
      </p>
      <p style={{ margin: '0 0 0.5rem', color: '#666', fontSize: '0.8rem' }}>
        Status: {candidate.status}
      </p>

      <QaDetails candidate={candidate} />

      {!eligible && (
        <div style={{ marginTop: '0.5rem', color: '#b00020', fontSize: '0.8rem' }}>
          <strong>Ineligible:</strong>
          <ul style={{ margin: '0.25rem 0', paddingLeft: '1.1rem' }}>
            {candidate.eligibility.reasons.map((reason, i) => (
              <li key={i}>{reason}</li>
            ))}
          </ul>
        </div>
      )}

      <button
        type="button"
        disabled={!canSelect || !eligible || isSelected}
        onClick={onSelect}
        style={{ marginTop: '0.5rem', padding: '6px 12px' }}
      >
        {isSelected ? 'Selected' : 'Select this candidate'}
      </button>
    </div>
  );
}

function ShotCard({
  shot,
  editable,
  submitting,
  feedback,
  onFeedbackChange,
  onSelectCandidate,
  onReject,
}: {
  shot: ShotReviewShot;
  editable: boolean;
  submitting: boolean;
  feedback: string;
  onFeedbackChange: (value: string) => void;
  onSelectCandidate: (candidateId: string) => void;
  onReject: () => void;
}) {
  const selection = shot.selection;
  const selectedId = selection?.selectedCandidateId ?? null;
  const status = selection?.status ?? 'PENDING';
  const statusColor =
    status === 'SELECTED' ? '#2e7d32' : status === 'REJECTED' ? '#b00020' : '#8a6d00';

  return (
    <div
      style={{ border: '1px solid #ddd', borderRadius: 6, padding: '1rem', marginBottom: '1rem' }}
    >
      <h3 style={{ marginTop: 0, marginBottom: '0.25rem' }}>
        Shot {shot.index} — {shot.beat}
      </h3>
      <p style={{ margin: '0 0 0.25rem', color: '#666' }}>{shot.description}</p>
      <p style={{ margin: '0 0 0.75rem', color: '#666', fontSize: '0.85rem' }}>
        Beat: {shot.beat} · Duration: {shot.durationFrames} frames
      </p>

      <p style={{ margin: '0 0 0.5rem' }}>
        Selection status: <strong style={{ color: statusColor }}>{status}</strong>
      </p>
      {selection?.rationale && (
        <p style={{ margin: '0 0 0.5rem', color: '#444', fontSize: '0.85rem' }}>
          Rationale: {selection.rationale}
        </p>
      )}
      {selection?.regenerationFeedback && (
        <p style={{ margin: '0 0 0.5rem', color: '#b00020', fontSize: '0.85rem' }}>
          Regeneration feedback: {selection.regenerationFeedback}
        </p>
      )}

      {shot.candidates.length === 0 ? (
        <EmptyState>No candidates generated for this shot yet.</EmptyState>
      ) : (
        <div>
          {shot.candidates.map((candidate) => (
            <CandidateCard
              key={candidate.id}
              candidate={candidate}
              isSelected={selectedId === candidate.id}
              canSelect={editable && !submitting}
              onSelect={() => onSelectCandidate(candidate.id)}
            />
          ))}
        </div>
      )}

      <div style={{ marginTop: '0.75rem' }}>
        <label
          htmlFor={`reject-${shot.shotId}`}
          style={{ display: 'block', marginBottom: 4, fontSize: '0.85rem' }}
        >
          Reject this shot for regeneration (feedback required)
        </label>
        <textarea
          id={`reject-${shot.shotId}`}
          value={feedback}
          onChange={(e) => onFeedbackChange(e.target.value)}
          rows={2}
          disabled={!editable || submitting}
          style={{ width: '100%', padding: 8, boxSizing: 'border-box' }}
        />
        <button
          type="button"
          disabled={!editable || submitting || feedback.trim().length === 0}
          onClick={onReject}
          style={{ marginTop: '0.4rem', padding: '6px 12px' }}
        >
          Reject shot
        </button>
      </div>
    </div>
  );
}

function ShotSelection({ campaignId }: { campaignId: string }) {
  const { workspace, getToken } = useWorkspace();
  const [data, setData] = useState<ShotReviewView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<Record<string, string>>({});
  const draftAttempted = useRef(false);

  async function load() {
    if (!workspace) return;
    const client = createApiClient(workspace.workspaceId, getToken);
    try {
      let result = await client.getShotReview(campaignId);
      // Ensure a working draft exists whenever we're at the human selection stage
      // (the API creates it on demand; guard so we only ever try once per mount).
      if (
        result.selectionSet === null &&
        result.campaign.isSelectionStage &&
        !draftAttempted.current
      ) {
        draftAttempted.current = true;
        await client.createShotSelectionDraft(campaignId);
        result = await client.getShotReview(campaignId);
      }
      setData(result);
      setError(null);
    } catch {
      setError('Could not load the shot selection data.');
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace, getToken, campaignId]);

  function handleActionError(err: unknown) {
    if (err instanceof ApiError) {
      if (err.status === 403) {
        setActionError('Your role cannot make shot selection decisions.');
        return;
      }
      if (err.status === 409) {
        setActionError(`Conflict: ${conflictMessage(err.body)} The view has been refreshed.`);
        return;
      }
    }
    setActionError('The action could not be completed. Please try again.');
  }

  async function runMutation(
    mutate: (
      client: ReturnType<typeof createApiClient>,
      setId: string,
      revision: number,
    ) => Promise<void>,
  ) {
    if (!workspace || submitting) return;
    const set = data?.selectionSet;
    if (!set) return;
    setSubmitting(true);
    setActionError(null);
    setNotice(null);
    const client = createApiClient(workspace.workspaceId, getToken);
    try {
      await mutate(client, set.id, set.revision);
    } catch (err) {
      handleActionError(err);
    } finally {
      // Always reload to pick up the fresh revision (optimistic concurrency).
      await load();
      setSubmitting(false);
    }
  }

  function handleSelect(shotId: string, candidateId: string) {
    void runMutation(async (client, setId, revision) => {
      await client.selectShotCandidate(campaignId, {
        setId,
        shotId,
        candidateId,
        expectedRevision: revision,
      });
      setNotice('Selection saved.');
    });
  }

  function handleReject(shotId: string) {
    const text = (feedback[shotId] ?? '').trim();
    if (text.length === 0) return;
    void runMutation(async (client, setId, revision) => {
      await client.rejectShotCandidate(campaignId, {
        setId,
        shotId,
        regenerationFeedback: text,
        expectedRevision: revision,
      });
      setFeedback((prev) => ({ ...prev, [shotId]: '' }));
      setNotice('Shot rejected for regeneration.');
    });
  }

  function handleApprove() {
    void runMutation(async (client, setId, revision) => {
      await client.approveShotSelection(campaignId, { setId, expectedRevision: revision });
      setNotice('Selection approved — the production workflow will advance to compositing.');
    });
  }

  function handleRequestRegeneration() {
    void runMutation(async (client, setId) => {
      await client.requestShotRegeneration(campaignId, { setId });
      setNotice('Regeneration requested for the rejected shots.');
    });
  }

  if (error) return <ErrorState message={error} />;
  if (!data) return <LoadingState label="Loading shot selection…" />;

  const shots = [...data.shots].sort((a, b) => a.index - b.index);
  const { campaign, selectionSet } = data;
  const setStatus = selectionSet?.status ?? null;
  const editable = campaign.isSelectionStage && setStatus === 'DRAFT';
  const allSelected =
    shots.length > 0 && shots.every((shot) => shot.selection?.status === 'SELECTED');
  const anyRejected = shots.some((shot) => shot.selection?.status === 'REJECTED');

  return (
    <div>
      <section style={{ marginBottom: '1.5rem' }}>
        <h2>Workflow status</h2>
        <p style={{ margin: 0 }}>
          Current stage: <strong>{campaign.currentStage}</strong>
        </p>
        <p style={{ margin: 0 }}>
          Selection set:{' '}
          {selectionSet ? `${setStatus} (revision ${selectionSet.revision})` : 'none'}
        </p>
        {!editable && (
          <p style={{ color: '#8a6d00' }}>
            This campaign is not currently at the human shot-selection stage (or the selection set
            is no longer a draft). Selections are read-only.
          </p>
        )}
        {editable && (
          <p style={{ color: '#666', fontSize: '0.85rem' }}>
            Selections are saved as you go — each choice or rejection is persisted immediately.
          </p>
        )}
      </section>

      <section style={{ marginBottom: '1.5rem' }}>
        <h2>Budget</h2>
        <BudgetRow label="Workspace" status={data.budget.workspace} />
        <BudgetRow label="Campaign" status={data.budget.campaign} />
      </section>

      {actionError && <ErrorState message={actionError} />}
      {notice && <p style={{ color: '#2e7d32' }}>{notice}</p>}

      <section style={{ marginBottom: '1.5rem' }}>
        <h2>Shots</h2>
        {shots.length === 0 && <EmptyState>No shots to review.</EmptyState>}
        {shots.map((shot) => (
          <ShotCard
            key={shot.shotId}
            shot={shot}
            editable={editable}
            submitting={submitting}
            feedback={feedback[shot.shotId] ?? ''}
            onFeedbackChange={(value) => setFeedback((prev) => ({ ...prev, [shot.shotId]: value }))}
            onSelectCandidate={(candidateId) => handleSelect(shot.shotId, candidateId)}
            onReject={() => handleReject(shot.shotId)}
          />
        ))}
      </section>

      <section>
        <h2>Decision</h2>
        <p
          role="note"
          style={{
            color: '#8a6d00',
            background: '#fff8e1',
            padding: '0.75rem',
            borderRadius: 4,
          }}
        >
          Approving the selection advances the production workflow to compositing. Every shot must
          have a selected candidate first.
        </p>
        <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.75rem' }}>
          <button
            type="button"
            disabled={!editable || submitting || !allSelected}
            onClick={handleApprove}
            style={{ padding: '8px 16px' }}
          >
            {submitting ? 'Working…' : 'Approve selection'}
          </button>
          <button
            type="button"
            disabled={!editable || submitting || !anyRejected}
            onClick={handleRequestRegeneration}
            style={{ padding: '8px 16px' }}
          >
            {submitting ? 'Working…' : 'Request regeneration'}
          </button>
        </div>
      </section>
    </div>
  );
}

export default function ShotSelectionPage({ params }: { params: { campaignId: string } }) {
  return (
    <WorkspaceGate>
      <PageShell title="Shot selection">
        <ShotSelection campaignId={params.campaignId} />
      </PageShell>
    </WorkspaceGate>
  );
}
