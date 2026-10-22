import { describe, it, expect, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createJudgeServer } from "./server.js";
import { DeterministicBackend } from "../adapters/deterministic-backend.js";
import { JudgeUnavailableError, type JudgeBackend, type JudgeVerdict } from "../entities.js";
import type { JudgeConfig } from "./selection.js";

/** A hosted backend standing in for Jev — asserts it is never reached on
 * local-only, and can be made unreachable. */
function hosted(opts: { unreachable?: boolean } = {}): JudgeBackend {
  return {
    name: "jev",
    hosted: true,
    reportsCalibration: true,
    decide: async (): Promise<JudgeVerdict> => {
      if (opts.unreachable) throw new JudgeUnavailableError("jev: network unreachable");
      return { type: "check", pass: true, probability: 0.95, criterionId: "x", backend: "jev", model: "jev-1.13.0", calibrated: true };
    },
  };
}

const det = () =>
  new DeterministicBackend({
    name: "rules",
    rules: [
      { id: "no-sk", criterionId: "no-secrets", test: (t) => !/sk-[a-z0-9]+/i.test(t) },
      { id: "high", criterionId: "severity", test: (t) => /critical/i.test(t) },
      { id: "low", criterionId: "severity", test: (t) => /info/i.test(t) },
      { id: "q1", criterionId: "quality", test: (t) => t.includes("a") },
      { id: "q2", criterionId: "quality", test: (t) => t.includes("b") },
    ],
  });

/** Wire a client to a judge server over a linked in-memory transport pair. */
async function connect(config: JudgeConfig): Promise<Client> {
  const server = createJudgeServer(config);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return client;
}

function parse(res: unknown): JudgeVerdict {
  const content = (res as { content: { type: string; text: string }[] }).content;
  const text = content[0]?.text ?? "{}";
  return JSON.parse(text) as JudgeVerdict;
}

describe("Judge MCP server over InMemoryTransport", () => {
  let defaultCfg: JudgeConfig;
  beforeEach(() => {
    defaultCfg = { backend: "deterministic:rules", backends: { "deterministic:rules": det() } };
  });

  it("lists all three tools, each readOnlyHint:true, reachable as judge_*", async () => {
    const client = await connect(defaultCfg);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["judge_check", "judge_choose", "judge_score"]);
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true);
  });

  it("judge_check returns a traceable typed check verdict", async () => {
    const client = await connect(defaultCfg);
    const res = await client.callTool({
      name: "judge_check",
      arguments: { artifact: "all clear", criterion: { id: "no-secrets", instructions: "no api key", standardVersion: "v1" } },
    });
    const v = parse(res);
    expect(v).toMatchObject({ type: "check", pass: true, probability: 1, backend: "deterministic:rules", criterionId: "no-secrets", standardVersion: "v1", calibrated: true });
  });

  it("judge_choose returns a choice verdict", async () => {
    const client = await connect(defaultCfg);
    const res = await client.callTool({
      name: "judge_choose",
      arguments: { artifact: "a critical bug", criterion: { id: "severity", instructions: "severity class" }, options: ["high", "low"] },
    });
    expect(parse(res)).toMatchObject({ type: "choose", choice: "high" });
  });

  it("judge_score returns a score verdict", async () => {
    const client = await connect(defaultCfg);
    const res = await client.callTool({
      name: "judge_score",
      arguments: { artifact: "ab", criterion: { id: "quality", instructions: "quality level" }, levels: 3 },
    });
    expect(parse(res)).toMatchObject({ type: "score", score: 2 });
  });

  it("rejects a malformed input pre-backend (missing criterion.id)", async () => {
    const client = await connect(defaultCfg);
    const res = await client.callTool({ name: "judge_check", arguments: { artifact: "x", criterion: { instructions: "no id" } } });
    expect(res.isError).toBe(true);
  });

  it("returns a structured error (unsure) when the deterministic backend has no matching rule", async () => {
    const client = await connect(defaultCfg);
    const res = await client.callTool({ name: "judge_check", arguments: { artifact: "x", criterion: { id: "unknown", instructions: "no rule" } } });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0]?.text).toContain("no rule for criterion");
  });

  it("PRIVACY: a local-only request routes to deterministic and NEVER to the hosted backend", async () => {
    const client = await connect({ backend: "jev", backends: { jev: hosted(), "deterministic:rules": det() } });
    const res = await client.callTool({
      name: "judge_check",
      arguments: { artifact: "all clear", criterion: { id: "no-secrets", instructions: "no api key" }, sensitivity: "local-only" },
    });
    const v = parse(res);
    expect(res.isError).toBeFalsy();
    expect(v.backend).toBe("deterministic:rules");
    expect(v.backend).not.toBe("jev");
  });

  it("UNREACHABLE: an unreachable backend yields a structured error (fail-closed)", async () => {
    const client = await connect({ backend: "jev", backends: { jev: hosted({ unreachable: true }) } });
    const res = await client.callTool({
      name: "judge_check",
      arguments: { artifact: "x", criterion: { id: "c", instructions: "is this ok" } },
    });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0]?.text).toContain("unreachable");
  });

  it("serves list_backends as a resource reporting backend identity and calibration", async () => {
    const client = await connect({ backend: "jev", backends: { jev: hosted(), "deterministic:rules": det() } });
    const res = await client.readResource({ uri: "judge://backends" });
    const body = JSON.parse((res.contents[0] as { text: string }).text);
    expect(body.selected).toBe("jev");
    expect(body.backends).toEqual(
      expect.arrayContaining([
        { name: "jev", hosted: true, reportsCalibration: true },
        { name: "deterministic:rules", hosted: false, reportsCalibration: true },
      ]),
    );
  });

  it("rejects an invalid default backend selection at construction", () => {
    expect(() => createJudgeServer({ backend: "ghost", backends: { "deterministic:rules": det() } })).toThrow();
  });
});
