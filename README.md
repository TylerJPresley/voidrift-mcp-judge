# @voidrift/mcp-judge

VoidRift Judge — an MCP server returning typed verdicts (check/choose/score) over a pluggable JudgeBackend (deterministic/LLM/Jev).

Part of VoidRift, a local-first, model-agnostic AI agent harness. Status: work in progress. Not yet usable or released. The VoidRift CLI and core are the current focus.

## Requirements
- Node.js >=22
- `@voidrift/core` `^0.1.0`, which is not published to npm yet. Until it is, link a local checkout of the core repository (`npm link @voidrift/core`).

## Build from source
```bash
git clone https://github.com/TylerJPresley/voidrift-mcp-judge.git
cd voidrift-mcp-judge
npm install
npm run build
npm test
```

## License
Apache-2.0. See [LICENSE](LICENSE).
