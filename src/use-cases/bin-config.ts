/**
 * Default backend wiring for the standalone Judge bin (judge-blueprint.md §4).
 *
 * The standalone server ships a DETERMINISTIC backend as the default so it runs
 * offline, with no model and no network — the blueprint's first choice when a
 * standard is a rule and the only backend a `local-only` request can always
 * reach (§4, §5). The default rule set is intentionally minimal and operators
 * replace it when embedding a real standard; it proves the transport, the tool
 * surface, and the typed-verdict contract end to end.
 *
 * `llm` and `jev` are selectable by name but require the embedding host to bind
 * the model/endpoint (the Judge is VoidRift-on-the-core, §3); selecting one in
 * the standalone bin with nothing bound is a clear configuration error, never a
 * half-wired server or a fabricated verdict.
 */
import { DeterministicBackend, type DeterministicRule } from "../adapters/deterministic-backend.js";
import type { JudgeConfig } from "./selection.js";

/** The options the bin resolves from argv/env (credentials by NAME only). */
export interface JudgeBinOptions {
  /** The selected backend name (`--backend` / JUDGE_BACKEND); default deterministic. */
  backend?: string;
}

/** The minimal default rule set: a catch-all `check` that passes when the
 * artifact is non-empty. It is a placeholder an operator replaces with the real
 * standard — it keeps the offline default runnable and reproducible (§4). */
export const DEFAULT_RULES: DeterministicRule[] = [
  { id: "non-empty", test: (text) => text.trim().length > 0 },
];

/**
 * Build a validated `JudgeConfig` for the standalone bin. The deterministic
 * backend is always present and is the default; a request for `llm`/`jev`
 * without a bound model throws a clear error (the bin maps it to exit 2).
 */
export function buildDefaultConfig(opts: JudgeBinOptions = {}): JudgeConfig {
  const deterministic = new DeterministicBackend({ name: "rules", rules: DEFAULT_RULES });
  const backends: JudgeConfig["backends"] = { [deterministic.name]: deterministic };

  const selected = opts.backend ?? deterministic.name;
  // Accept the short name `deterministic` as an alias for the registered
  // `deterministic:rules` so `--backend deterministic` is intuitive.
  if (selected === "deterministic" || selected === deterministic.name) {
    return { backend: deterministic.name, backends };
  }
  if (selected === "llm" || selected === "jev") {
    throw new Error(
      `backend '${selected}' needs the embedding host to bind a model/endpoint (judge-blueprint §3); the standalone server supports 'deterministic' only — run VoidRift's MCP client to use '${selected}'`,
    );
  }
  throw new Error(`unknown --backend '${selected}' (have: deterministic)`);
}
