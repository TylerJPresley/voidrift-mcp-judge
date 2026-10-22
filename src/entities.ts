/**
 * Judge entities (judge-blueprint.md §2, §3).
 *
 * The typed-verdict discriminated union, the tool input shapes, and the
 * `JudgeBackend` port. Every schema is defined once in Zod and is the single
 * source for both MCP exposure and runtime validation (core §8.1). Nothing here
 * depends on a backend, a transport, or the MCP SDK — these are the innermost
 * types the use-cases and adapters build on.
 */
import { z } from "zod";

/** `local-only` forbids resolving to any hosted backend (§5). */
export const SensitivitySchema = z.enum(["normal", "local-only"]);
export type Sensitivity = z.infer<typeof SensitivitySchema>;

/** The artifact under review: text, a JSON object, or an array (§2). */
export const ArtifactSchema = z.union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())]);
export type Artifact = z.infer<typeof ArtifactSchema>;

/** The standard an artifact is judged against (§2). */
export const CriterionSchema = z.object({
  id: z.string().min(1),
  instructions: z.string().min(1),
  standardVersion: z.string().optional(),
});
export type Criterion = z.infer<typeof CriterionSchema>;

/** Shared tool input: what is judged and the standard it is judged against (§2). */
export const JudgeInputSchema = z.object({
  artifact: ArtifactSchema,
  criterion: CriterionSchema,
  sensitivity: SensitivitySchema.optional(),
});
export type JudgeInput = z.infer<typeof JudgeInputSchema>;

export const JudgeCheckInputSchema = JudgeInputSchema;
export type JudgeCheckInput = z.infer<typeof JudgeCheckInputSchema>;

/** `judge_choose` adds an option set — order-independent, >= 2 (§4). */
export const JudgeChooseInputSchema = JudgeInputSchema.extend({
  options: z.array(z.string().min(1)).min(2),
});
export type JudgeChooseInput = z.infer<typeof JudgeChooseInputSchema>;

/** `judge_score` adds an ordered rubric of 2..10 levels (§2). */
export const JudgeScoreInputSchema = JudgeInputSchema.extend({
  levels: z.number().int().min(2).max(10),
});
export type JudgeScoreInput = z.infer<typeof JudgeScoreInputSchema>;

/** Common fields every verdict carries so a decision is traceable (§2, §9.1). */
export interface VerdictBase {
  criterionId: string;
  standardVersion?: string;
  backend: string;
  model?: string;
  calibrated: boolean;
}

export interface CheckVerdict extends VerdictBase {
  type: "check";
  pass: boolean;
  probability: number;
}
export interface ChooseVerdict extends VerdictBase {
  type: "choose";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}
export interface ScoreVerdict extends VerdictBase {
  type: "score";
  score: number;
  levelProbabilities: number[];
  confidence: number;
}

/** One typed verdict shape, discriminated by `type` (§2). */
export type JudgeVerdict = CheckVerdict | ChooseVerdict | ScoreVerdict;

/** The verdict schema — used to validate a backend's output and to drive the
 * LLM adapter's `withStructuredOutput` (§4). */
const VerdictBaseShape = {
  criterionId: z.string(),
  standardVersion: z.string().optional(),
  backend: z.string(),
  model: z.string().optional(),
  calibrated: z.boolean(),
};
export const CheckVerdictSchema = z.object({
  ...VerdictBaseShape,
  type: z.literal("check"),
  pass: z.boolean(),
  probability: z.number().min(0).max(1),
});
export const ChooseVerdictSchema = z.object({
  ...VerdictBaseShape,
  type: z.literal("choose"),
  choice: z.string(),
  probabilities: z.record(z.string(), z.number()),
  confidence: z.number().min(0).max(1),
});
export const ScoreVerdictSchema = z.object({
  ...VerdictBaseShape,
  type: z.literal("score"),
  score: z.number(),
  levelProbabilities: z.array(z.number()),
  confidence: z.number().min(0).max(1),
});

/** Decision-only schemas: the fields a backend must produce, WITHOUT the
 * server-owned traceability markers (criterionId/backend/calibrated). The LLM
 * adapter asks the model for these and the server stamps the markers (§9.1
 * rule 1) so a model cannot forge the backend identity. */
export const CheckDecisionSchema = z.object({
  type: z.literal("check"),
  pass: z.boolean(),
  probability: z.number().min(0).max(1),
});
export const ChooseDecisionSchema = z.object({
  type: z.literal("choose"),
  choice: z.string(),
  probabilities: z.record(z.string(), z.number()),
  confidence: z.number().min(0).max(1),
});
export const ScoreDecisionSchema = z.object({
  type: z.literal("score"),
  score: z.number(),
  levelProbabilities: z.array(z.number()),
  confidence: z.number().min(0).max(1),
});

/** A request the server hands the port once the sensitivity rule and
 * weak-spot mitigation have cleared (§3). */
export interface JudgeRequest {
  kind: "check" | "choose" | "score";
  artifact: Artifact;
  criterion: Criterion;
  options?: string[];
  levels?: number;
}

/**
 * The one port behind which Jev, an LLM, and a deterministic checker are
 * interchangeable (§3, §9.1 rule 6). `decide` throws `JudgeUnavailableError` on
 * an unreachable or unsure backend — the server maps a throw to a structured
 * MCP tool error, which the caller treats as a failed/unsure Judge (§6).
 */
export interface JudgeBackend {
  readonly name: string; // "jev" | "llm" | "deterministic:<name>"
  readonly hosted: boolean; // true if the artifact leaves the environment
  readonly reportsCalibration: boolean;
  decide(req: JudgeRequest): Promise<JudgeVerdict>;
}

/** An unreachable or unsure backend — the conservative, fail-closed signal
 * (§2, §6, §9.1 rule 3). */
export class JudgeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JudgeUnavailableError";
  }
}

/** A sensitivity/mitigation refusal enforced before any backend call (§4, §5). */
export class JudgePolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JudgePolicyError";
  }
}
