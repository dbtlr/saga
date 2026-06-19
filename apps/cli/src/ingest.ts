import { formatCommandOutput } from "./output.js";
import { recordBlock, type RenderOptions } from "./render.js";

export interface CodexHookIngestResult {
  accepted: boolean;
  mode: "noop";
  source: "codex";
}

export async function runIngestCommand(
  args: readonly string[],
  options: RenderOptions,
): Promise<string> {
  const subcommand = args[0];
  if (subcommand === "codex-hook") {
    return ingestCodexHook(options);
  }

  throw new Error(`ingest ${subcommand ?? ""} is not implemented yet`.trim());
}

export async function ingestCodexHook(options: RenderOptions): Promise<string> {
  if (options.format === "records") {
    return JSON.stringify({ continue: true });
  }

  const result: CodexHookIngestResult = {
    accepted: true,
    mode: "noop",
    source: "codex",
  };

  return formatCommandOutput(
    {
      id: "codex",
      records: recordBlock(
        "Codex hook ingest",
        [
          { label: "source", value: result.source },
          { label: "mode", value: result.mode },
          { label: "accepted", value: String(result.accepted) },
        ],
        options,
      ),
      value: result,
    },
    options.format,
  );
}
