import { createFileRoute } from "@tanstack/react-router";
import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState, useTransition, type FormEvent } from "react";
import {
  getControlPlaneSnapshot,
  saveSourceBinding,
  saveWorkspaceProfile,
} from "../server/functions.js";
import type { ControlPlaneSnapshot } from "../server/control-plane.js";

export const Route = createFileRoute("/")({
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
        <Metric label="Workspace" value={snapshot.binding?.workspace.handle ?? "Unbound"} />
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
            <EmptyState message="Bind this repo with saga init and configure DATABASE_URL to preview Active Context." />
          ) : (
            <div className="context-sections">
              {snapshot.activeContext.sections.map((section) => (
                <article className="context-section" key={section.title}>
                  <h3>{section.title}</h3>
                  <ul>
                    {section.lines.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </article>
              ))}
            </div>
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
                  <li key={claim.key}>
                    <span>{claim.text}</span>
                    <small>
                      {claim.state} · {Math.round(claim.confidence * 100).toString()}%
                    </small>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </aside>
      </div>
    </main>
  );
}

function WorkspaceProfilePanel({ snapshot }: { snapshot: ControlPlaneSnapshot }) {
  const router = useRouter();
  const saveProfile = useServerFn(saveWorkspaceProfile);
  const [displayName, setDisplayName] = useState(snapshot.profile?.displayName ?? "");
  const [summary, setSummary] = useState(snapshot.profile?.summary ?? "");
  const [message, setMessage] = useState("");
  const [isPending, startTransition] = useTransition();
  const canEdit = snapshot.status === "ready";

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canEdit) return;
    startTransition(async () => {
      await saveProfile({ data: { displayName, summary } });
      setMessage("Saved");
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
          ["Project", snapshot.projectRoot],
          ["Workspace", snapshot.binding?.workspace.id ?? "Not registered"],
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
            canEdit={snapshot.status === "ready"}
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
  source: ControlPlaneSnapshot["sourceBindings"][number];
}) {
  const router = useRouter();
  const saveBinding = useServerFn(saveSourceBinding);
  const [displayName, setDisplayName] = useState(source.displayName);
  const [enabled, setEnabled] = useState(source.enabled);
  const [message, setMessage] = useState("");
  const [isPending, startTransition] = useTransition();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canEdit) return;
    startTransition(async () => {
      await saveBinding({
        data: {
          displayName,
          enabled,
          id: source.id,
        },
      });
      setMessage("Saved");
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

function StatusPill({ label, tone }: { label: string; tone: "ok" | "warn" | "error" }) {
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

function labelForStatus(status: ControlPlaneSnapshot["status"]): string {
  if (status === "ready") return "Ready";
  if (status === "unbound") return "Unbound";
  if (status === "misconfigured") return "Misconfigured";
  return "Offline";
}

function toneForStatus(status: ControlPlaneSnapshot["status"]): "ok" | "warn" | "error" {
  if (status === "ready") return "ok";
  if (status === "unbound") return "warn";
  return "error";
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
