"""Hermetic tests for scripts/build_primer.py.

No external deps (stdlib unittest). Each test builds a throwaway vault +
registry under a temp dir and points the script at it via XDG_CONFIG_HOME and
an explicit start directory, so the real ~/.config/saga and vault are never
touched.

Run: python3 -m unittest discover -s tests
"""
import contextlib
import io
import os
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))
import build_primer  # noqa: E402


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


class BuildPrimerTest(unittest.TestCase):
    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.cfg_home = self.tmp / "cfg"
        self.vault = self.tmp / "vault"
        self.repo = self.tmp / "repo"
        self.repo.mkdir(parents=True)
        self._prev_xdg = os.environ.get("XDG_CONFIG_HOME")
        os.environ["XDG_CONFIG_HOME"] = str(self.cfg_home)

    def tearDown(self):
        if self._prev_xdg is None:
            os.environ.pop("XDG_CONFIG_HOME", None)
        else:
            os.environ["XDG_CONFIG_HOME"] = self._prev_xdg
        self._tmp.cleanup()

    # --- fixtures ---
    def write_registry(self, body=None):
        if body is None:
            body = (
                'default_vault = "testvault"\n\n'
                "[vaults.testvault]\n"
                f'root = "{self.vault}"\n'
                'workspaces_dir = "Workspaces"\n'
                'shared_dir = "shared"\n'
                'artifacts_dir = "artifacts"\n'
            )
        write(self.cfg_home / "saga" / "config.toml", body)

    def write_binding(self, vault="testvault", workspace="demo"):
        lines = []
        if vault is not None:
            lines.append(f'vault = "{vault}"')
        if workspace is not None:
            lines.append(f'workspace = "{workspace}"')
        write(self.repo / ".saga.toml", "\n".join(lines) + "\n")

    def write_active_context(self, workspace="demo"):
        ws = self.vault / "Workspaces"
        write(ws / "shared" / "user.md", "# User\nuser-profile-body")
        write(ws / "shared" / "memory.md", "# Memory\nshared-memory-body")
        write(ws / workspace / f"{workspace}.md", "# Brief\nworkspace-brief-body")

    def run_main(self):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = build_primer.main(["build_primer.py", str(self.repo)])
        return rc, out.getvalue(), err.getvalue()

    # --- tests ---
    def test_happy_path_merges_active_context(self):
        self.write_registry()
        self.write_binding()
        self.write_active_context()
        rc, out, err = self.run_main()
        self.assertEqual(rc, 0, err)
        self.assertIn("Saga Session Primer — demo", out)
        self.assertIn("user-profile-body", out)
        self.assertIn("shared-memory-body", out)
        self.assertIn("workspace-brief-body", out)

    def test_uninitialized_when_no_binding(self):
        self.write_registry()
        rc, out, _ = self.run_main()
        self.assertEqual(rc, 0)
        self.assertIn("SAGA_UNINITIALIZED", out)

    def test_binding_missing_required_field(self):
        self.write_registry()
        self.write_binding(workspace=None)
        rc, _, err = self.run_main()
        self.assertEqual(rc, 2)
        self.assertIn("must set both", err)

    def test_registry_missing(self):
        self.write_binding()
        rc, _, err = self.run_main()
        self.assertEqual(rc, 3)
        self.assertIn("vault registry not found", err)

    def test_unregistered_vault(self):
        self.write_registry()
        self.write_binding(vault="nope")
        rc, _, err = self.run_main()
        self.assertEqual(rc, 4)
        self.assertIn("not registered", err)

    def test_missing_active_context_file_is_flagged(self):
        self.write_registry()
        self.write_binding()
        rc, out, err = self.run_main()
        self.assertEqual(rc, 0, err)
        self.assertIn("(missing: shared/user.md)", out)


if __name__ == "__main__":
    unittest.main()
