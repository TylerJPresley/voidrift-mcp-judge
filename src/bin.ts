#!/usr/bin/env node
/**
 * The runnable Judge MCP server over stdio (judge-blueprint.md §1, §2).
 *
 * A local process that speaks the MCP protocol on stdio — VoidRift's MCP client
 * spawns it and reaches each tool as `mcp_judge_<tool>` (core §8.4). The entry:
 *
 *  - ships a DETERMINISTIC backend as the DEFAULT so the server runs with no
 *    model and no network (§4, the offline/reproducible first choice);
 *  - selects a backend by `--backend <name>` or the `JUDGE_BACKEND` env var, and
 *    reads only env var NAMES for any credential — never a key value (§5, core
 *    §8.4 CredentialStore);
 *  - prints `--help`/`--version` and exits 0 without starting the server;
 *  - shuts the transport down cleanly when stdin closes (the parent went away).
 *
 * A model-backed (`llm`) or hosted (`jev`) backend is selectable but needs the
 * embedding host to bind the model/endpoint (the Judge is VoidRift-on-the-core,
 * §3); a standalone `--backend llm|jev` with no bound model exits with a clear
 * message rather than a half-wired server. The deterministic default always runs.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createJudgeServer } from "./use-cases/server.js";
import { buildDefaultConfig, type JudgeBinOptions } from "./use-cases/bin-config.js";

/** The server version marker, surfaced by `--version`. */
const VERSION = "0.0.0";

const HELP = `voidrift-mcp-judge — the VoidRift Judge MCP server (stdio)

Usage:
  voidrift-mcp-judge [--backend <name>]

Options:
  --backend <name>   Backend to select (default: deterministic). Also JUDGE_BACKEND.
                     'deterministic' runs offline with no model. 'llm'/'jev' need
                     the embedding host to bind a model/endpoint (judge-blueprint §3).
  -h, --help         Print this help and exit.
  -v, --version      Print the version and exit.

Credentials are referenced by ENV VAR NAME only (JUDGE_LLM_API_KEY_ENV,
JUDGE_JEV_API_KEY_ENV); the Judge never reads or prints a key value.`;

/** Parse argv into the bin options (pure; exported for the test). */
export function parseArgs(argv: readonly string[]): { help?: boolean; version?: boolean; options: JudgeBinOptions } {
  let backend = process.env["JUDGE_BACKEND"];
  let help = false;
  let versionFlag = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") help = true;
    else if (a === "-v" || a === "--version") versionFlag = true;
    else if (a === "--backend") backend = argv[++i];
  }
  return {
    ...(help ? { help } : {}),
    ...(versionFlag ? { version: versionFlag } : {}),
    options: backend !== undefined ? { backend } : {},
  };
}

/** Wire the server to stdio and shut down cleanly when stdin closes (§1). */
export async function run(argv: readonly string[], streams: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream }): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    streams.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (parsed.version) {
    streams.stdout.write(`${VERSION}\n`);
    return 0;
  }
  let config;
  try {
    config = buildDefaultConfig(parsed.options);
  } catch (e) {
    streams.stderr.write(`voidrift-mcp-judge: ${(e as Error).message}\n`);
    return 2;
  }
  const server = createJudgeServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Clean shutdown when the parent closes stdin (MCP stdio contract).
  await new Promise<void>((resolve) => {
    process.stdin.once("close", resolve);
    transport.onclose = (): void => resolve();
  });
  await server.close();
  return 0;
}

// Only run when invoked directly (not when imported by a test).
const invokedDirectly = process.argv[1] !== undefined && /voidrift-mcp-judge|bin\.(js|ts)$/.test(process.argv[1]);
if (invokedDirectly) {
  run(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr })
    .then((code) => process.exit(code))
    .catch((e) => {
      process.stderr.write(`voidrift-mcp-judge: fatal: ${(e as Error).message}\n`);
      process.exit(1);
    });
}
