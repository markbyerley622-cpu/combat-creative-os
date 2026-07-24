'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { SessionGate } from '@/components/SessionGate';
import { ErrorState, LoadingState, PageShell } from '@/components/PageShell';
import {
  ApiError,
  ASPECT_RATIO_OPTIONS,
  DELIVERY_PLATFORM_OPTIONS,
  createApiClient,
} from '@/lib/api-client';
import { EMPTY_DRAFT, fromLoadedBrief, toContent, type DraftFields } from '@/lib/brief-form';
import { useSession } from '@/lib/session';

function textField(
  label: string,
  key: keyof DraftFields,
  draft: DraftFields,
  setDraft: (d: DraftFields) => void,
  options: { multiline?: boolean; placeholder?: string } = {},
) {
  const value = draft[key] as string;
  const commonProps = {
    id: key,
    value: value ?? '',
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setDraft({ ...draft, [key]: e.target.value }),
    style: { width: '100%', padding: 8, fontFamily: 'inherit' },
    placeholder: options.placeholder,
  };
  return (
    <div style={{ marginBottom: '1rem' }} key={key}>
      <label htmlFor={key} style={{ display: 'block', marginBottom: 4 }}>
        {label}
      </label>
      {options.multiline ? (
        <textarea {...commonProps} rows={3} />
      ) : (
        <input {...commonProps} type="text" />
      )}
    </div>
  );
}

