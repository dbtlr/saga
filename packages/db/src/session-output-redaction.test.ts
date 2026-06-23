import { describe, expect, test } from "vitest";
import { redactAgentFacingSessionText } from "./session-output-redaction.js";

describe("session output redaction", () => {
  test("redacts local transcript paths with spaces and UNC paths", () => {
    const redacted = redactAgentFacingSessionText(
      [
        "posix=/Users/Drew Smith/.codex/transcripts/session.jsonl",
        "windows=C:\\Users\\Drew Smith\\.codex\\transcripts\\session.jsonl",
        "unc=\\\\server\\share\\Users\\drew\\.codex\\transcripts\\session.jsonl",
      ].join("\n"),
    );

    expect(redacted).toContain("posix=[local-path-redacted]");
    expect(redacted).toContain("windows=[local-path-redacted]");
    expect(redacted).toContain("unc=[local-path-redacted]");
    expect(redacted).not.toContain("/Users/Drew Smith");
    expect(redacted).not.toContain("C:\\Users\\Drew Smith");
    expect(redacted).not.toContain("\\\\server\\share");
  });

  test("preserves safe agent-facing URI schemes", () => {
    const redacted = redactAgentFacingSessionText(
      [
        "https://example.test/Users/Drew%20Smith/session.jsonl",
        "codex://session/abc123",
        "github://repo/owner/name/pull/1",
        "norn://workspace/note",
        "mimir://task/SGA-141",
        "saga:context/session-provenance",
      ].join(" "),
    );

    expect(redacted).toContain("https://example.test/Users/Drew%20Smith/session.jsonl");
    expect(redacted).toContain("codex://session/abc123");
    expect(redacted).toContain("github://repo/owner/name/pull/1");
    expect(redacted).toContain("norn://workspace/note");
    expect(redacted).toContain("mimir://task/SGA-141");
    expect(redacted).toContain("saga:context/session-provenance");
    expect(redacted).not.toContain("[local-path-redacted]");
  });
});
