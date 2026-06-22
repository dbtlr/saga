# Harness Targets

Saga harness targets connect agent runtimes to the same local memory loop:

1. Install local, project-scoped hooks.
2. Capture hook JSON as raw events through `saga ingest <target>-hook`.
3. Register a target-specific source binding.
4. Make captured events available for trailing consolidation.

## Shared Hook Events

Codex and Claude Code both support the same first-loop events Saga needs:

- `SessionStart`
- `UserPromptSubmit`
- `Stop`

Saga installs the same command hook for each event. `SessionStart` is scoped to startup, resume, clear, and compact events where the host supports that matcher. `UserPromptSubmit` and `Stop` are unfiltered because they fire once per turn.

## Target Differences

| Target      | Settings file                 | Local source      | Ingest command            | Notes                                                                                                                                                               |
| ----------- | ----------------------------- | ----------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | `.codex/hooks.json`           | `codex://host/*`  | `saga ingest codex-hook`  | Existing project-local hook file. The shim lives in `.codex/saga-codex-hook.sh`. Codex must explicitly trust project-local hooks before a new session can use them. |
| Claude Code | `.claude/settings.local.json` | `claude://host/*` | `saga ingest claude-hook` | Uses Claude's local project settings file so hooks stay uncommitted. The shim lives in `.claude/saga-claude-hook.sh`.                                               |

## Shared Adapter Primitives

- `HarnessTarget`: install/status/uninstall target.
- `HarnessAdapter`: target definition for hook settings, local shim, source binding, deferred MCP, and deferred skills surfaces.
- `HarnessSource`: raw-event source namespace.
- `HarnessHookInput`: common hook JSON envelope.
- Source-specific raw events: `<source>.<hook_event_name>`.
- Source-specific ids: `<source>:local`.
- Source-specific source bindings, with common workspace scoping.
- Shared raw capture for user prompts, stops, and session starts. Claim extraction happens after a session settles, not inside the hook.

## Status States

`saga harness status` and `saga doctor` use the same state model:

- `configured`: local binding is valid and complete recognized Saga hook configuration is installed for the target.
- `pending-trust`: Codex binding and hooks are installed, but Codex still requires explicit user approval for project-local hooks.
- `missing`: neither local binding nor Saga hooks are installed for the target.
- `stale`: local binding metadata points at an older adapter path, command, target, or source URI.
- `divergent`: local binding and installed hook configuration disagree, such as binding without hooks or hooks without binding.
- `invalid`: the target settings file exists but cannot be parsed as a supported hook settings shape.

Status also reports `hooksCoverage`: `complete`, `partial`, or `none`. Coverage detects current shim commands, legacy direct `saga ingest <target>-hook` commands, and known Saga shim script paths so installed or configured Saga hooks are not mistaken for a missing integration.

For Codex, `saga harness install codex`, `saga harness status codex`, and `saga doctor` distinguish installed hooks from trusted hooks. Saga writes `.codex/hooks.json`, writes `.codex/saga-codex-hook.sh`, and records the local source binding, but it does not silently trust project-local Codex hooks. When status is `pending-trust`, approve the project-local hooks in Codex, then restart Codex or start a new Codex session in the workspace so the host can load the hook configuration.

## Edge Cases

- Settings JSON may already contain user hooks. Saga removes only its own shim commands and preserves unrelated hooks.
- Hook setup records the local binding only after source registration succeeds; failed registration must not leave Saga hooks installed.
- Claude local settings should be gitignored explicitly because Saga creates the file directly.
- Hook ingestion remains non-blocking. Capture failures return host-compatible JSON that lets the agent continue and reports a system message.
- Claude and Codex do not guarantee identical optional fields. The collector treats `turn_id`, `model`, `permission_mode`, and `transcript_path` as optional provenance.
