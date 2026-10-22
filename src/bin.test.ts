/**
 * §9 integration test for the runnable Judge bin (judge-blueprint.md §1, §2).
 *
 * Two layers:
 *  - pure unit tests of `parseArgs`, `buildDefaultConfig`, and `--help`/
 *    `--version` (no process spawned);
 *  - a REAL stdio end-to-end: the built `dist/bin.js` is spawned as an MCP
 *    server and reached over `StdioClientTransport` exactly as VoidRift's MCP
 *    client reaches it (connect → list tools → call judge_check → typed
 *    verdict), then shut down by closing stdin.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parseArgs, run } from "./bin.js";
import { buildDefaultConfig, DEFAULT_RULES } from "./use-cases/bin-config.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(here, "..");
const binJs = path.join(pkgDir, "dist", "bin.js");

function captureRun(argv: string[]): Promise<{ out: string; err: string; code: number }> {
  let out = "";
  let err = "";
  return run(argv, {
    stdout: { write: (s: string) => ((out += s), true) } as unknown as NodeJS.WritableStream,
    stderr: { write: (s: string) => ((err += s), true) } as unknown as NodeJS.WritableStream,
  }).then((code) => ({ out, err, code }));
}

describe("parseArgs", () => {
  it("defaults the backend to undefined (deterministic) and parses --backend", () => {
    expect(parseArgs([]).options.backend).toBeUndefined();
    expect(parseArgs(["--backend", "llm"]).options.backend).toBe("llm");
  });
  it("recognizes --help and --version", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
    expect(parseArgs(["--version"]).version).toBe(true);
    expect(parseArgs(["-v"]).version).toBe(true);
  });
});

describe("buildDefaultConfig — deterministic default, runs with no model (§4)", () => {
  it("defaults to the deterministic backend with the catch-all rule", () => {
    const cfg = buildDefaultConfig();
    expect(cfg.backend).toBe("deterministic:rules");
    expect(cfg.backends["deterministic:rules"]).toBeDefined();
    expect(DEFAULT_RULES.length).toBeGreaterThan(0);
  });
  it("accepts 'deterministic' as an alias", () => {
    expect(buildDefaultConfig({ backend: "deterministic" }).backend).toBe("deterministic:rules");
  });
  it("refuses 'llm'/'jev' in the standalone bin with a clear message (§3)", () => {
    expect(() => buildDefaultConfig({ backend: "llm" })).toThrow(/bind a model/);
    expect(() => buildDefaultConfig({ backend: "jev" })).toThrow(/bind a model/);
  });
  it("refuses an unknown backend", () => {
    expect(() => buildDefaultConfig({ backend: "nope" })).toThrow(/unknown/);
  });
});

describe("run — --help / --version print and exit 0 without a server", () => {
  it("--help prints usage and exits 0", async () => {
    const { out, code } = await captureRun(["--help"]);
    expect(code).toBe(0);
    expect(out).toContain("voidrift-mcp-judge");
    expect(out).toContain("--backend");
  });
  it("--version prints the version and exits 0", async () => {
    const { out, code } = await captureRun(["--version"]);
    expect(code).toBe(0);
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
  it("a bad backend exits 2 with a stderr message, no server started", async () => {
    const { err, code } = await captureRun(["--backend", "nope"]);
    expect(code).toBe(2);
    expect(err).toContain("voidrift-mcp-judge:");
  });
});

describe("real stdio MCP server (§1, §2, §9)", () => {
  beforeAll(() => {
    // The full gate builds before test; for an isolated run, build on demand.
    if (!existsSync(binJs)) {
      execFileSync("npm", ["run", "build"], { cwd: pkgDir, stdio: "ignore" });
    }
  }, 120_000);

  it("spawns the built bin, lists tools, calls judge_check, returns a typed verdict, shuts down on close", async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [binJs] });
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(["judge_check", "judge_choose", "judge_score"]);
      for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true);

      const res = await client.callTool({
        name: "judge_check",
        arguments: { artifact: "some real work", criterion: { id: "non-empty", instructions: "artifact is present", standardVersion: "v1" } },
      });
      const content = (res as { content: { text: string }[] }).content;
      const verdict = JSON.parse(content[0]!.text);
      expect(verdict).toMatchObject({
        type: "check",
        pass: true,
        backend: "deterministic:rules",
        criterionId: "non-empty",
        standardVersion: "v1",
        calibrated: true,
      });
    } finally {
      // Closing the transport closes the child's stdin → clean shutdown (§1).
      await client.close();
    }
  }, 60_000);
});
