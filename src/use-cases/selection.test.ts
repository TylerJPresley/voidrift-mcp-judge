import { describe, it, expect } from "vitest";
import { resolveBackend, validateConfig, isNumericOrTemporal, type JudgeConfig } from "./selection.js";
import { DeterministicBackend } from "../adapters/deterministic-backend.js";
import { JudgePolicyError, type JudgeBackend, type JudgeRequest, type JudgeVerdict } from "../entities.js";

/** A fake hosted backend standing in for Jev — never actually called here. */
function hosted(name: string): JudgeBackend {
  return {
    name,
    hosted: true,
    reportsCalibration: true,
    decide: async (): Promise<JudgeVerdict> => ({ type: "check", pass: true, probability: 1, criterionId: "x", backend: name, calibrated: true }),
  };
}

const det = new DeterministicBackend({ name: "rules", rules: [{ id: "r", test: () => true }] });
const req = (instructions: string): JudgeRequest => ({ kind: "check", artifact: "x", criterion: { id: "c", instructions } });

describe("selection", () => {
  it("rejects an invalid default backend selection, keeping config known-good", () => {
    const cfg: JudgeConfig = { backend: "ghost", backends: { "deterministic:rules": det } };
    expect(() => validateConfig(cfg)).toThrow(JudgePolicyError);
  });

  it("resolves the selected backend for a normal request", () => {
    const cfg: JudgeConfig = { backend: "jev", backends: { jev: hosted("jev"), "deterministic:rules": det } };
    const b = resolveBackend(cfg, req("is this good?"), "normal");
    expect(b.name).toBe("jev");
  });

  it("PRIVACY: a local-only request never resolves to a hosted backend", () => {
    const cfg: JudgeConfig = { backend: "jev", backends: { jev: hosted("jev"), "deterministic:rules": det } };
    const b = resolveBackend(cfg, req("is this good?"), "local-only");
    expect(b.hosted).toBe(false);
    expect(b.name).toBe("deterministic:rules");
  });

  it("PRIVACY: a local-only request with no non-hosted backend is refused before any call", () => {
    const cfg: JudgeConfig = { backend: "jev", backends: { jev: hosted("jev") } };
    expect(() => resolveBackend(cfg, req("ok?"), "local-only")).toThrow(JudgePolicyError);
  });

  it("WEAK-SPOT: a counting criterion on a probabilistic backend routes to deterministic", () => {
    const cfg: JudgeConfig = { backend: "jev", backends: { jev: hosted("jev"), "deterministic:rules": det } };
    const b = resolveBackend(cfg, req("count the number of errors"), "normal");
    expect(b.name).toBe("deterministic:rules");
  });

  it("WEAK-SPOT: a date criterion on a probabilistic backend with no deterministic backend is rejected", () => {
    const cfg: JudgeConfig = { backend: "jev", backends: { jev: hosted("jev") } };
    expect(() => resolveBackend(cfg, req("is the date before 2020?"), "normal")).toThrow(JudgePolicyError);
  });

  it("detects numeric/temporal instructions", () => {
    expect(isNumericOrTemporal("how many items")).toBe(true);
    expect(isNumericOrTemporal("compare the date")).toBe(true);
    expect(isNumericOrTemporal("is the prose clear")).toBe(false);
  });
});
