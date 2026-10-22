/**
 * Backend selection, the structural privacy rule, and weak-spot gating
 * (judge-blueprint.md §4, §5).
 *
 * The server holds a set of configured backends and a default selection. The
 * resolver picks the backend for a request and, crucially, enforces two rules
 * BEFORE any backend is handed the artifact:
 *
 *  - PRIVACY (§5): a `local-only` request can never resolve to a backend whose
 *    `hosted` flag is true. It resolves to a non-hosted backend (the local LLM
 *    endpoint or the deterministic adapter) or returns a structured error. The
 *    refusal is structural — enforced here, before any `decide()` call — so a
 *    misconfiguration cannot leak a trade-secret artifact to a hosted API.
 *  - WEAK SPOTS (§4): a counting / math / date-time criterion must not ride a
 *    probabilistic backend; it routes to the deterministic adapter, and the
 *    server rejects it on a probabilistic backend with guidance.
 */
import {
  JudgePolicyError,
  type JudgeBackend,
  type JudgeRequest,
  type Sensitivity,
} from "../entities.js";

export interface JudgeConfig {
  /** The default backend name (`judge.backend`), cascaded global→project→session. */
  backend: string;
  /** All configured backends by name. The default must be one of these. */
  backends: Record<string, JudgeBackend>;
}

/** Phrases that mark a criterion as numeric/temporal — a rule, not a judgment (§4). */
const NUMERIC_TEMPORAL = /\b(count|counts|counting|how many|number of|sum|total|math|calculat|\+|-|\*|\/|=|<|>|date|time|before|after|earlier|later|older|newer|day|month|year|hour|minute)\b/i;

export function isNumericOrTemporal(instructions: string): boolean {
  return NUMERIC_TEMPORAL.test(instructions);
}

/** Reject an invalid default selection with clear feedback; the caller keeps
 * the known-good selection (§4, core §13). */
export function validateConfig(config: JudgeConfig): void {
  if (!config.backends[config.backend]) {
    throw new JudgePolicyError(
      `judge.backend '${config.backend}' is not a configured backend (have: ${Object.keys(config.backends).join(", ") || "none"})`,
    );
  }
}

/**
 * Resolve the backend for a request, enforcing privacy and weak-spot rules
 * structurally. Throws `JudgePolicyError` on a refusal — the server maps that to
 * a structured MCP tool error, treated as an unsure Judge (§6).
 */
export function resolveBackend(config: JudgeConfig, req: JudgeRequest, sensitivity: Sensitivity): JudgeBackend {
  const selected = config.backends[config.backend];
  if (!selected) {
    throw new JudgePolicyError(`judge.backend '${config.backend}' is not configured`);
  }

  // Weak-spot: a numeric/temporal criterion routes to the deterministic adapter.
  const numericTemporal = isNumericOrTemporal(req.criterion.instructions);

  // Privacy: local-only forbids any hosted backend.
  const needsLocal = sensitivity === "local-only";

  let backend = selected;

  if (numericTemporal && selected.reportsCalibration && selected.name !== "deterministic" && !selected.name.startsWith("deterministic:")) {
    const det = Object.values(config.backends).find((b) => b.name.startsWith("deterministic:"));
    if (!det) {
      throw new JudgePolicyError(
        "a counting/math/date-time criterion must route to a deterministic backend; none is configured (§4)",
      );
    }
    backend = det;
  }

  if (needsLocal && backend.hosted) {
    const local = Object.values(config.backends).find((b) => !b.hosted);
    if (!local) {
      throw new JudgePolicyError(
        "a local-only request cannot resolve to a hosted backend and no non-hosted backend is configured (§5)",
      );
    }
    backend = local;
  }

  // Defence in depth: never return a hosted backend for a local-only request.
  if (needsLocal && backend.hosted) {
    throw new JudgePolicyError("local-only request refused: resolved backend is hosted (§5)");
  }

  return backend;
}
