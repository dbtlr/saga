import { renderActiveContextMarkdown } from "@saga/active-context";
import { createSagaMcpServer, type JsonRpcRequest, type SearchMemoryInput } from "@saga/mcp";
import { listCurrentClaims, makeDatabase } from "@saga/db";
import { loadRuntimeConfig } from "@saga/runtime";
import { Effect } from "effect";
import { compileProjectActiveContext } from "./context.js";
import { findProjectRoot, readBindingFile } from "./init.js";
import { type RenderOptions } from "./render.js";

export async function runMcpCommand(
  _args: readonly string[],
  _options: RenderOptions,
  write: (text: string) => void,
  stdin: AsyncIterable<Buffer | string> = process.stdin,
): Promise<string | undefined> {
  const server = createProjectMcpServer();
  for await (const line of readJsonLines(stdin)) {
    try {
      const response = await server.handle(parseJsonRpcRequest(line));
      if (response !== undefined) write(JSON.stringify(response));
    } catch (error) {
      write(JSON.stringify(jsonRpcInputError(error)));
    }
  }
  return undefined;
}

export function createProjectMcpServer(input: { cwd?: string } = {}) {
  const cwd = input.cwd;
  return createSagaMcpServer({
    getActiveContext: async () => {
      const document = await compileProjectActiveContext(cwd === undefined ? {} : { cwd });
      return {
        document,
        markdown: renderActiveContextMarkdown(document),
      };
    },
    searchMemory: (search) => searchProjectMemory(search, cwd === undefined ? {} : { cwd }),
  });
}

export async function searchProjectMemory(
  input: SearchMemoryInput,
  options: { cwd?: string } = {},
) {
  const projectRoot = findProjectRoot(options.cwd ?? process.cwd());
  const binding = readBindingFile(projectRoot);
  if (binding === undefined) {
    throw new Error("workspace binding is missing; run saga init");
  }

  const config = await Effect.runPromise(loadRuntimeConfig({ cwd: projectRoot }));
  const service = await Effect.runPromise(makeDatabase(config, { postgres: { max: 1 } }));
  try {
    const query = input.query.toLowerCase();
    const claims = await Effect.runPromise(
      listCurrentClaims(service, {
        limit: 50,
        workspaceId: binding.workspace.id,
      }),
    );
    const matches = claims
      .filter((claim) => claim.claimText.toLowerCase().includes(query))
      .slice(0, input.limit ?? 10)
      .map((claim) => ({
        confidence: claim.confidence,
        key: claim.claimKey,
        kind: claim.claimKind,
        state: claim.state,
        text: claim.claimText,
      }));

    return {
      markdown:
        matches.length === 0
          ? `# Saga Memory Search\n\nNo matches for ${input.query}.`
          : [
              "# Saga Memory Search",
              "",
              ...matches.map(
                (match) =>
                  `- [${match.state}/${match.kind}] ${match.text} (${Math.round(match.confidence * 100).toString()}%)`,
              ),
            ].join("\n"),
      matches,
    };
  } finally {
    await Effect.runPromise(service.close());
  }
}

async function* readJsonLines(stdin: AsyncIterable<Buffer | string>): AsyncGenerator<string> {
  let buffer = "";
  for await (const chunk of stdin) {
    buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed !== "") yield trimmed;
    }
  }
  const trimmed = buffer.trim();
  if (trimmed !== "") yield trimmed;
}

function parseJsonRpcRequest(line: string): JsonRpcRequest {
  const parsed = JSON.parse(line) as unknown;
  if (!isRecord(parsed) || parsed.jsonrpc !== "2.0" || typeof parsed.method !== "string") {
    throw new Error("expected a JSON-RPC 2.0 request object");
  }
  if (
    parsed.id !== undefined &&
    typeof parsed.id !== "string" &&
    typeof parsed.id !== "number" &&
    parsed.id !== null
  ) {
    throw new Error("JSON-RPC request id must be a string, number, or null");
  }
  return {
    id: parsed.id,
    jsonrpc: "2.0",
    method: parsed.method,
    params: parsed.params,
  };
}

function jsonRpcInputError(error: unknown) {
  return {
    error: {
      code: error instanceof SyntaxError ? -32700 : -32600,
      message: error instanceof Error ? error.message : String(error),
    },
    id: null,
    jsonrpc: "2.0",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
