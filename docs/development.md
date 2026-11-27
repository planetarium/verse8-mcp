# 개발

## 빌드

```bash
npm run build
```

TypeScript를 `dist/`로 컴파일.

## Dev

```bash
npm run dev
```

`tsx src/index.ts` 실행.

## 테스트

```bash
npm test
```

전체 스위트: `npm run build && bash tests/smoke.sh && npm run test:unit`. 유닛만:

```bash
npm run test:unit
```

`test:unit` preloads `tests/setup/isolateGit.cjs`, which points `GIT_CONFIG_GLOBAL` at an empty file and sets `GIT_CONFIG_NOSYSTEM=1`, so a global `core.hooksPath` on your machine is never touched. To run one file directly, keep the preload: `node --require ./tests/setup/isolateGit.cjs --test tests/unit/<file>.test.mjs`.

분할 smoke 스위트 (M4.1) — 라이브 mock에 대해 단일 서브셋 실행:

```bash
bash tests/smoke/login.sh
bash tests/smoke/attach.sh
bash tests/smoke/new-project.sh
bash tests/smoke/preview.sh
bash tests/smoke/skills.sh
```

## Audit

```bash
npm run audit
```

`npm audit --audit-level=high` — 의존성 트리에 high/critical advisory가 있으면 실패.

## Invariants

The production invariants are listed in [security.md › Invariants](./security.md#invariants). Every test or source line that enforces one carries an `INV-n:` / `MCP-UP-n:` tag comment (`//` in TS/JS, `#` in `tests/smoke.sh`); list them with `git grep -nE '(INV|MCP-UP)-[0-9]+:'`. `bash scripts/verify-invariants.sh` (run in CI) fails when a listed invariant has no tag or a tag names an unlisted ID. When you change or move a tagged test, move its tag with it.

```bash
bash scripts/check-subtree-sha.sh
```

## Pre-publish guard

```bash
bash scripts/prepublish-guard.sh
```

`npm publish` 시 `prepublishOnly` 스크립트로 자동 실행됩니다. AC-SECURITY-2 강제 — 타볼이 secret-shape 문자열이나 sourcemap을 운반하지 않음.

## MCP Registry

The server is listed on the official MCP Registry (registry.modelcontextprotocol.io) as `io.github.planetarium/verse8-mcp`, from `server.json`.

On every release:

1. Move every version number `prepublishOnly` checks to the new version `x.y.z` together — `tests/unit/pluginManifest.test.mjs` and `tests/unit/serverJson.test.mjs` fail otherwise, and `npm publish` stops:
   - `package.json` — `version` (`npm version x.y.z --no-git-tag-version` also updates `package-lock.json`)
   - `plugins/verse8/.claude-plugin/plugin.json` — `version` (what makes installed plugin users pick up the update)
   - `plugins/verse8/.mcp.json` — the pinned `@verse8/mcp@x.y.z` in `mcpServers.verse8.args`
   - `server.json` — `version` and `packages[0].version`

   Not checked, but part of every release: `SERVER_INFO.version` in `src/server.ts` and a `CHANGELOG.md` entry. Confirm with `node --test tests/unit/pluginManifest.test.mjs tests/unit/serverJson.test.mjs` before publishing.
2. `npm publish` — runs `prepublishOnly` (build, `scripts/prepublish-guard.sh`, the two tests above). The registry checks that the published package carries `mcpName`.
3. Once `npm view @verse8/mcp@x.y.z mcpName` prints `io.github.planetarium/verse8-mcp`, run the **MCP Registry** workflow from the Actions tab (workflow_dispatch, on `main`). It runs only on dispatch: pushing a `v*` tag does not publish to the registry. It signs in with GitHub OIDC, which grants the `io.github.planetarium/*` namespace, and publishes `server.json`.

The workflow downloads a pinned `mcp-publisher` and checks its SHA-256 before running it. To upgrade, change `MCP_PUBLISHER_VERSION` and `MCP_PUBLISHER_SHA256` together, taking the hash of `mcp-publisher_linux_amd64.tar.gz` from that release's `registry_<version>_checksums.txt`.

## 클린

```bash
npm run clean
```

`dist/` 제거.
