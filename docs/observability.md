# 관측성 (Observability)

모든 툴 dispatch (`verse8_attach`, `verse8_checkpoint`, `verse8_preview`, 이미지 프록시, …)는 정확히 하나의 JSONL 라인을 `${VERSE8_AUDIT_LOG_PATH:-$XDG_STATE_HOME/verse8/mcp.log}`에 씁니다:

```json
{"ts":"2026-04-21T06:18:55.778Z","tool":"verse8_attach","outcome":"ok","durationMs":72,"correlationId":"2d10ee15-…","projectDirDigest":"7fa322a86f4d"}
```

`projectDirDigest`는 `sha256(projectDir).slice(0,12)` — 원본 경로는 절대 기록하지 않습니다. 스키마-파스 실패와 unknown-tool dispatch는 감사 라인을 남기지 **않습니다**. `hint` 필드의 secret-shape 문자열은 dispatch envelope과 동일한 redact 레지스트리로 마스킹됩니다.

## 회전

- 1 MB 임계값에서 회전. `mcp.log` → `mcp.log.1` rename, 기존 `.1` drop.
- 한 개의 회전 파일만 유지 (총 디스크 예산 ≤ 2 MB).
- 회전 실패는 비차단 — 툴 호출은 절대 audit IO 때문에 멈추지 않습니다.

## 위치 오버라이드

`VERSE8_AUDIT_LOG_PATH` env로 단일 파일 경로 지정 가능. 기본값은 XDG 표준 경로 (`$XDG_STATE_HOME/verse8/mcp.log`).
