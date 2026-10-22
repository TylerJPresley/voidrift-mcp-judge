/**
 * @voidrift/mcp-judge — an MCP server returning typed verdicts over a pluggable
 * `JudgeBackend` (judge-blueprint.md).
 *
 * The Judge is reached by the main VoidRift through its MCP client as
 * `mcp_judge_<tool>` (core §8.4) — it is an MCP server built on the core SDK, not
 * a `register(core)` plugin. Construct it with a config selecting one backend
 * (deterministic default / LLM / Jev) and connect it to a transport.
 */
export * from "./entities.js";
export { createJudgeServer } from "./use-cases/server.js";
export {
  resolveBackend,
  validateConfig,
  isNumericOrTemporal,
  type JudgeConfig,
} from "./use-cases/selection.js";
export {
  DeterministicBackend,
  artifactText,
  type DeterministicRule,
  type DeterministicConfig,
} from "./adapters/deterministic-backend.js";
export { LlmBackend, buildPrompt, type LlmConfig, type StructuredModel } from "./adapters/llm-backend.js";
export { JevBackend, type JevConfig, type Fetch } from "./adapters/jev-backend.js";
