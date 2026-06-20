# Harness Targets

Saga harness targets connect agent runtimes to the same local memory loop:

1. Install local, project-scoped hooks.
2. Capture hook JSON as raw events through `saga ingest <target>-hook`.
3. Register a target-specific source binding.
4. Project prompt-derived claims through the shared extraction path.

## Shared Hook Events

Codex and Claude Code both support the same first-loop events Saga needs:

- `SessionStart`
- `UserPromptSubmit`
- `Stop`

Saga installs the same command hook for each event. `SessionStart` is scoped to startup, resume, clear, and compact events where the host supports that matcher. `UserPromptSubmit` and `Stop` are unfiltered because they fire once per turn.

## Target Differences

| Target      | Settings file                 | Local source     | Ingest command            | Notes                                                                                                                 |
| ----------- | ----------------------------- | ---------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Codex       | `.codex/hooks.json`           | `codex://local`  | `saga ingest codex-hook`  | Existing project-local hook file. The shim lives in `.codex/saga-codex-hook.sh`.                                      |
| Claude Code | `.claude/settings.local.json` | `claude://local` | `saga ingest claude-hook` | Uses Claude's local project settings file so hooks stay uncommitted. The shim lives in `.claude/saga-claude-hook.sh`. |

## Shared Adapter Primitives

- `HarnessTarget`: install/status/uninstall target.
- `HarnessSource`: raw-event source namespace.
- `HarnessHookInput`: common hook JSON envelope.
- Source-specific raw events: `<source>.<hook_event_name>`.
- Source-specific ids: `<source>:local`.
- Source-specific source bindings, with common workspace scoping.
- Shared prompt extraction for any `*.UserPromptSubmit` event with a string `payload.prompt`.

## Edge Cases

- Settings JSON may already contain user hooks. Saga removes only its own shim commands and preserves unrelated hooks.
- Hook setup records the local binding only after source registration succeeds; failed registration must not leave active hooks.
- Claude local settings should be gitignored explicitly because Saga creates the file directly.
- Hook ingestion remains non-blocking. Capture failures return host-compatible JSON that lets the agent continue and reports a system message.
- Claude and Codex do not guarantee identical optional fields. The collector treats `turn_id`, `model`, `permission_mode`, and `transcript_path` as optional provenance.
