'use client';

import { useEffect, useState } from 'react';
import { SessionGate } from '@/components/SessionGate';
import { EmptyState, ErrorState, LoadingState, PageShell } from '@/components/PageShell';
import {
  createApiClient,
  type BudgetStatusView,
  type VariantRowView,
  type VariantsView,
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

function StatusChip({ label, tone }: { label: string; tone: 'ok' | 'warn' | 'neutral' }) {
  const background = tone === 'ok' ? '#e3f5e3' : tone === 'warn' ? '#fbe3e3' : '#efefef';
  const color = tone === 'ok' ? '#1c5c1c' : tone === 'warn' ? '#8a1f1f' : '#555';
  return (
    <span
      style={{
        padding: '1px 6px',
        fontSize: 12,
        background,
        borderRadius: 4,
        color,
        marginLeft: 8,
      }}
    >
      {label}
    </span>
  );
}

/**
 * One variant column. Renders the cut against the parent master's frame space
 * so the 15s / 10s / 6s cuts can be compared side by side — each retained
 * segment drawn proportionally, gaps showing what the cut dropped.
 */
function VariantColumn({ row, frameSpan }: { row: VariantRowView; frameSpan: number }) {
  const { specification: spec, variant, qa, job, attempts } = row;
  const status = variant?.status ?? 'PENDING';
  const tone = status === 'READY' ? 'ok' : status === 'FAILED' ? 'warn' : 'neutral';

  return (
    <div
      style={{
        border: '1px solid #ddd',
        borderRadius: 6,
        padding: '0.75rem',
        flex: '1 1 260px',
        minWidth: 260,
      }}
    >
      <h3 style={{ marginTop: 0 }}>
        {spec.targetDurationSeconds}s<StatusChip label={status} tone={tone} />
        {spec.superseded && <StatusChip label="superseded" tone="neutral" />}
      </h3>
      <p style={{ color: '#555', fontSize: 13, margin: '0 0 0.5rem' }}>
        v{spec.version} · {spec.platform} · {spec.aspectRatio} · {spec.resolutionWidth}×
        {spec.resolutionHeight} · {spec.frameRate}fps · {spec.targetDurationFrames} frames
      </p>

      {/* Cut map: retained source ranges drawn against the master's frame span. */}
      <div
        aria-label={`Cut map for the ${spec.targetDurationSeconds}s variant`}
        style={{
          position: 'relative',
          height: 18,
          background: '#f2f2f2',
          borderRadius: 3,
          overflow: 'hidden',
          marginBottom: '0.5rem',
        }}
      >
        {spec.cutPoints.map((cut) => (
          <div
            key={cut.order}
            title={`source ${cut.sourceStartFrame}–${cut.sourceEndFrame}`}
            style={{
              position: 'absolute',
              left: `${(cut.sourceStartFrame / frameSpan) * 100}%`,
              width: `${((cut.sourceEndFrame - cut.sourceStartFrame) / frameSpan) * 100}%`,
              top: 0,
              bottom: 0,
              background: '#8ab4f8',
            }}
          />
        ))}
      </div>

      <details>
        <summary>Cut points ({spec.cutPoints.length})</summary>
        <ul style={{ fontSize: 13 }}>
          {spec.cutPoints.map((cut) => (
            <li key={cut.order}>
              source {cut.sourceStartFrame}–{cut.sourceEndFrame} → variant @{cut.variantStartFrame}
            </li>
          ))}
        </ul>
      </details>

      <details>
        <summary>Retained shots ({spec.retainedClips.length})</summary>
        <ul style={{ fontSize: 13 }}>
          {spec.retainedClips.map((clip) => (
            <li key={clip.order}>
              #{clip.shotIndex} {clip.beat ?? ''} ({clip.sourceStartFrame}–{clip.sourceEndFrame})
            </li>
          ))}
        </ul>
      </details>

      <details>
        <summary>Captions &amp; safe areas</summary>
        <p style={{ fontSize: 13 }}>
          Caption burn required: <strong>{spec.captionBurnRequired ? 'yes' : 'no'}</strong> · safe
          areas: {spec.safeAreas.join(', ') || '—'}
        </p>
        <ul style={{ fontSize: 13 }}>
          {spec.retainedCaptions.map((caption, i) => (
            <li key={i}>
              “{caption.text}” @{caption.variantStartFrame}–{caption.variantEndFrame} (
              {caption.safeArea})
            </li>
          ))}
        </ul>
      </details>

      <p style={{ fontSize: 13 }}>
        <strong>CTA:</strong>{' '}
        {spec.ctaPlacement.present
          ? `retained @${spec.ctaPlacement.variantStartFrame}–${spec.ctaPlacement.variantEndFrame}`
          : 'not retained (permitted below the profile minimum)'}
      </p>

      <p style={{ fontSize: 13, color: '#555' }}>{spec.cutRationale}</p>
      {spec.removedRationale.length > 0 && (
        <details>
          <summary>What was removed</summary>
          <ul style={{ fontSize: 13 }}>
            {spec.removedRationale.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </details>
      )}

      {/* Preview placeholder — mock renders carry no bytes. */}
      <div
        style={{
          padding: '1.25rem',
          background: '#efefef',
          borderRadius: 4,
          color: '#555',
          textAlign: 'center',
          fontSize: 13,
          margin: '0.5rem 0',
        }}
      >
        {variant?.assetId
          ? 'Preview placeholder — no rendered video (no render worker connected).'
          : 'Not rendered yet.'}
      </div>

      <p style={{ fontSize: 13 }}>
        <strong>Variant QA:</strong>{' '}
        {qa ? `${qa.pass ? 'passed' : 'failed'} (${qa.overallScore.toFixed(2)})` : 'not run yet'}
      </p>
      {qa && qa.findings.length > 0 && (
        <ul style={{ fontSize: 13 }}>
          {qa.findings.map((f) => (
            <li key={f.id}>
              <strong>{f.severity}</strong> · {f.category} — {f.description}
              {f.suggestedAction ? ` (${f.suggestedAction})` : ''}
            </li>
          ))}
        </ul>
      )}

      {job && (
        <p style={{ fontSize: 13, color: '#555' }}>
          Render job {job.status} · attempt {job.attemptCount}/{job.maxAttempts}
        </p>
      )}
      {attempts.length > 0 && (
        <details>
          <summary>Attempts ({attempts.length})</summary>
          <ul style={{ fontSize: 13 }}>
            {attempts.map((a) => (
              <li key={a.attemptNumber}>
                #{a.attemptNumber} {a.status}
                {a.actualCostCents !== null
                  ? ` · ${(a.actualCostCents / 100).toFixed(2)} spent`
                  : ''}
                {a.failureReason ? ` · ${a.failureReason}: ${a.failureMessage ?? ''}` : ''}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function Variants({ campaignId }: { campaignId: string }) {
  const { session } = useSession();
  const [data, setData] = useState<VariantsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  async function load() {
    if (!session) return;
    const client = createApiClient(session.workspaceId, session.userId);
    try {
      setData(await client.getVariants(campaignId));
      setError(null);
    } catch {
      setError('Could not load the variant status.');
    }
  }

  useEffect(() => {
    load();
    const id = setInterval(load, POLL_INTERVAL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, campaignId]);

  async function cancel() {
    if (!session) return;
    setCancelling(true);
    setNotice(null);
    const client = createApiClient(session.workspaceId, session.userId);
    try {
      await client.cancelVariants(campaignId);
      setNotice('Cancellation requested.');
      await load();
    } catch {
      setNotice('The cancellation could not be submitted.');
    } finally {
      setCancelling(false);
    }
  }

  if (error) return <ErrorState message={error} />;
  if (!data) return <LoadingState label="Loading variants…" />;

  const { campaign, caller, variants, budget } = data;
  // Compare every cut against the longest one's source span.
  const frameSpan = Math.max(
    1,
    ...variants.flatMap((v) => v.specification.cutPoints.map((c) => c.sourceEndFrame)),
  );

  return (
    <div>
      <p>
        Stage: <strong>{campaign.currentStage}</strong>
        {!campaign.isVariantStage && (
          <span style={{ color: '#666' }}> (not currently in variant generation)</span>
        )}
      </p>

      {variants.length === 0 && (
        <EmptyState>No delivery variants have been cut for this campaign yet.</EmptyState>
      )}

      {variants.length > 0 && (
        <section style={{ marginBottom: '1.5rem' }}>
          <h2>
            Delivery variants ({variants[0]!.specification.deliveryProfileKey} v
            {variants[0]!.specification.deliveryProfileVersion})
          </h2>
          <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'flex-start' }}>
            {variants.map((row) => (
              <VariantColumn key={row.specification.id} row={row} frameSpan={frameSpan} />
            ))}
          </div>
        </section>
      )}

      <section style={{ marginBottom: '1.5rem' }}>
        <h2>Actions</h2>
        {!caller.canCancel && (
          <p style={{ color: '#a00' }}>
            Your role ({caller.role}) cannot cancel an active variant run.
          </p>
        )}
        <button type="button" disabled={!caller.canCancel || cancelling} onClick={cancel}>
          Cancel active variant run
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

export default function VariantsPage({ params }: { params: { campaignId: string } }) {
  return (
    <SessionGate>
      <PageShell title="Delivery variants">
        <Variants campaignId={params.campaignId} />
      </PageShell>
    </SessionGate>
  );
}
