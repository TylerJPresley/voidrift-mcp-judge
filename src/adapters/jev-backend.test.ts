import { describe, it, expect, vi } from "vitest";
import { JevBackend } from "./jev-backend.js";
import { JudgeUnavailableError } from "../entities.js";

const criterion = { id: "refund-ok", instructions: "The request complies with the refund policy.", standardVersion: "pol-7" };

/** A fake `fetch` that captures the request and returns a canned Jev response —
 * NO real network. Mirrors external research maintained outside this repository. */
function fakeFetch(answer: unknown, capture: { url?: string; body?: unknown; auth?: string | null }) {
  return vi.fn(async (input: unknown, init?: { headers?: Record<string, string>; body?: string }) => {
    capture.url = typeof input === "string" ? input : (input as { url: string }).url;
    capture.body = init?.body ? JSON.parse(init.body) : undefined;
    capture.auth = init?.headers?.["Authorization"] ?? init?.headers?.["authorization"] ?? null;
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers: { verdict: answer }, usage: { input_tokens: 10, output_tokens: 2 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("JevBackend (request shaping only, offline)", () => {
  it("is hosted and reports calibration", () => {
    const b = new JevBackend({ apiKey: "dummy", fetch: fakeFetch({ type: "noul", noul: 0.9 }, {}) });
    expect(b.hosted).toBe(true);
    expect(b.reportsCalibration).toBe(true);
  });

  it("shapes a correct POST to /v1/systemone with the dummy bearer key and a noul question", async () => {
    // Given an injected fetch capturing the request
    const cap: { url?: string; body?: Record<string, unknown>; auth?: string | null } = {};
    const b = new JevBackend({ apiKey: "dummy-key", baseURL: "https://api.typesafe.ai", fetch: fakeFetch({ type: "noul", noul: 0.91 }, cap) });
    // When deciding a check
    const v = await b.decide({ kind: "check", artifact: "please refund", criterion });
    // Then the request is shaped to /v1/systemone with the dummy key and no network
    expect(cap.url).toContain("/v1/systemone");
    expect(cap.auth).toBe("Bearer dummy-key");
    expect(cap.body).toMatchObject({ state: "please refund", model: "jev-latest" });
    expect((cap.body as { questions: { verdict: { type: string } } }).questions.verdict.type).toBe("noul");
    // And the verdict maps noul→check with group calibration and the resolved model id
    expect(v).toMatchObject({ type: "check", pass: true, probability: 0.91, backend: "jev", model: "jev-1.13.0", calibrated: true, criterionId: "refund-ok", standardVersion: "pol-7" });
  });

  it("shapes a choice question and maps choice→choose", async () => {
    const cap: { body?: Record<string, unknown> } = {};
    const b = new JevBackend({ apiKey: "d", fetch: fakeFetch({ type: "choice", choice: "high", confidence: 0.8, probabilities: { high: 0.8, low: 0.2 } }, cap) });
    const v = await b.decide({ kind: "choose", artifact: "x", criterion, options: ["high", "low"] });
    const q = (cap.body as { questions: { verdict: { type: string; criteria: Record<string, unknown> } } }).questions.verdict;
    expect(q.type).toBe("choice");
    expect(Object.keys(q.criteria)).toEqual(["high", "low"]);
    expect(v).toMatchObject({ type: "choose", choice: "high", confidence: 0.8 });
  });

  it("shapes a score question and maps score→score with per-level probabilities", async () => {
    const cap: { body?: Record<string, unknown> } = {};
    const b = new JevBackend({ apiKey: "d", fetch: fakeFetch({ type: "score", score: 1.4, confidence: 0.6, legend: {}, probabilities: { 0: 0.1, 1: 0.5, 2: 0.4 } }, cap) });
    const v = await b.decide({ kind: "score", artifact: "x", criterion, levels: 3 });
    const q = (cap.body as { questions: { verdict: { type: string; criteria: unknown[] } } }).questions.verdict;
    expect(q.type).toBe("score");
    expect(q.criteria).toHaveLength(3);
    expect(v).toMatchObject({ type: "score", score: 1.4, confidence: 0.6 });
    expect((v as { levelProbabilities: number[] }).levelProbabilities).toEqual([0.1, 0.5, 0.4]);
  });

  it("fails closed (JudgeUnavailableError) when the API errors — no fabricated verdict", async () => {
    const errFetch = vi.fn(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const b = new JevBackend({ apiKey: "d", fetch: errFetch });
    await expect(b.decide({ kind: "check", artifact: "x", criterion })).rejects.toBeInstanceOf(JudgeUnavailableError);
  });
});
