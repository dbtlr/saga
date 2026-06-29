import { createFileRoute, useRouter } from '@tanstack/react-router';
import { useServerFn } from '@tanstack/react-start';
import { useState, useTransition } from 'react';
import type { FormEvent } from 'react';

import type { ControlPlaneSnapshot } from '../server/control-plane.js';
import {
  getControlPlaneSnapshot,
  reviewClaim,
  saveSourceBinding,
  saveWorkspaceProfile,
} from '../server/functions.js';

export const Route = createFileRoute('/')({
  component: ControlPlaneHome,
  loader: () => getControlPlaneSnapshot(),
});

function ControlPlaneHome() {
  const snapshot = Route.useLoaderData();
  return <ControlPlaneShell snapshot={snapshot} />;
}

function ControlPlaneShell({ snapshot }: { snapshot: ControlPlaneSnapshot }) {
  return (
    <main className="app-shell">
      <header className="top-bar">
        <div>
          <p className="eyebrow">Saga</p>
          <h1>Control Plane</h1>
        </div>
        <StatusPill label={labelForStatus(snapshot.status)} tone={toneForStatus(snapshot.status)} />
      </header>

      <section className="summary-strip" aria-label="Runtime summary">
        <Metric label="Workspace" value={snapshot.binding?.workspace.handle ?? 'Unbound'} />
        <Metric label="Runtime" value={snapshot.runtime.environment} />
        <Metric label="Service" value={snapshot.runtime.serviceUrl} />
        <Metric label="Database" value={snapshot.runtime.database} />
      </section>

      {snapshot.issues.length > 0 ? (
        <section className="issue-band" aria-label="Runtime issues">
          {snapshot.issues.map((issue) => (
            <p key={`${issue.key}:${issue.message}`}>
              <strong>{issue.key}</strong>
              <span>{issue.message}</span>
            </p>
          ))}
        </section>
      ) : null}

      <div className="workspace-grid">
        <section className="surface active-context-surface" aria-labelledby="active-context-title">
          <div className="surface-header">
            <div>
              <p className="eyebrow">Compiled View</p>
              <h2 id="active-context-title">Active Context</h2>
            </div>
            <span>{formatTimestamp(snapshot.generatedAt)}</span>
          </div>
          {snapshot.activeContext === undefined ? (
            <div className="context-preview">
              <EmptyState message="Bind this repo with saga init and configure DATABASE_URL to preview Active Context." />
              <ContextChangeStream snapshot={snapshot} />
            </div>
          ) : (
            <ActiveContextPreview snapshot={snapshot} />
          )}
        </section>

        <aside className="surface side-surface" aria-label="Workspace details">
          <WorkspaceProfilePanel snapshot={snapshot} />
          <SourceBindingsPanel snapshot={snapshot} />
          <section>
            <h2>Claims</h2>
            {snapshot.claims.length === 0 ? (
              <EmptyState message="No current claims projected yet." />
            ) : (
              <ol className="claim-list">
                {snapshot.claims.map((claim) => (
                  <ClaimReviewItem
                    canEdit={snapshot.status === 'ready'}
                    claim={claim}
                    key={claim.key}
                  />
                ))}
              </ol>
            )}
          </section>
        </aside>
      </div>
    </main>
  );
}

