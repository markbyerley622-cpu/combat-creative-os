'use client';

import { useEffect, useRef, useState } from 'react';
import { SessionGate } from '@/components/SessionGate';
import { EmptyState, ErrorState, LoadingState, PageShell } from '@/components/PageShell';
import {
  ApiError,
  createApiClient,
  type BudgetStatusView,
  type CompositingView,
  type CompositionAttemptView,
  type RoughEditSpecView,
} from '@/lib/api-client';
import { useSession } from '@/lib/session';

const POLL_INTERVAL_MS = 4000;

/** Attempt statuses that mean a render is still in flight and can therefore be cancelled. */
const NON_TERMINAL_ATTEMPT_STATUSES = ['QUEUED', 'SUBMITTED', 'POLLING'];

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

/**
 * Never a `<video>` — the rough-edit render carries no real media
 * (`roughEdit.hasMedia` is always `false`, mirroring the mock providers used
 * elsewhere). A deterministic placeholder box is the only honest rendering.
 */
function RoughEditPlaceholder({ assetId }: { assetId: string | null }) {
  return (
    <div
      style={{
        height: 160,
        borderRadius: 4,
        marginBottom: '0.5rem',
        background:
          'repeating-linear-gradient(45deg, #f0f0f0, #f0f0f0 10px, #e6e6e6 10px, #e6e6e6 20px)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#999',
        fontSize: '0.8rem',
        fontStyle: 'italic',
      }}
    >
      <span>No preview available (mock compositor — no real media rendered)</span>
      {assetId && (
        <span style={{ marginTop: '0.4rem', fontStyle: 'normal' }}>Asset: {assetId}</span>
      )}
    </div>
  );
}

