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

The production invariants are listed in [security.md › Invariants](./security.md#invariants). Every test or source line that enforces one carries an `INV-n:` / `MCP-UP-n:` tag comment (`//` in TS/JS, `#` in `tests/smoke.sh`); list them with `git grep -nE '(INV|MCP-UP)-[0-9]+:'`. When you change or move a tagged test, move its tag with it.

```bash
bash scripts/check-subtree-sha.sh
```

## Pre-publish guard

```bash
bash scripts/prepublish-guard.sh
```

`npm publish` 시 `prepublishOnly` 스크립트로 자동 실행됩니다. AC-SECURITY-2 강제 — 타볼이 secret-shape 문자열이나 sourcemap을 운반하지 않음.

## 클린

```bash
npm run clean
```

`dist/` 제거.