function ClaimReviewItem({
  canEdit,
  claim,
}: {
  canEdit: boolean;
  claim: ControlPlaneSnapshot['claims'][number];
}) {
  const router = useRouter();
  const review = useServerFn(reviewClaim);
  const [isPending, startTransition] = useTransition();

  function runReview(
    action: 'accept' | 'pin' | 'promote' | 'reject' | 'unpin' | 'unwatch' | 'watch',
  ) {
    if (!canEdit) {
      return;
    }
    startTransition(async () => {
      await review({
        data: {
          action,
          claimKey: claim.key,
        },
      });
      await router.invalidate();
    });
  }

  return (
    <li className="claim-review-item">
      <div>
        <span>{claim.text}</span>
        <small>
          {claim.state} · {claim.kind} · {Math.round(claim.confidence * 100).toString()}%
        </small>
        {claim.promoted ? (
          <small>{claim.promotionTitle === undefined ? 'Promoted' : claim.promotionTitle}</small>
        ) : null}
      </div>
      <div className="claim-review-actions">
        <button
          disabled={!canEdit || isPending || claim.state === 'supported'}
          onClick={() => runReview('accept')}
          type="button"
        >
          Accept
        </button>
        <button
          className="danger-button"
          disabled={!canEdit || isPending || claim.state === 'rejected'}
          onClick={() => runReview('reject')}
          type="button"
        >
          Reject
        </button>
        <button
          disabled={
            !canEdit ||
            isPending ||
            claim.promoted ||
            claim.state === 'rejected' ||
            claim.state === 'superseded'
          }
          onClick={() => runReview('promote')}
          type="button"
        >
          Promote
        </button>
      </div>
      <div className="claim-review-flags">
        <label>
          <input
            checked={claim.pinned}
            disabled={!canEdit || isPending}
            onChange={(event) =>
              runReview((event.target as HTMLInputElement).checked ? 'pin' : 'unpin')
            }
            type="checkbox"
          />
          <span>Pin</span>
        </label>
        <label>
          <input
            checked={claim.watched}
            disabled={!canEdit || isPending}
            onChange={(event) =>
              runReview((event.target as HTMLInputElement).checked ? 'watch' : 'unwatch')
            }
            type="checkbox"
          />
          <span>Watch</span>
        </label>
      </div>
    </li>
  );
}

