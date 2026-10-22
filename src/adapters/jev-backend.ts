/**
 * The Jev backend (judge-blueprint.md §4; see external research maintained outside this repository).
 *
 * Wraps `@typesafe-ai/sdk` `TypeSafeClient.systemOne()` — `POST /v1/systemone` —
 * mapping `check` → a `noul` yes/no probability, `choose` → a `choice` with
 * per-option probabilities, and `score` → a `score` over a rubric. Jev is
 * HOSTED (`hosted: true`) and reports GROUP calibration (`reportsCalibration:
 * true`); the single probability is surfaced as group-calibrated evidence, never
 * a per-answer guarantee — the caller thresholds against the group (§4).
 *
 * The adapter never makes a network call in tests: `TypeSafeClient` takes an
 * injected `fetch`, so a test asserts request shaping to `/v1/systemone` with a
 * dummy key and returns a canned response — no real HTTP. Credentials are held
 * by the core `CredentialStore` and never read from config (§5).
 */
import { TypeSafeClient, type EntryType, type Questions, type SystemOneResult } from "@typesafe-ai/sdk";
import {
  JudgeUnavailableError,
  type JudgeBackend,
  type JudgeRequest,
  type JudgeVerdict,
} from "../entities.js";

/** The `fetch` seam the SDK uses — injected in tests to assert shaping offline. */
export type Fetch = typeof fetch;

export interface JevConfig {
  apiKey: string;
  /** Override base URL (default https://api.typesafe.ai). */
  baseURL?: string;
  /** Model id, default "jev-latest"; the verdict carries the resolved id. */
  model?: string;
  /** Injected fetch for tests; omit in production to use the global fetch. */
  fetch?: Fetch;
  /** Retry attempts after the first. Default 0: a governance/verify-path judge
   * fails closed fast rather than blocking enforcement on a hosted API retry
   * (§6, core §9.6). */
  maxRetries?: number;
}

const QUESTION_KEY = "verdict";

export class JevBackend implements JudgeBackend {
  readonly name = "jev";
  readonly hosted = true as const;
  readonly reportsCalibration = true as const;
  private readonly client: TypeSafeClient;
  private readonly model: string;

  constructor(config: JevConfig) {
    this.model = config.model ?? "jev-latest";
    this.client = new TypeSafeClient({
      apiKey: config.apiKey,
      retry: { maxRetries: config.maxRetries ?? 0 },
      ...(config.baseURL !== undefined ? { baseURL: config.baseURL } : {}),
      ...(config.fetch !== undefined ? { fetch: config.fetch } : {}),
    });
  }

  /** Map a judge request to a Jev `questions` map (one keyed question). */
  private questions(req: JudgeRequest): Questions {
    if (req.kind === "check") {
      return { [QUESTION_KEY]: { type: "noul", instructions: req.criterion.instructions } };
    }
    if (req.kind === "choose") {
      const criteria: Record<string, null> = {};
      for (const opt of req.options ?? []) criteria[opt] = null;
      return { [QUESTION_KEY]: { type: "choice", instructions: req.criterion.instructions, criteria } };
    }
    const levels = req.levels ?? 2;
    const criteria = Array.from({ length: levels }, () => null) as unknown as [null, null, ...null[]];
    return { [QUESTION_KEY]: { type: "score", instructions: req.criterion.instructions, criteria } };
  }

  async decide(req: JudgeRequest): Promise<JudgeVerdict> {
    const state = (typeof req.artifact === "string" ? req.artifact : req.artifact) as EntryType;
    let result: SystemOneResult<Questions>;
    try {
      result = await this.client.systemOne({ state, questions: this.questions(req), model: this.model });
    } catch (e) {
      // Unreachable, over-limit, auth, or any API error → fail closed (§6).
      throw new JudgeUnavailableError(`jev: ${(e as Error).message}`);
    }
    const answer = result.answers[QUESTION_KEY];
    const base = {
      criterionId: req.criterion.id,
      ...(req.criterion.standardVersion !== undefined ? { standardVersion: req.criterion.standardVersion } : {}),
      backend: this.name,
      model: result.model,
      calibrated: true as const,
    };

    if (answer?.type === "noul") {
      const probability = answer.noul;
      return { ...base, type: "check", pass: probability >= 0.5, probability };
    }
    if (answer?.type === "choice") {
      return {
        ...base,
        type: "choose",
        choice: answer.choice,
        probabilities: { ...(answer.probabilities as Record<string, number>) },
        confidence: answer.confidence,
      };
    }
    if (answer?.type === "score") {
      const probs = answer.probabilities as Record<string, number>;
      const levels = req.levels ?? Object.keys(probs).length;
      const levelProbabilities = Array.from({ length: levels }, (_, i) => probs[String(i)] ?? 0);
      return { ...base, type: "score", score: answer.score, levelProbabilities, confidence: answer.confidence };
    }
    throw new JudgeUnavailableError("jev: unrecognized answer shape");
  }
}