function BriefEditor({ campaignId }: { campaignId: string }) {
  const { session } = useSession();
  const router = useRouter();
  const [draft, setDraft] = useState<DraftFields>(EMPTY_DRAFT);
  const [loading, setLoading] = useState(true);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validationIssues, setValidationIssues] = useState<string[]>([]);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    if (!session) return;
    const client = createApiClient(session.workspaceId, session.userId);
    client
      .getBrief(campaignId)
      .then((res) => {
        if (res.brief) {
          setDraft(fromLoadedBrief(res.brief));
          setSubmitted(res.brief.acceptedAt !== null);
        }
      })
      .catch(() => setError('Could not load the existing brief.'))
      .finally(() => setLoading(false));
  }, [session, campaignId]);

  function toggleMulti<T extends string>(key: keyof DraftFields, value: T) {
    const current = draft[key] as T[];
    const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
    setDraft({ ...draft, [key]: next });
  }

  async function handleSaveDraft(event: FormEvent) {
    event.preventDefault();
    if (!session) return;
    setStatus('saving');
    setError(null);
    try {
      const client = createApiClient(session.workspaceId, session.userId);
      await client.saveDraftBrief(campaignId, toContent(draft));
      setStatus('saved');
    } catch {
      setError('Could not save the draft.');
      setStatus(null);
    }
  }

  async function handleSubmitBrief(event: FormEvent) {
    event.preventDefault();
    if (!session) return;
    setStatus('submitting');
    setError(null);
    setValidationIssues([]);
    try {
      const client = createApiClient(session.workspaceId, session.userId);
      await client.submitBrief(campaignId, toContent(draft));
      await client.startWorkflow(campaignId);
      setSubmitted(true);
      setStatus(null);
      router.push(`/campaigns/${campaignId}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        const issues =
          (err.body as { issues?: { message: string; path: unknown[] }[] })?.issues ?? [];
        setValidationIssues(issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`));
        setError('The brief is missing required fields.');
      } else if (err instanceof ApiError && err.status === 409) {
        setError('This brief has already been submitted.');
      } else {
        setError('Could not submit the brief.');
      }
      setStatus(null);
    }
  }

  if (loading) return <LoadingState label="Loading brief…" />;

  return (
    <>
      {error && <ErrorState message={error} />}
      {validationIssues.length > 0 && (
        <ul style={{ color: '#b00020' }}>
          {validationIssues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}
      {submitted && (
        <p style={{ color: '#2e7d32' }}>
          This brief has been submitted and accepted. Further changes create a new campaign.
        </p>
      )}
      <form onSubmit={handleSubmitBrief}>
        {textField('Campaign name', 'campaignName', draft, setDraft)}
        {textField('Product name', 'productName', draft, setDraft)}
        {textField('Product description', 'productDescription', draft, setDraft, {
          multiline: true,
        })}
        {textField('Objective', 'objective', draft, setDraft)}
        {textField('Target audience', 'targetAudience', draft, setDraft)}
        {textField('Customer problem', 'customerProblem', draft, setDraft, { multiline: true })}
        {textField('Value proposition', 'valueProposition', draft, setDraft, { multiline: true })}
        {textField('Product features', 'productFeatures', draft, setDraft, {
          placeholder: 'comma-separated',
        })}

        <fieldset style={{ marginBottom: '1rem', border: '1px solid #ddd', padding: '0.75rem' }}>
          <legend>Platforms</legend>
          {DELIVERY_PLATFORM_OPTIONS.map((platform) => (
            <label key={platform} style={{ marginRight: '1rem' }}>
              <input
                type="checkbox"
                checked={draft.targetPlatforms.includes(platform)}
                onChange={() => toggleMulti('targetPlatforms', platform)}
              />{' '}
              {platform}
            </label>
          ))}
        </fieldset>

        <fieldset style={{ marginBottom: '1rem', border: '1px solid #ddd', padding: '0.75rem' }}>
          <legend>Aspect ratios</legend>
          {ASPECT_RATIO_OPTIONS.map((ratio) => (
            <label key={ratio} style={{ marginRight: '1rem' }}>
              <input
                type="checkbox"
                checked={draft.aspectRatios.includes(ratio)}
                onChange={() => toggleMulti('aspectRatios', ratio)}
              />{' '}
              {ratio}
            </label>
          ))}
        </fieldset>

        {textField('Durations (seconds)', 'durationsSeconds', draft, setDraft, {
          placeholder: 'e.g. 15, 10, 6',
        })}
        {textField('Brand voice', 'brandVoice', draft, setDraft)}
        {textField('Visual direction', 'visualDirection', draft, setDraft, { multiline: true })}
        {textField('Required messaging', 'requiredMessaging', draft, setDraft, {
          placeholder: 'comma-separated',
        })}
        {textField('Call to action', 'callToAction', draft, setDraft)}
        {textField('References', 'references', draft, setDraft, {
          placeholder: 'comma-separated URLs/notes',
        })}
        {textField('Asset references', 'assetReferences', draft, setDraft, {
          placeholder: 'comma-separated',
        })}
        {textField('Prohibited claims / content', 'prohibitedClaims', draft, setDraft, {
          placeholder: 'comma-separated',
        })}

        <div style={{ marginBottom: '1rem' }}>
          <label htmlFor="budgetCents" style={{ display: 'block', marginBottom: 4 }}>
            Budget (cents)
          </label>
          <input
            id="budgetCents"
            type="number"
            value={draft.budgetCents}
            onChange={(e) => setDraft({ ...draft, budgetCents: Number(e.target.value) })}
            style={{ width: '100%', maxWidth: 200, padding: 8 }}
          />
        </div>

        {textField('Locale', 'locale', draft, setDraft)}
        {textField('Notes', 'notes', draft, setDraft, { multiline: true })}

        <div style={{ display: 'flex', gap: '0.75rem' }}>
          <button
            type="button"
            onClick={handleSaveDraft}
            disabled={status !== null}
            style={{ padding: '8px 16px' }}
          >
            {status === 'saving' ? 'Saving…' : 'Save draft'}
          </button>
          <button type="submit" disabled={status !== null} style={{ padding: '8px 16px' }}>
            {status === 'submitting' ? 'Submitting…' : 'Submit brief & start production'}
          </button>
        </div>
        {status === 'saved' && <p style={{ color: '#2e7d32' }}>Draft saved.</p>}
      </form>
    </>
  );
}

export default function BriefPage({ params }: { params: { campaignId: string } }) {
  return (
    <SessionGate>
      <PageShell title="Campaign brief">
        <BriefEditor campaignId={params.campaignId} />
      </PageShell>
    </SessionGate>
  );
}