function ActiveContextPreview({ snapshot }: { snapshot: ControlPlaneSnapshot }) {
  const context = snapshot.activeContext;
  if (context === undefined) {
    return null;
  }

  return (
    <div className="context-preview">
      <div className="context-sections">
        {context.sections.map((section) => (
          <article className="context-section" key={section.title}>
            <div className="context-section-heading">
              <h3>{section.title}</h3>
              <span>{section.provenance.length.toString()} signals</span>
            </div>
            <ul>
              {section.lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <ProvenanceList provenance={section.provenance} />
          </article>
        ))}
      </div>
      <ContextChangeStream snapshot={snapshot} />
    </div>
  );
}

function ContextChangeStream({ snapshot }: { snapshot: ControlPlaneSnapshot }) {
  return (
    <section className="context-change-stream" aria-labelledby="context-change-title">
      <h3 id="context-change-title">Changed</h3>
      {snapshot.recentActivity.length === 0 ? (
        <EmptyState message="No recent activity captured yet." />
      ) : (
        <ol>
          {snapshot.recentActivity.map((activity) => (
            <li key={activity.id}>
              <span>{formatTimestamp(activity.occurredAt)}</span>
              <strong>{activity.eventType}</strong>
              <small>
                {activity.sourceType}
                {activity.sessionId === undefined ? '' : ` · ${activity.sessionId}`}
              </small>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function ProvenanceList({ provenance }: { provenance: readonly string[] }) {
  if (provenance.length === 0) {
    return <p className="provenance-empty">No provenance recorded.</p>;
  }

  return (
    <dl className="provenance-list">
      {provenance.map((item) => {
        const [kind, ...rest] = item.split(':');
        return (
          <div key={item}>
            <dt>{kind}</dt>
            <dd title={item}>{rest.join(':') || item}</dd>
          </div>
        );
      })}
    </dl>
  );
}

function WorkspaceProfilePanel({ snapshot }: { snapshot: ControlPlaneSnapshot }) {
  const router = useRouter();
  const saveProfile = useServerFn(saveWorkspaceProfile);
  const [displayName, setDisplayName] = useState(snapshot.profile?.displayName ?? '');
  const [summary, setSummary] = useState(snapshot.profile?.summary ?? '');
  const [message, setMessage] = useState('');
  const [isPending, startTransition] = useTransition();
  const canEdit = snapshot.status === 'ready';

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canEdit) {
      return;
    }
    startTransition(async () => {
      await saveProfile({ data: { displayName, summary } });
      setMessage('Saved');
      await router.invalidate();
    });
  }

  return (
    <section>
      <div className="section-heading-row">
        <h2>Workspace</h2>
        <span>{message}</span>
      </div>
      <form className="stack-form" onSubmit={submit}>
        <label>
          <span>Display name</span>
          <input
            disabled={!canEdit || isPending}
            onChange={(event) => setDisplayName((event.target as HTMLInputElement).value)}
            value={displayName}
          />
        </label>
        <label>
          <span>Summary</span>
          <textarea
            disabled={!canEdit || isPending}
            onChange={(event) => setSummary((event.target as HTMLTextAreaElement).value)}
            rows={5}
            value={summary}
          />
        </label>
        <button disabled={!canEdit || isPending} type="submit">
          Save
        </button>
      </form>
      <DefinitionList
        rows={[
          ['Project', snapshot.projectRoot],
          ['Workspace', snapshot.binding?.workspace.id ?? 'Not registered'],
        ]}
      />
    </section>
  );
}

function SourceBindingsPanel({ snapshot }: { snapshot: ControlPlaneSnapshot }) {
  if (snapshot.sourceBindings.length === 0) {
    return (
      <section>
        <h2>Sources</h2>
        <EmptyState message="No source bindings registered yet." />
      </section>
    );
  }

  return (
    <section>
      <h2>Sources</h2>
      <div className="source-list">
        {snapshot.sourceBindings.map((source) => (
          <SourceBindingForm
            canEdit={snapshot.status === 'ready'}
            key={source.id}
            source={source}
          />
        ))}
      </div>
    </section>
  );
}

function SourceBindingForm({
  canEdit,
  source,
}: {
  canEdit: boolean;
  source: ControlPlaneSnapshot['sourceBindings'][number];
}) {
  const router = useRouter();
  const saveBinding = useServerFn(saveSourceBinding);
  const [displayName, setDisplayName] = useState(source.displayName);
  const [enabled, setEnabled] = useState(source.enabled);
  const [message, setMessage] = useState('');
  const [isPending, startTransition] = useTransition();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canEdit) {
      return;
    }
    startTransition(async () => {
      await saveBinding({
        data: {
          displayName,
          enabled,
          id: source.id,
        },
      });
      setMessage('Saved');
      await router.invalidate();
    });
  }

  return (
    <form className="source-binding-form" onSubmit={submit}>
      <div className="source-heading">
        <div>
          <strong>{source.sourceType}</strong>
          <span title={source.sourceUri}>{source.sourceUri}</span>
        </div>
        <label className="toggle-label">
          <input
            checked={enabled}
            disabled={!canEdit || isPending}
            onChange={(event) => setEnabled((event.target as HTMLInputElement).checked)}
            type="checkbox"
          />
          <span>Enabled</span>
        </label>
      </div>
      <label>
        <span>Display name</span>
        <input
          disabled={!canEdit || isPending}
          onChange={(event) => setDisplayName((event.target as HTMLInputElement).value)}
          value={displayName}
        />
      </label>
      <div className="form-actions">
        <small>{message}</small>
        <button disabled={!canEdit || isPending} type="submit">
          Save
        </button>
      </div>
    </form>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong title={value}>{value}</strong>
    </div>
  );
}

function StatusPill({ label, tone }: { label: string; tone: 'ok' | 'warn' | 'error' }) {
  return <span className={`status-pill ${tone}`}>{label}</span>;
}

function DefinitionList({ rows }: { rows: readonly (readonly [string, string])[] }) {
  return (
    <dl className="definition-list">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd title={value}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function EmptyState({ message }: { message: string }) {
  return <p className="empty-state">{message}</p>;
}

function labelForStatus(status: ControlPlaneSnapshot['status']): string {
  if (status === 'ready') {
    return 'Ready';
  }
  if (status === 'unbound') {
    return 'Unbound';
  }
  if (status === 'misconfigured') {
    return 'Misconfigured';
  }
  return 'Offline';
}

function toneForStatus(status: ControlPlaneSnapshot['status']): 'ok' | 'warn' | 'error' {
  if (status === 'ready') {
    return 'ok';
  }
  if (status === 'unbound') {
    return 'warn';
  }
  return 'error';
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}
