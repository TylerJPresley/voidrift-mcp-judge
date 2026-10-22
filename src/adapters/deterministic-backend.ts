/**
 * The deterministic backend (judge-blueprint.md §4).
 *
 * A declarative rule engine over the artifact — regex/predicate rules mapped to
 * a verdict. Fully local (`hosted: false`), fully reproducible, and
 * `calibrated: true` by construction (a pass/fail rule's probability is 1.0).
 * The first choice when a standard is a rule rather than a judgment, the offline
 * default, and the only backend a `local-only` request can always reach (§5).
 *
 * A rule shells to no network and holds no model. A `check` rule returns pass
 * when the artifact matches; `choose` picks the first rule whose pattern matches
 * (canonical option order); `score` counts matching rules across the rubric. A
 * criterion with no matching rule is an unsure result → `JudgeUnavailableError`.
 */
import {
  JudgeUnavailableError,
  type Artifact,
  type Criterion,
  type JudgeBackend,
  type JudgeRequest,
  type JudgeVerdict,
} from "../entities.js";

/** One deterministic rule: a stable id and a predicate over the artifact text. */
export interface DeterministicRule {
  id: string;
  /** Matches by criterion id (exact) or applies to any criterion when omitted. */
  criterionId?: string;
  test: (artifactText: string, req: JudgeRequest) => boolean;
}

/** Render any artifact shape to the text a rule scans. */
export function artifactText(artifact: Artifact): string {
  return typeof artifact === "string" ? artifact : JSON.stringify(artifact);
}

export interface DeterministicConfig {
  /** A readable sub-name, e.g. "deterministic:pii-scan". */
  name?: string;
  rules: DeterministicRule[];
}

export class DeterministicBackend implements JudgeBackend {
  readonly name: string;
  readonly hosted = false as const;
  readonly reportsCalibration = true as const;
  private readonly rules: DeterministicRule[];

  constructor(config: DeterministicConfig) {
    this.name = `deterministic:${config.name ?? "rules"}`;
    this.rules = config.rules;
  }

  private rulesFor(criterion: Criterion): DeterministicRule[] {
    return this.rules.filter((r) => r.criterionId === undefined || r.criterionId === criterion.id);
  }

  async decide(req: JudgeRequest): Promise<JudgeVerdict> {
    const text = artifactText(req.artifact);
    const rules = this.rulesFor(req.criterion);
    if (rules.length === 0) {
      throw new JudgeUnavailableError(`deterministic: no rule for criterion '${req.criterion.id}'`);
    }
    const base = {
      criterionId: req.criterion.id,
      ...(req.criterion.standardVersion !== undefined ? { standardVersion: req.criterion.standardVersion } : {}),
      backend: this.name,
      model: this.name,
      calibrated: true as const,
    };

    if (req.kind === "check") {
      const pass = rules.every((r) => r.test(text, req));
      return { ...base, type: "check", pass, probability: 1 };
    }

    if (req.kind === "choose") {
      const options = req.options ?? [];
      // Canonical order: the options as given; first option whose matching rule
      // fires wins. A rule's id names the option it votes for.
      const hit = options.find((opt) => rules.some((r) => r.id === opt && r.test(text, req)));
      const choice = hit ?? options[0];
      if (choice === undefined) throw new JudgeUnavailableError("deterministic: choose with no options");
      const probabilities: Record<string, number> = {};
      for (const opt of options) probabilities[opt] = opt === choice ? 1 : 0;
      return { ...base, type: "choose", choice, probabilities, confidence: 1 };
    }

    // score: count matching rules, clamp into the rubric, one-hot level probs.
    const levels = req.levels ?? 2;
    const matched = rules.filter((r) => r.test(text, req)).length;
    const score = Math.max(0, Math.min(levels - 1, matched));
    const levelProbabilities = Array.from({ length: levels }, (_, i) => (i === score ? 1 : 0));
    return { ...base, type: "score", score, levelProbabilities, confidence: 1 };
  }
}
