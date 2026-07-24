'use client';

import { useEffect, useState } from 'react';
import { SessionGate } from '@/components/SessionGate';
import { EmptyState, ErrorState, LoadingState, PageShell } from '@/components/PageShell';
import {
  ApiError,
  createApiClient,
  type ConceptApprovalState,
  type CreativeConcept,
  type Script,
  type Shot,
  type Strategy,
} from '@/lib/api-client';
import { useSession } from '@/lib/session';

type Decision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REJECTED';

interface LoadedData {
  strategy: Strategy | null;
  concept: CreativeConcept | null;
  script: Script | null;
  shots: Shot[];
  approvalState: ConceptApprovalState;
}

function ConceptReview({ campaignId }: { campaignId: string }) {
  const { session } = useSession();
  const [data, setData] = useState<LoadedData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [comments, setComments] = useState('');
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [submittingDecision, setSubmittingDecision] = useState<Decision | null>(null);
  const [decided, setDecided] = useState<Decision | null>(null);

  async function load() {
    if (!session) return;
    const client = createApiClient(session.workspaceId, session.userId);
    try {
      const [strategyRes, conceptRes, scriptRes, approvalState] = await Promise.all([
        client.getStrategy(campaignId),
        client.getConcept(campaignId),
        client.getScript(campaignId),
        client.getConceptApprovalState(campaignId),
      ]);
      setData({
        strategy: strategyRes.strategy,
        concept: conceptRes.concept,
        script: scriptRes.script,
        shots: scriptRes.shots,
        approvalState,
      });
      setError(null);
    } catch {
      setError('Could not load the concept review data.');
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, campaignId]);

  async function handleDecision(decision: Decision) {
    if (!session) return;
    if (decision !== 'APPROVED' && comments.trim().length === 0) {
      setDecisionError(
        'Revision instructions are required for changes-requested or rejected decisions.',
      );
      return;
    }
    setDecisionError(null);
    setSubmittingDecision(decision);
    try {
      const client = createApiClient(session.workspaceId, session.userId);
      await client.decideConceptApproval(campaignId, decision, comments.trim() || undefined);
      setDecided(decision);
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setDecisionError('Your role cannot decide the concept approval gate.');
      } else {
        setDecisionError('Could not record the decision.');
      }
    } finally {
      setSubmittingDecision(null);
    }
  }

  if (error) return <ErrorState message={error} />;
  if (!data) return <LoadingState label="Loading concept review…" />;

  const { strategy, concept, script, shots, approvalState } = data;
  const isPending = approvalState.isPending;

  return (
    <div>
      {!isPending && (
        <p style={{ color: '#666' }}>
          This campaign is not currently awaiting a CONCEPT decision (stage:{' '}
          {approvalState.currentStage}).
        </p>
      )}
      {decided && <p style={{ color: '#2e7d32' }}>Decision recorded: {decided}.</p>}

      <section style={{ marginBottom: '1.5rem' }}>
        <h2>Strategy</h2>
        {!strategy && <EmptyState>Strategy has not been generated yet.</EmptyState>}
        {strategy && (
          <div>
            <p>
              <strong>Positioning:</strong> {strategy.positioning}
            </p>
            <p>
              <strong>Target audience:</strong> {strategy.targetAudienceSummary}
            </p>
            <p>
              <strong>Key messages:</strong> {strategy.keyMessages.join('; ')}
            </p>
            <p>
              <strong>Tone:</strong> {strategy.toneGuidelines.join('; ')}
            </p>
          </div>
        )}
      </section>

      <section style={{ marginBottom: '1.5rem' }}>
        <h2>Concept</h2>
        {!concept && <EmptyState>A concept has not been generated yet.</EmptyState>}
        {concept && (
          <div>
            <p>
              <strong>Logline:</strong> {concept.logline}
            </p>
            <p>
              <strong>Visual direction:</strong> {concept.visualDirection}
            </p>
            <p>
              <strong>Narrative arc:</strong> {concept.narrativeArc}
            </p>
            {concept.referenceNotes.length > 0 && (
              <p>
                <strong>Reference notes:</strong> {concept.referenceNotes.join('; ')}
              </p>
            )}
          </div>
        )}
      </section>

      <section style={{ marginBottom: '1.5rem' }}>
        <h2>Timed script</h2>
        {!script && <EmptyState>A script has not been generated yet.</EmptyState>}
        {script && (
          <div>
            <p>Total duration: {script.totalDurationFrames} frames</p>
            <ol>
              {shots.map((shot) => (
                <li key={shot.id} style={{ marginBottom: '0.5rem' }}>
                  <strong>[{shot.beat}]</strong> {shot.description} ({shot.durationFrames}f)
                </li>
              ))}
            </ol>
          </div>
        )}
      </section>

      <section>
        <h2>Decision</h2>
        <div style={{ marginBottom: '1rem' }}>
          <label htmlFor="comments" style={{ display: 'block', marginBottom: 4 }}>
            Revision instructions (required for changes requested / rejected)
          </label>
          <textarea
            id="comments"
            value={comments}
            onChange={(e) => setComments(e.target.value)}
            rows={3}
            style={{ width: '100%', padding: 8 }}
          />
        </div>
        {decisionError && <ErrorState message={decisionError} />}
        <div style={{ display: 'flex', gap: '0.75rem' }}>
          <button
            type="button"
            disabled={!isPending || submittingDecision !== null}
            onClick={() => handleDecision('APPROVED')}
            style={{ padding: '8px 16px' }}
          >
            {submittingDecision === 'APPROVED' ? 'Approving…' : 'Approve'}
          </button>
          <button
            type="button"
            disabled={!isPending || submittingDecision !== null}
            onClick={() => handleDecision('CHANGES_REQUESTED')}
            style={{ padding: '8px 16px' }}
          >
            {submittingDecision === 'CHANGES_REQUESTED' ? 'Requesting…' : 'Request revision'}
          </button>
          <button
            type="button"
            disabled={!isPending || submittingDecision !== null}
            onClick={() => handleDecision('REJECTED')}
            style={{ padding: '8px 16px' }}
          >
            {submittingDecision === 'REJECTED' ? 'Rejecting…' : 'Reject'}
          </button>
        </div>
      </section>
    </div>
  );
}

export default function ConceptReviewPage({ params }: { params: { campaignId: string } }) {
  return (
    <SessionGate>
      <PageShell title="Concept review">
        <ConceptReview campaignId={params.campaignId} />
      </PageShell>
    </SessionGate>
  );
}
