# mcp-orchestrator — Project Conventions

## Architecture (post-refactor)
```
src/
├── types.ts       Shared type definitions
├── transport.ts   MCP protocol layer (connect/listTools/callTool/close)
├── agent.ts       LLM orchestration (callModel/processQuery)
├── server.ts      Express HTTP layer (routes, validation, queue)
├── index.ts       Web server entry point
└── cli.ts         CLI entry point
```

Dependency direction: `index/cli → server → agent → transport` (no cycles)

## Owners
- **小胡**: agent.ts (LLM calls, tool-use loop, prompt handling)
- **老陈**: transport.ts, server.ts, index.ts, cli.ts (MCP connection, HTTP layer, lifecycle)

## Conventions
- TypeScript strict mode
- No circular dependencies between modules
- LLM config read from env vars at startup, not inside agent logic
- Agent depends on transport via interface, not concrete class

## Scripts
- `npm run build` — TypeScript compilation
- `npm run web` — Start web server (`node build/index.js`)
- `npm start` — CLI mode (`node build/cli.js`)

## Workflow (per feat-A001)

### 老陈 — always go first
1. Read `dev-docs/requirements/feat-A001-xxx.md`
2. Read `dev-docs/mcp-orchestrator/api/response-convention.md`
3. Write API doc → `dev-docs/mcp-orchestrator/api/feat-A001-xxx.md`
4. Write half-page tech design → `dev-docs/mcp-orchestrator/design/feat-A001-xxx.md` (if backend changes are non-trivial)
5. Implement server.ts / transport.ts changes
6. Write tests (clear naming, covers acceptance criteria)

### 小胡 — after 老陈's API doc is available
1. Read `dev-docs/requirements/feat-A001-xxx.md`
2. Read 老陈's API doc
3. Write half-page tech design → `dev-docs/mcp-orchestrator/design/feat-A001-xxx.md`
4. Implement agent.ts changes
5. Write tests (clear naming, covers acceptance criteria)

### API response format (mandatory)
ALL endpoints MUST use the unified envelope:
```json
{ "code": 200, "data": { ... }, "message": "" }
```
See `dev-docs/mcp-orchestrator/api/response-convention.md` for full spec.

Failure to follow this format = rejected by Coco.

## Delivery Checklist
- [ ] Code compiles (`npm run build`)
- [ ] 老陈: API doc written before coding starts
- [ ] Design doc written (half-page, design/feat-A001-xxx.md)
- [ ] Test code written (clear naming, covers acceptance criteria)
- [ ] API response uses `{ code, data, message }` envelope
- [ ] Docs in `dev-docs/` are up to date


## Git
- Always work on a branch: ` feat/feat-A001-name ` or ` fix/bug-00042-name ` 
- Never commit directly to main
- Commit format: ` #feat-A001 type: 中文描述 `


