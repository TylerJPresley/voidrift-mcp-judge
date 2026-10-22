import { describe, it, expect } from "vitest";
import { DeterministicBackend, artifactText } from "./deterministic-backend.js";
import { JudgeUnavailableError, type JudgeRequest } from "../entities.js";

const criterion = { id: "no-secrets", instructions: "The artifact contains no API key." };

describe("DeterministicBackend", () => {
  it("is local, calibrated, and names itself", () => {
    const b = new DeterministicBackend({ name: "pii", rules: [] });
    expect(b.hosted).toBe(false);
    expect(b.reportsCalibration).toBe(true);
    expect(b.name).toBe("deterministic:pii");
  });

  it("returns a check verdict: pass when every rule matches (probability 1.0)", async () => {
    // Given a rule that passes when no 'sk-' token appears
    const b = new DeterministicBackend({
      rules: [{ id: "no-sk", criterionId: "no-secrets", test: (t) => !/sk-[a-z0-9]+/i.test(t) }],
    });
    // When judging a clean artifact
    const req: JudgeRequest = { kind: "check", artifact: "all clear", criterion };
    const v = await b.decide(req);
    // Then it passes, calibrated, traceable
    expect(v).toMatchObject({ type: "check", pass: true, probability: 1, calibrated: true, criterionId: "no-secrets", backend: "deterministic:rules" });
  });

  it("returns a check verdict: fail when a rule fails", async () => {
    const b = new DeterministicBackend({ rules: [{ id: "no-sk", test: (t) => !/sk-[a-z0-9]+/i.test(t) }] });
    const v = await b.decide({ kind: "check", artifact: "token sk-abc123", criterion });
    expect(v).toMatchObject({ type: "check", pass: false, probability: 1 });
  });

  it("returns a choose verdict picking the option whose rule fires in canonical order", async () => {
    const b = new DeterministicBackend({
      rules: [
        { id: "high", test: (t) => /critical/i.test(t) },
        { id: "low", test: (t) => /info/i.test(t) },
      ],
    });
    const v = await b.decide({ kind: "choose", artifact: "a critical finding", criterion, options: ["high", "low"] });
    expect(v).toMatchObject({ type: "choose", choice: "high", confidence: 1 });
    expect((v as { probabilities: Record<string, number> }).probabilities).toEqual({ high: 1, low: 0 });
  });

  it("returns a score verdict counting matching rules clamped into the rubric", async () => {
    const b = new DeterministicBackend({
      rules: [
        { id: "r1", test: (t) => t.includes("a") },
        { id: "r2", test: (t) => t.includes("b") },
        { id: "r3", test: (t) => t.includes("z") },
      ],
    });
    const v = await b.decide({ kind: "score", artifact: "ab", criterion, levels: 4 });
    expect(v).toMatchObject({ type: "score", score: 2, confidence: 1 });
    expect((v as { levelProbabilities: number[] }).levelProbabilities).toEqual([0, 0, 1, 0]);
  });

  it("throws JudgeUnavailableError (unsure) when no rule matches the criterion", async () => {
    const b = new DeterministicBackend({ rules: [{ id: "r", criterionId: "other", test: () => true }] });
    await expect(b.decide({ kind: "check", artifact: "x", criterion })).rejects.toBeInstanceOf(JudgeUnavailableError);
  });

  it("serializes a non-string artifact for scanning", () => {
    expect(artifactText({ a: 1 })).toBe('{"a":1}');
    expect(artifactText("x")).toBe("x");
  });
});
