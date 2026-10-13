# Incanto vs R3F eval harness (one-off, not merged to main)

Measures what verse8-mcp users get from three 3D stacks given byte-identical
prompts. Design: `incanto-vs-r3f-eval-design.html` (master artifact
c_mv60yee0_mpfd). Nothing here ships: `eval/` is outside the npm `files` list.

## Arms and seeds

| arm | seed | template @ commit | prompt |
|---|---|---|---|
| incanto | `seeds/incanto-freeview` | `basic-3d-freeview` @ agent8-templates `6f0fff50d` (main), patched | P1 |
| incanto | `seeds/incanto-quarterview` | `basic-3d-quarterview` @ `6f0fff50d`, patched | P2 |
| incanto (diagnostic) | `seeds/incanto-freeview-shipped` | `basic-3d-freeview` @ `6f0fff50d` as shipped | P1, one run |
| vibe | `seeds/vibe-freeview` | `basic-3d-freeview` @ `56b2e9e9f` (parent of the Incanto switch `78f2ba5df`) | P1 |
| vibe | `seeds/vibe-quarterview` | `basic-3d-quarterview` @ `56b2e9e9f` | P2 |
| r3f | `seeds/r3f-basic` | `basic-3d` @ `56b2e9e9f` (R3F deps, React counter app) | P1, P2 |

`node eval/seeds/build-seeds.mjs` rebuilds them: template copy → shared asset
set → `bun install` (lockfile kept, force-added where the template ignores it)
→ git with a `gitlab.verse8.io` origin whose push URL is local → `runAttach`
from `dist/` with `overwriteAgentsDoc` → plugin check → commit, tag `seed`.
Result and versions: `seeds/seeds.json`. Build `dist/` first (`npm run build`).

"Patched" is one line: the Sun's `"shadowMapSize": 4096` is removed so the
engine default (2048) applies — without it every Incanto run starts from a
white screen (Known issue below). The shipped template gets one diagnostic run
(`incanto-P1-shipped`, last in the schedule) to see whether an agent finds the
white screen itself; it is reported apart from the arm tables.

Shared assets (`assets/shared-assets.mjs`): knight GLB and seven mixamorig
animations from the CDN, six generated SFX and a sky panorama under
`public/eval-assets/`, same keys in every arm. Templates keep their own entries.

## Running (costs Claude usage)

```bash
node eval/runner/run.mjs schedule          # pilot: 3 arms × 2 prompts × 2, seeded shuffle
node eval/runner/run.mjs run <id> --dry-run  # prepare + print commands, no session
node eval/runner/selftest.mjs eval/runs/<id> # offline MCP + checkpoint + preview guard check
node eval/runner/run.mjs run --next | --all   # start several --all workers to run in parallel
node eval/evaluator/evaluate.mjs --run <id>  # build, F1, F2, F3 snapshots
node eval/evaluator/evaluate.mjs --seed <seed> --prompt P1|P2   # starting-point score
node eval/aggregate/aggregate.mjs            # report/runs.csv + report/summary.md
```

Per run: APFS clone of the seed, `claude -p` stream-json with model, effort,
`--max-budget-usd`, wall clock and tool-call caps from `config.mjs`, F1..F3 in
the same session (`--resume`), snapshot commit + tag after each step.
verse8-mcp runs offline: dummy token, `.env` account, proxies off, deploy /
upload / new-project / login and web tools disallowed. `runner/preview-guard.mjs`
turns `verse8_preview`'s `bun update` preflight into
`bun install --frozen-lockfile` and skips the game-server build/deploy step.
It also moves the default port 5173 to `5200 + order`, bound to 127.0.0.1, so
parallel runs never see each other's dev server (verse8_preview reports a busy
port as `already_running`, and its readiness probe only dials 127.0.0.1 while
vite here binds `localhost` as `[::1]`). Each run claims `runs/<id>/` with a
non-recursive mkdir; delete a dry-run's directory before the real run.

## Evaluator

Production build (`vite build --base ./`), title and favicon neutralised,
static serve, Playwright Chromium on the Metal GPU. The boot gate looks at the
largest canvas with every DOM element hidden: it passes once the canvas is not
one uniform colour (luma variance > 1). `evaluator/instrument.js`
wraps WebGL draw calls, rAF pacing, audio starts and Pointer Lock (granted
virtually — automation cannot take a real lock). Probes per requirement score
0 / 0.5 / 1 or `null` (needs vision or a human). `evaluator/fixtures/p1|p2`
are engine-free games that implement the hooks; `--dist <fixture> [--query
broken=1]` checks the probes score them 1 and drop on the broken variant.

## Known issue found while building the harness

Both Incanto seeds render only the white scene background: every draw fails
with `GL_INVALID_OPERATION: glDrawElements: Mismatch between texture format and
sampler type`. Seen in Playwright Chromium 141 (SwiftShader and Metal), Chrome
145 headed, Firefox and WebKit with incanto 0.78.2, and in Chromium with
0.78.1 (pristine template) and 0.79.3 too. `game.frame()` itself reports a
uniform frame (meanLuma 1).

Cause (reproduce with `bash eval/lab/setup.sh [three-version]`, then
`eval/lab/probe.mjs` per scene and `eval/lab/hook.mjs` for the writers):
engine defect exposed by three >= 0.182. The default quality tier
patches `environment.shadows: true` (mapSize 2048), and every frame
`Environment3D.applySunLight` forces the main sun's `shadow.mapSize` back to
that value and disposes `shadow.map`, while `DirectionalLight3D._syncObject3D`
sets it to the node's `shadowMapSize`. Any `shadowMapSize` other than 2048
(the six `basic-3d-*` view templates ship 4096) means a new shadow map every
frame. three <= 0.181 survives that (colour shadow map); from 0.182 shadow
maps are `DepthTexture`s and every lit draw fails. Receive/cast flags and the
HDR preset are irrelevant. Workaround: drop `shadowMapSize` from the Sun (or
set 2048), or pin three to 0.181.x. `incanto-verify` reports `✗ draws` only
with a dev server and an open page, and its advice blames the camera;
`incanto-logs` sees no errors. The pilot seeds take the first workaround
(see Arms and seeds); `incanto-freeview-shipped` keeps the template as shipped.
