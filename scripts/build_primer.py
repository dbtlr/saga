#!/usr/bin/env python3
"""Build the Saga Session Primer.

Resolves the Project Binding (`.saga.toml`) through the Vault Registry
(`~/.config/saga/config.toml`) and merges the Active Context — User Profile
(`user.md`), Shared Memory (`memory.md`), and the Workspace Brief — into a
single payload printed to stdout.

Harness-agnostic: invoked by the `session-start` skill in Phase 1, and by a
SessionStart hook later (see decisions/0005, 0011). Phase 1 reads the vault
directly; Mimir folding is a marked seam.

Requires Python 3.11+ (stdlib `tomllib`) or the `tomli` package.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

try:
    import tomllib  # Python 3.11+
except ModuleNotFoundError:  # pragma: no cover - older interpreters
    try:
        import tomli as tomllib  # type: ignore
    except ModuleNotFoundError:
        sys.stderr.write("saga: need Python 3.11+ (tomllib) or the 'tomli' package.\n")
        sys.exit(2)

BINDING_FILENAME = ".saga.toml"


def find_binding(start: Path) -> Path | None:
    """Walk up from `start` looking for the per-project Project Binding."""
    for d in (start, *start.parents):
        candidate = d / BINDING_FILENAME
        if candidate.is_file():
            return candidate
    return None


def global_config_path() -> Path:
    base = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
    return Path(base) / "saga" / "config.toml"


def load_toml(path: Path) -> dict:
    with path.open("rb") as fh:
        return tomllib.load(fh)


def read_optional(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None


def section(title: str, body: str | None, missing_hint: str) -> str:
    if body is None:
        return f"## {title}\n\n_(missing: {missing_hint})_\n"
    return f"## {title}\n\n{body.strip()}\n"


def main(argv: list[str]) -> int:
    cwd = Path(argv[1]).resolve() if len(argv) > 1 else Path.cwd()

    binding_path = find_binding(cwd)
    if binding_path is None:
        # Not initialized — session-start quietly stops.
        print(f"SAGA_UNINITIALIZED: no {BINDING_FILENAME} found from {cwd}")
        return 0

    binding = load_toml(binding_path)
    vault_name = binding.get("vault")
    workspace = binding.get("workspace")
    if not vault_name or not workspace:
        sys.stderr.write(f"saga: {binding_path} must set both `vault` and `workspace`.\n")
        return 2

    gcfg_path = global_config_path()
    if not gcfg_path.is_file():
        sys.stderr.write(
            f"saga: vault registry not found at {gcfg_path}. Run `init` to register a vault.\n"
        )
        return 3

    gcfg = load_toml(gcfg_path)
    vaults = gcfg.get("vaults", {})
    if vault_name not in vaults:
        # Self-heal (prompt to register) is the skill's job; the script just reports.
        known = ", ".join(vaults) or "(none)"
        sys.stderr.write(
            f"saga: vault '{vault_name}' is not registered in {gcfg_path}. Known: {known}.\n"
        )
        return 4

    v = vaults[vault_name]
    root = Path(v["root"]).expanduser()
    workspaces_dir = root / v.get("workspaces_dir", "Workspaces")
    shared_dir = workspaces_dir / v.get("shared_dir", "shared")
    ws_dir = workspaces_dir / workspace

    user_md = read_optional(shared_dir / "user.md")
    memory_md = read_optional(shared_dir / "memory.md")
    brief_md = read_optional(ws_dir / f"{workspace}.md")

    parts = [
        f"# Saga Session Primer — {workspace}",
        "",
        f"_Vault `{vault_name}` ({root}) · workspace `{workspace}`. This is your Active "
        "Context for the session; everything else is reached by progressive disclosure "
        "into the workspace._",
        "",
        section("User Profile (user.md)", user_md, "shared/user.md"),
        section("Shared Memory (memory.md)", memory_md, "shared/memory.md"),
        section(f"Workspace Brief ({workspace}.md)", brief_md, f"{workspace}/{workspace}.md"),
        # [seam] Mimir work/task context folds in here once Mimir exists.
    ]
    print("\n".join(parts))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