function RoughEditSpecification({ spec }: { spec: RoughEditSpecView }) {
  return (
    <div>
      <section style={{ marginBottom: '1.5rem' }}>
        <h2>Rough-edit specification</h2>
        <p style={{ margin: '0 0 0.25rem' }}>
          <strong>Version:</strong> {spec.version}
        </p>
        <p style={{ margin: '0 0 0.25rem' }}>
          <strong>Output:</strong> {spec.outputFormat} · {spec.aspectRatio} · {spec.resolutionWidth}
          x{spec.resolutionHeight} · {spec.frameRate} fps
        </p>
        <p style={{ margin: '0 0 0.25rem' }}>
          <strong>Target duration:</strong> {spec.targetDurationFrames} frames
        </p>
        <p style={{ margin: '0 0 0.25rem' }}>
          <strong>Platform:</strong> {spec.platform}
        </p>
        <p style={{ margin: '0 0 0.25rem', color: '#666', fontSize: '0.9rem' }}>
          Built from selection set {spec.shotSelectionSetId} v{spec.shotSelectionSetVersion}
        </p>
      </section>

      <section style={{ marginBottom: '1.5rem' }}>
        <h2>Timeline</h2>
        {spec.clips.length === 0 ? (
          <EmptyState>No clips in the timeline.</EmptyState>
        ) : (
          <ol style={{ paddingLeft: '1.2rem' }}>
            {[...spec.clips]
              .sort((a, b) => a.order - b.order)
              .map((clip) => (
                <li key={clip.order} style={{ marginBottom: '0.4rem' }}>
                  Shot {clip.shotIndex} · {clip.durationFrames} frames · source {clip.sourceAssetId}
                  {clip.transitionIn ? ` · transition in: ${clip.transitionIn}` : ''}
                </li>
              ))}
          </ol>
        )}
      </section>

      {spec.overlays.length > 0 && (
        <section style={{ marginBottom: '1.5rem' }}>
          <h2>Overlays</h2>
          <ul style={{ paddingLeft: '1.2rem' }}>
            {spec.overlays.map((overlay, i) => (
              <li key={`${overlay.kind}-${i}`} style={{ marginBottom: '0.3rem' }}>
                <strong>{overlay.kind}</strong>
                {overlay.shotIndex !== undefined ? ` (shot ${overlay.shotIndex})` : ''}:{' '}
                {overlay.description}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section style={{ marginBottom: '1.5rem' }}>
        <h2>Editorial notes</h2>
        <p style={{ margin: '0 0 0.5rem' }}>
          <strong>Pacing:</strong> {spec.pacingNotes}
        </p>
        {spec.continuityNotes.length > 0 && (
          <div style={{ marginBottom: '0.5rem' }}>
            <strong>Continuity:</strong>
            <ul style={{ margin: '0.25rem 0', paddingLeft: '1.2rem' }}>
              {spec.continuityNotes.map((note, i) => (
                <li key={i}>{note}</li>
              ))}
            </ul>
          </div>
        )}
        <p style={{ margin: '0 0 0.5rem' }}>
          <strong>Edit rationale:</strong> {spec.editRationale}
        </p>
      </section>

      <section style={{ marginBottom: '1.5rem' }}>
        <h2>Placeholders</h2>
        <p style={{ margin: '0 0 0.25rem', color: '#666' }}>
          <strong>Caption:</strong> {spec.captionPlaceholder}
        </p>
        <p style={{ margin: '0 0 0.25rem', color: '#666' }}>
          <strong>Music:</strong> {spec.musicPlaceholder}
        </p>
        <p style={{ margin: '0 0 0.25rem', color: '#666' }}>
          <strong>SFX:</strong> {spec.sfxPlaceholder}
        </p>
      </section>

      {spec.qualityRubric.length > 0 && (
        <section style={{ marginBottom: '1.5rem' }}>
          <h2>Quality rubric</h2>
          <ul style={{ paddingLeft: '1.2rem' }}>
            {spec.qualityRubric.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function AttemptRow({ attempt }: { attempt: CompositionAttemptView }) {
  const isFailure = attempt.failureReason !== null || attempt.failureMessage !== null;
  return (
    <li style={{ marginBottom: '0.5rem', fontSize: '0.9rem' }}>
      <strong>#{attempt.attemptNumber}</strong>: {attempt.status} · provider {attempt.providerId}
      {attempt.estimatedCostCents !== null
        ? ` · est. ${(attempt.estimatedCostCents / 100).toFixed(2)}`
        : ''}
      {attempt.actualCostCents !== null
        ? ` · actual ${(attempt.actualCostCents / 100).toFixed(2)}`
        : ''}
      {isFailure && (
        <div style={{ color: '#b00020', marginTop: '0.2rem' }}>
          <strong>Failure</strong>
          {attempt.failureReason ? ` [${attempt.failureReason}]` : ''}
          {attempt.failureMessage ? `: ${attempt.failureMessage}` : ''}
        </div>
      )}
    </li>
  );
}

function Compositing({ campaignId }: { campaignId: string }) {
  const { session } = useSession();
  const [data, setData] = useState<CompositingView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const cancelledRef = useRef(false);

  async function load() {
    if (!session) return;
    const client = createApiClient(session.workspaceId, session.userId);
    try {
      const result = await client.getCompositing(campaignId);
      if (!cancelledRef.current) {
        setData(result);
        setError(null);
      }
    } catch {
      if (!cancelledRef.current) setError('Could not load compositing progress.');
    }
  }

  useEffect(() => {
    cancelledRef.current = false;
    load();
    const interval = setInterval(load, POLL_INTERVAL_MS);
    return () => {
      cancelledRef.current = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, campaignId]);

  async function handleCancel() {
    if (!session || submitting) return;
    setSubmitting(true);
    setActionError(null);
    setNotice(null);
    const client = createApiClient(session.workspaceId, session.userId);
    try {
      await client.cancelCompositing(campaignId);
      setNotice('Cancellation requested.');
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setActionError('Your role cannot cancel renders.');
      } else {
        setActionError('The render could not be cancelled. Please try again.');
      }
    } finally {
      await load();
      setSubmitting(false);
    }
  }

  if (error) return <ErrorState message={error} />;
  if (!data) return <LoadingState label="Loading compositing progress…" />;

  const { campaign, roughEditSpecification, compositionJob, attempts, roughEdit, budget } = data;
  const canCancel = attempts.some((attempt) =>
    NON_TERMINAL_ATTEMPT_STATUSES.includes(attempt.status),
  );

  return (
    <div>
      <section style={{ marginBottom: '1.5rem' }}>
        <h2>Workflow status</h2>
        <p style={{ margin: 0 }}>
          Current stage: <strong>{campaign.currentStage}</strong>
        </p>
        {!campaign.isCompositingStage && (
          <p style={{ color: '#8a6d00' }}>
            This campaign is not currently at the compositing stage — the view is read-only.
          </p>
        )}
      </section>

      <section style={{ marginBottom: '1.5rem' }}>
        <h2>Budget</h2>
        <BudgetRow label="Workspace" status={budget.workspace} />
        <BudgetRow label="Campaign" status={budget.campaign} />
      </section>

      {actionError && <ErrorState message={actionError} />}
      {notice && <p style={{ color: '#2e7d32' }}>{notice}</p>}

      {!roughEditSpecification ? (
        <EmptyState>Compositing has not produced a rough edit yet.</EmptyState>
      ) : (
        <div>
          <section style={{ marginBottom: '1.5rem' }}>
            <h2>Rough-edit render</h2>
            <RoughEditPlaceholder assetId={roughEdit.assetId} />
          </section>

          <RoughEditSpecification spec={roughEditSpecification} />

          <section style={{ marginBottom: '1.5rem' }}>
            <h2>Composition job</h2>
            {compositionJob ? (
              <p style={{ margin: '0 0 0.75rem' }}>
                Status: <strong>{compositionJob.status}</strong> (attempt{' '}
                {compositionJob.attemptCount} of {compositionJob.maxAttempts})
              </p>
            ) : (
              <EmptyState>No composition job has started yet.</EmptyState>
            )}

            {attempts.length > 0 && (
              <div>
                <p style={{ marginBottom: 4 }}>
                  <strong>Attempt history</strong>
                </p>
                <ul style={{ marginTop: 0, paddingLeft: '1.2rem' }}>
                  {[...attempts]
                    .sort((a, b) => a.attemptNumber - b.attemptNumber)
                    .map((attempt) => (
                      <AttemptRow key={attempt.id} attempt={attempt} />
                    ))}
                </ul>
              </div>
            )}

            {canCancel && (
              <button
                type="button"
                disabled={submitting}
                onClick={handleCancel}
                style={{ marginTop: '0.5rem', padding: '8px 16px' }}
              >
                {submitting ? 'Working…' : 'Cancel render'}
              </button>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

export default function CompositingPage({ params }: { params: { campaignId: string } }) {
  return (
    <SessionGate>
      <PageShell title="Compositing">
        <Compositing campaignId={params.campaignId} />
      </PageShell>
    </SessionGate>
  );
}
