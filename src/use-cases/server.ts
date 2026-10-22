/**
 * The Judge MCP server (judge-blueprint.md §2, §3).
 *
 * A thin MCP server over the `JudgeBackend` port. It owns the three tool schemas
 * (Zod — single source for MCP exposure and validation, core §8.1), input
 * validation, the sensitivity rule and weak-spot gating (`resolveBackend`), and
 * the error contract. The backend owns the decision; the server knows nothing
 * about which backend it holds (§3).
 *
 * Each tool is `readOnlyHint: true` — a judge call reads and returns a decision,
 * writes nothing — so VoidRift's gate treats `mcp_judge_*` as free (core §8.1,
 * §8.4). A call that cannot produce a verdict (unreachable/unsure backend,
 * over-limit input, a refused sensitivity/weak-spot rule) returns a structured
 * MCP tool error (`isError: true`), never a fabricated verdict; the caller
 * treats that error as an unsure Judge (§6, §9.1 rule 3).
 *
 * The server is transport-agnostic: `connect(transport)` takes stdio in a local
 * process, Streamable HTTP when hosted, and `InMemoryTransport` in tests (§1).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  CriterionSchema,
  JudgePolicyError,
  JudgeUnavailableError,
  type Artifact,
  type Criterion,
  type JudgeRequest,
  type JudgeVerdict,
  type Sensitivity,
} from "../entities.js";
import { resolveBackend, validateConfig, type JudgeConfig } from "./selection.js";

/** The shared input shape as an MCP raw Zod shape (§2). */
const sharedInput = {
  artifact: z.union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())]),
  criterion: CriterionSchema,
  sensitivity: z.enum(["normal", "local-only"]).optional(),
};

type SharedArgs = {
  artifact: Artifact;
  criterion: Criterion;
  sensitivity?: Sensitivity;
};

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> };

function ok(verdict: JudgeVerdict): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(verdict) }], structuredContent: verdict as unknown as Record<string, unknown> };
}

function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: `judge error: ${message}` }], isError: true };
}

/** Run a request through selection + the resolved backend, mapping every
 * refusal and unreachable/unsure result to a structured error (§6). */
async function decide(config: JudgeConfig, req: JudgeRequest, sensitivity: Sensitivity): Promise<ToolResult> {
  let verdict: JudgeVerdict;
  try {
    const backend = resolveBackend(config, req, sensitivity);
    verdict = await backend.decide(req);
  } catch (e) {
    if (e instanceof JudgePolicyError || e instanceof JudgeUnavailableError) return fail(e.message);
    return fail(`unexpected: ${(e as Error).message}`);
  }
  return ok(verdict);
}

/**
 * Build the Judge MCP server over a validated config. Throws `JudgePolicyError`
 * if the default backend selection is invalid (core §13: rejected, not applied).
 */
export function createJudgeServer(config: JudgeConfig): McpServer {
  validateConfig(config);

  const server = new McpServer(
    { name: "judge", version: "0.0.0" },
    { capabilities: { tools: {}, resources: {} } },
  );

  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;

  server.registerTool(
    "judge_check",
    {
      description: "Pass/fail verdict with a calibrated probability over one artifact and one criterion.",
      inputSchema: sharedInput,
      annotations: { title: "Judge: check", ...readOnly },
    },
    async (args) => {
      const a = args as SharedArgs;
      return decide(config, { kind: "check", artifact: a.artifact, criterion: a.criterion }, a.sensitivity ?? "normal");
    },
  );

  server.registerTool(
    "judge_choose",
    {
      description: "Choice among a defined option set, with per-option probabilities.",
      inputSchema: { ...sharedInput, options: z.array(z.string().min(1)).min(2) },
      annotations: { title: "Judge: choose", ...readOnly },
    },
    async (args) => {
      const a = args as SharedArgs & { options: string[] };
      return decide(
        config,
        { kind: "choose", artifact: a.artifact, criterion: a.criterion, options: a.options },
        a.sensitivity ?? "normal",
      );
    },
  );

  server.registerTool(
    "judge_score",
    {
      description: "Score on an ordered rubric of 2..10 levels, with per-level probabilities.",
      inputSchema: { ...sharedInput, levels: z.number().int().min(2).max(10) },
      annotations: { title: "Judge: score", ...readOnly },
    },
    async (args) => {
      const a = args as SharedArgs & { levels: number };
      return decide(
        config,
        { kind: "score", artifact: a.artifact, criterion: a.criterion, levels: a.levels },
        a.sensitivity ?? "normal",
      );
    },
  );

  // list_backends resource: which judge answered and whether it reports
  // calibration — visible to an operator and an audit without reading a verdict (§2).
  server.registerResource(
    "list_backends",
    "judge://backends",
    { title: "Configured judge backends", mimeType: "application/json" },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify({
            selected: config.backend,
            backends: Object.values(config.backends).map((b) => ({
              name: b.name,
              hosted: b.hosted,
              reportsCalibration: b.reportsCalibration,
            })),
          }),
        },
      ],
    }),
  );

  return server;
}
