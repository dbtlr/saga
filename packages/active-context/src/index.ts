export const packageName = '@saga/active-context';

export type ActiveContextClaimInput = {
  claimKind: string;
  claimKey: string;
  claimText: string;
  confidence: number;
  observedAt: Date | string;
  state: string;
};

export type ActiveContextRecentEventInput = {
  eventType: string;
  occurredAt: Date | string;
  sessionId?: string | null | undefined;
  sourceType: string;
};

export type ActiveContextIndexEntryInput = {
  connector: string;
  description?: string | null | undefined;
  externalId: string;
  importance: number;
  includePolicy: string;
  key: string;
  sagaLink: string;
  title: string;
};

export type ActiveContextWorkspaceInput = {
  handle: string;
  id: string;
  profile?: {
    summary?: string | null | undefined;
  };
};

export type ActiveContextInput = {
  claims: readonly ActiveContextClaimInput[];
  contextIndex?: readonly ActiveContextIndexEntryInput[] | undefined;
  generatedAt?: Date | string | undefined;
  recentEvents: readonly ActiveContextRecentEventInput[];
  workspace: ActiveContextWorkspaceInput;
};

export type ActiveContextSection = {
  lines: string[];
  provenance: string[];
  title: string;
};

export type ActiveContextDocument = {
  generatedAt: string;
  sections: ActiveContextSection[];
  summary: string;
  workspace: {
    handle: string;
    id: string;
  };
};

export function compileActiveContext(input: ActiveContextInput): ActiveContextDocument {
  const generatedAt = toIso(input.generatedAt ?? new Date());
  const claims = [
    ...input.claims.filter((claim) => claim.state !== 'rejected' && claim.state !== 'superseded'),
  ]
    .toSorted(
      (left, right) =>
        right.confidence - left.confidence || left.claimText.localeCompare(right.claimText),
    )
    .slice(0, 8);
  const recentEvents = input.recentEvents.slice(0, 5);
  const contextIndex = [
    ...(input.contextIndex ?? []).filter((entry) => entry.includePolicy === 'always'),
  ]
    .toSorted(
      (left, right) => right.importance - left.importance || left.title.localeCompare(right.title),
    )
    .slice(0, 6);

  return {
    generatedAt,
    sections: [
      {
        lines: [
          input.workspace.profile?.summary?.trim() === ''
            ? 'No workspace profile summary yet.'
            : (input.workspace.profile?.summary ?? 'No workspace profile summary yet.'),
        ],
        provenance: ['workspace_profile'],
        title: 'Workspace Profile',
      },
      {
        lines:
          claims.length === 0
            ? ['No current claims projected yet.']
            : claims.map(
                (claim) =>
                  `${claimLabel(claim)} ${claim.claimText} (${Math.round(claim.confidence * 100).toString()}%)`,
              ),
        provenance: claims.map((claim) => `claim:${claim.claimKey}`),
        title: 'Current Claims',
      },
      {
        lines:
          contextIndex.length === 0
            ? ['No Context Index entries pinned yet.']
            : contextIndex.map((entry) => {
                const description =
                  entry.description === undefined || entry.description === null
                    ? ''
                    : ` — ${entry.description}`;
                return `${entry.title}: ${entry.sagaLink} (${entry.connector}:${entry.externalId})${description}`;
              }),
        provenance: contextIndex.map((entry) => `context_index:${entry.key}`),
        title: 'Context Index',
      },
      {
        lines:
          recentEvents.length === 0
            ? ['No recent raw events captured yet.']
            : recentEvents.map(
                (event) =>
                  `${toIso(event.occurredAt)} ${event.sourceType}.${event.eventType.replace(/^[^.]+[.]/, '')}${
                    event.sessionId === undefined || event.sessionId === null
                      ? ''
                      : ` session=${event.sessionId}`
                  }`,
              ),
        provenance: recentEvents.map(
          (event) => `raw_event:${event.eventType}:${toIso(event.occurredAt)}`,
        ),
        title: 'Recent Activity',
      },
    ],
    summary: `Active Context for ${input.workspace.handle}`,
    workspace: {
      handle: input.workspace.handle,
      id: input.workspace.id,
    },
  };
}

export function renderActiveContextMarkdown(document: ActiveContextDocument): string {
  return [
    `# ${document.summary}`,
    '',
    `Generated: ${document.generatedAt}`,
    '',
    ...document.sections.flatMap((section) => [
      `## ${section.title}`,
      '',
      ...section.lines.map((line) => `- ${line}`),
      '',
    ]),
  ]
    .join('\n')
    .trimEnd();
}

function claimLabel(claim: ActiveContextClaimInput): string {
  if (claim.state === 'supported') {
    return '[supported]';
  }
  if (claim.state === 'contradicted') {
    return '[contradicted]';
  }
  if (claim.state === 'decayed') {
    return '[decayed]';
  }
  return `[${claim.claimKind}]`;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
