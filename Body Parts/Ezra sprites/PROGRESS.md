# Ezra Desktop Cat — Progress Notes (as of 2026-07-11)

## Where this is going
This is being built as a **desktop pet app** — not just a sprite animation demo. The current `ezra_walk.html` is a browser test harness only, used to sanity-check poses, transitions, and timing before writing real app code. Once all pose sets are generated and approved, we move from "testing in a browser" to actually building the app (native/desktop shell, not a webpage). **No app build has started yet.**

## Source of truth for assets
Google Drive folder "Cat Sq" (owner brpdesigndna@gmail.com, shared with theardentguy@gmail.com):
`https://drive.google.com/drive/folders/1ZZXubRwAVCQev4JWl8bWJOJMYf5caM8a`

New poses get added there as subfolders; pull them locally, make transparent, review, wire into the test HTML.

## Local folder layout
`D:\Ezra Making\Body Parts\Ezra sprites\`
- `ezra_walk.html` — browser test harness (walk → stretch → sleep → wake → stretch → idle → pounce → idle → loops). Has a speed slider (0.1x–3x) at the bottom.
- `Final walk\New sq\` — 12 raw walk-cycle frames (black bg) + `transparent\` (alpha-keyed versions actually used by the HTML). This walk cycle was previously broken (frame 3 duplicated frame 1, no opposite-leg contact pose); this 12-frame set fixed it — confirmed as a real alternating stride.
- `Poses\Cat idle\` — 2 frames, standing, near-identical (breathing-loop pair)
- `Poses\Cat sit\` — 2 frames, sitting upright, tail curled (breathing-loop pair)
- `Poses\Cat look\` — 2 frames. **Not a separate pose** — these are substitute frames for **walk positions #4 and #7**, swapped in when she needs to glance at the viewer/cursor mid-stride. Same baseline/scale as the walk set.
- `Poses\Sleep\` — 2 frames: 1 = curled resting, eyes open; 2 = fully curled, eyes closed (deep sleep)
- `Poses\Stretch\` — 3 frames: standing → arched back/mouth open (yawn) → full downward stretch. Reused twice in the loop: once before sleep, once after waking (see below).
- `Poses\Pounce\` — 3 frames: crouch (coiled) → airborne leap (extended) → landed crouch. Starts from Idle.
- `Poses\Reference\` — 6 loose frames ("Sq 1–6"), essentially another walk-pose reference sheet, redundant with `Final walk`. Kept for style reference only, not a distinct pose.
- Every pose folder has a `transparent\` subfolder — black background flood-filled to alpha, edges un-premultiplied (no dark halo), interior black outlines untouched. Conversion script logic lives in this conversation's history (Pillow + numpy, flood-fill from border pixels, not a blanket black threshold, so internal linework survives).

## Pose transition decisions made so far
- **Sleep entry**: Stretch's last frame (body already lowered) is the bridge into Sleep frame 1 — better than cutting from standing Idle, since the silhouette height is already close.
- **Wake-up**: Sleep frame 2 (asleep) → hold Sleep frame 1 briefly (stirring, eyes open, still curled) → **Stretch** (reused, full 3 frames) → Idle. The stretch-after-waking was added because Sleep→Idle directly was too abrupt.
- **Pounce**: starts from Idle (crouch → leap → land), returns to Idle after.
- **Eating (not yet built)**: bridge frame should be **Idle**, not a mid-walk frame — match body posture (legs planted, weight centered), only the head/neck angle changes going into the eating pose. Walk → arrives → Idle → Eating.
- **Known gap**: there's still no dedicated "lying down" transition frame (Stretch-end → Sleep-start is a clean cut, not a true smooth motion) and no "standing up from lying" frame. Backlog item if we want fully smooth motion later, not blocking.

## Pose backlog (from original plan, not all started)
Done: walk (fixed), sleep, stretch, sit, idle, look (walk substitutes), pounce.
Still pending: eating (in progress now), front-facing, moody, zoomies, knock/paw-swipe, stare.

## The eventual app — requirements discussed (not built)
Feature goal: user drops/creates a folder named "cat food" somewhere, and Ezra runs to it; presumably reacts similarly to other future triggers.

This cannot be a browser page — needs a real desktop shell. Requirements identified:
1. **Native/desktop shell** (Electron, Tauri, or Python+PyQt/Tkinter) with a transparent, click-through, always-on-top window so she can walk over the whole desktop, not inside a browser tab.
2. **Filesystem watcher** (`chokidar`/Node `fs.watch`, or Python `watchdog`) monitoring a target directory for a folder/file matching "cat food" (create AND delete events).
3. **Target position logic** — the hard part: if "cat food" is meant to be an icon on the visible Desktop, getting its on-screen (x, y) requires querying the Windows desktop icon list (`SysListView32` control via Win32 API) — OS-specific and fiddly. Simplest first version: skip real icon coordinates, just run to a fixed screen position whenever the watched folder exists/doesn't exist.
4. **New animation needs**: a run cycle (faster than walk), maybe a brief "notice/alert" pose before taking off, plus the eating loop.
5. Removal handling: watcher must fire on delete too, so she can stop eating / wander off when the folder disappears.

## Decision: app shell = Electron
Chosen 2026-07-11. Reasoning: reuses ~90% of the existing `ezra_walk.html` prototype (state machine, transparent PNG handling, speed logic) almost directly, has well-documented support for transparent/click-through/always-on-top windows, and filesystem watching (chokidar) is easy. Tradeoff accepted: larger install size / higher idle RAM than Tauri or a native app — not a concern for this project.

## Full behaviour spec (given 2026-07-11) — reviewed, feasibility confirmed
User provided a complete behaviour spec for the live app: window setup (frameless/transparent/always-on-top/click-through-except-sprite/tray icon), 11 states (idle, walking, sitting, sleeping, stretching, pouncing, eating, catnip, zoomies, staring, looking-at-user), movement rules (80–120px/s randomized walk, edge pause+flip, distraction slowdown, rare 5% sprint burst), cursor tracking (200px notice / 80px follow / velocity-triggered pounce / 10s disinterest timeout), a weighted behaviour-timer dice (sums to 100%: sleep 30, sit-stare 20, walk 15, stretch 10, corner-sit 8, look-at-user 7, zoomies 5, loo 3, rare-event 2), full animation timing per state, a food/bowl system, and a catnip sequence.

Reviewed against current assets/engineering constraints. Resolved decisions from that review:
- **No generic front-facing pose** — there is one specific front-facing image, named **"catnip stare"**, used for the stare beat right after the catnip-eating step in the catnip sequence. (Only front-on asset that exists; the earlier "looking-at-user" state will need to reuse this or wait for a dedicated frame — not yet resolved which.)
- **Zoomies**: no zoomies frames exist yet — **ignore/skip the zoomies state entirely for now** (both the standalone zoomies behaviour and the "sprint erratically" descriptions) until frames are made.
- **Catnip sequence frames + bowl props (`bowl_empty.png`/`bowl_full.png`)**: user will share these separately (not yet on Drive as of this note).
- **No dedicated "staring" pose** — dropped. "Sit and stare," "corner sit," etc. just hold the existing Sit pose; staring is not a distinct visual state.
- **Sleep animation timing**: use what we already decided/built in the test harness (hold curled-resting, then settle into deep-sleep and hold) — **not** the "alternate every 3 seconds for the whole duration" line that was in the written spec. That line was a mismatch with the earlier decision; disregard it.
- **zoom01/zoom02** (directional fast-run frames mentioned in the catnip sequence): ignore for now, same reason as zoomies — no frames exist.

Still-open questions (not yet answered by user, don't assume):
- Whether "catnip stare" doubles as the "looking-at-user" behaviour's front pose, or that behaviour waits for separate art.
- "Corner sit facing the wall" orientation — only left-facing art + horizontal flip exists, no true corner-angle art.
- State priority/arbitration when multiple systems want control at once (e.g. behaviour-timer sleep vs. active cursor-follow).

User said they'll separately provide **frame-sequencing direction** (what frame precedes what action, so transitions are specified up front rather than guessed) — wait for that before finalizing the animation/transition code.

## Next steps
1. **App build can start now, in parallel with remaining pose work** — decided not to block on finishing every pose first. The animation engine should load poses from folders/config rather than hardcoding them, so new pose sets (eating, catnip, bowl props, look-at-user, zoomies later) can be dropped in without restructuring the engine.
2. Waiting on: eating frames (in progress), catnip sequence frames, bowl prop images, and the user's frame-sequencing direction notes.
3. Electron scaffolding not started yet — next actual build step, still pending explicit go-ahead.
