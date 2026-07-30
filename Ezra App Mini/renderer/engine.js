window.onerror = (msg, url, line, col, error) => {
  console.error("GLOBAL ERROR", msg, "at", line + ":" + col, error && error.stack);
};
console.log("engine.js (V1mini) starting, window.ezra =", typeof window.ezra);

// ============================================================
// V1mini -- revision in progress. She sits on the cushion: blinking
// (sit_01 <-> sit_blink), occasionally looking up (sit_02, sometimes
// at flies), and occasionally getting up entirely -- a stretch, a walk
// out and back, then settling into sit again. Sleep/wander-elsewhere
// are still out; this is only the get-up-and-walk addition on top of
// the sit baseline.
// ============================================================

const SPRITE_WIDTH = 220;
const HOME_MARGIN = 0; // px from the right edge -- flush against it, matches the cushion's anchor
const GROUND_SCALE = SPRITE_WIDTH / 1000;
const DEFAULT_GROUND_OFFSET = 168; // sit_01's measured ground margin
const STATE_GROUND_OFFSET = {
  sit: 168,
  "sit-lookup": 162, // sit_02 -- tilted head shifts the measured offset slightly
  idle: 190,
  walk: 220,
  stretch: 205,
};

const BLINK_HOLD_MS = [90, 160]; // eyes-closed duration range -- quick, not a slow fade
const BLINK_GAP_MS = [2000, 6000]; // natural time between blinks while just sitting
const LOOK_UP_CHANCE = 0.15; // rolled at each gap instead of a blink
const LOOK_UP_HOLD_MS = [4000, 8000]; // how long she holds sit_02 before settling back
const LOOK_UP_FLIES_CHANCE = 0.5; // of a look-up, how often it's because a fly's caught her eye vs. just glancing up
const GET_UP_CHANCE = 0.1; // rolled at the same gap, alongside look-up -- getting up and walking off a while

const GLANCE_PAUSE_MS = 900; // how long she holds the look-at-screen pose before stretching
const STRIDE_LENGTH_PX = 70; // px covered by one full walk cycle -- tunable
const BOB_AMPLITUDE_PX = 2; // vertical bob amplitude while walking
const SAUNTER_FPS = 7; // the only walk pace
const SETTLE_HOLD_MS = 120; // idle cat2 hold before dropping to cat1 when a walk stops
const GLANCE_FRAME_INDEX = 6; // walk_07, 0-indexed -- substituted with look_02 mid-stride

const stageEl = document.getElementById("stage");
const spriteEl = document.getElementById("sprite");
const fliesEl = document.getElementById("flies");
const fly1El = document.getElementById("fly1");
const fly2El = document.getElementById("fly2");

const rand = (min, max) => min + Math.random() * (max - min);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function framePaths(name, count) {
  const pad2 = (n) => String(n).padStart(2, "0");
  return Array.from({ length: count }, (_, i) => `../assets/ezra/${name}_${pad2(i + 1)}.png`);
}

// ---------- manifest loading (asset-driven, never hardcode frame counts) ----------
let manifest = null;
let ASSETS = null;

async function loadManifest() {
  const res = await fetch("../assets/ezra/manifest.json");
  manifest = await res.json();
  ASSETS = {
    sit: framePaths("sit", manifest.states.sit.frames), // 01 = neutral, 02 = looking up
    sitBlink: `../assets/ezra/${manifest.sitVariants.blink.file}`,
    idle: framePaths("idle", manifest.states.idle.frames), // 01 = settled stand, 02 = weight-shift
    walk: framePaths("walk", manifest.states.walk.frames),
    stretch: framePaths("stretch", manifest.states.stretch.frames),
    look: framePaths("look", manifest.states.look.frames), // 02 = standalone "look at camera" cue
  };
  console.log(
    `manifest loaded: sit:${ASSETS.sit.length}, sitBlink:single, idle:${ASSETS.idle.length}, walk:${ASSETS.walk.length}, stretch:${ASSETS.stretch.length}, look:${ASSETS.look.length}`
  );
}

// ---------- fixed-timestep frame clock (independent of render-loop hiccups) ----------
class FrameClock {
  constructor(fps) {
    this.setFps(fps);
    this.acc = 0;
    this.frame = 0;
  }
  setFps(fps) {
    this.fps = fps;
    this.frameMs = 1000 / fps;
  }
  tick(dtMs, frameCount) {
    this.acc += dtMs;
    let steps = 0;
    while (this.acc >= this.frameMs) {
      this.acc -= this.frameMs;
      this.frame = (this.frame + 1) % frameCount;
      steps++;
    }
    return steps;
  }
}

// ---------- global state ----------
const state = {
  x: 0,
  direction: -1, // -1 = facing left (native art direction), 1 = flipped right
  name: "boot",
  bobY: 0,
  groundOffset: DEFAULT_GROUND_OFFSET * GROUND_SCALE,
};

function maxX() {
  return window.innerWidth - SPRITE_WIDTH;
}
function homeX() {
  return maxX() - HOME_MARGIN;
}

function setFacing(direction) {
  state.direction = direction;
  applyTransform();
}

function applyTransform() {
  const flip = state.direction === 1 ? -1 : 1;
  stageEl.style.transform = `translateY(${state.bobY + state.groundOffset}px) scaleX(${flip})`;
}

function setX(x) {
  state.x = Math.max(0, Math.min(maxX(), x));
  stageEl.style.left = `${state.x}px`;
}

function setFrame(src) {
  spriteEl.src = src;
}

function setStateName(name) {
  if (state.name !== name) {
    state.name = name;
    state.groundOffset = (STATE_GROUND_OFFSET[name] ?? DEFAULT_GROUND_OFFSET) * GROUND_SCALE;
    applyTransform();
  }
}

function diag() {
  console.log(`${state.name} | ${Date.now()}`);
}

// ---------- remote/testing: interruptible waits ----------
// Only the "waiting for something to naturally happen" gaps are
// interruptible -- the blink's own eyes-closed hold and the walk's
// per-frame timing stay plain wait()/rAF so a skip can't freeze her
// mid-motion.
let skipResolvers = [];
let manualOverrideName = null;
let previewMode = false;

function requestSkip() {
  const resolvers = skipResolvers;
  skipResolvers = [];
  resolvers.forEach((r) => r());
}

function interruptibleWait(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      skipResolvers = skipResolvers.filter((r) => r !== onSkip);
      resolve(false);
    }, ms);
    const onSkip = () => {
      clearTimeout(timer);
      resolve(true);
    };
    skipResolvers.push(onSkip);
  });
}

// ---------- oneshot playback helper ----------
async function playFrames(frames, holdsMs) {
  for (let i = 0; i < frames.length; i++) {
    setFrame(frames[i]);
    diag();
    await wait(Array.isArray(holdsMs) ? holdsMs[i] : holdsMs);
  }
}

// ---------- fly dots (shown while she looks up) ----------
let flyTimer = null;
function startFlies() {
  fliesEl.style.display = "block";
  const tick = () => {
    fly1El.style.left = `${rand(0, 52)}px`;
    fly1El.style.top = `${rand(0, 52)}px`;
    fly2El.style.left = `${rand(0, 52)}px`;
    fly2El.style.top = `${rand(0, 52)}px`;
    flyTimer = setTimeout(tick, rand(120, 280)); // jerky, irregular -- real flies don't glide
  };
  tick();
}
function stopFlies() {
  fliesEl.style.display = "none";
  if (flyTimer) clearTimeout(flyTimer);
  flyTimer = null;
}

// ---------- sit baseline ----------
function settleToSit() {
  setFacing(-1);
  setStateName("sit");
  setFrame(ASSETS.sit[0]);
  diag();
}

// ---------- blink: quick eyes-closed swap, then back to neutral sit ----------
async function blink() {
  setStateName("sit");
  setFrame(ASSETS.sitBlink);
  diag();
  await wait(rand(BLINK_HOLD_MS[0], BLINK_HOLD_MS[1]));
  setFrame(ASSETS.sit[0]);
  diag();
}

// ---------- look up: sit_02 for a while, then settle back to neutral sit --
// sometimes it's just a glance up, sometimes flies are why she's looking --
// then settle back to neutral sit ----------
async function lookUp() {
  const withFlies = Math.random() < LOOK_UP_FLIES_CHANCE;
  setStateName("sit-lookup");
  setFrame(ASSETS.sit[1]);
  if (withFlies) startFlies();
  diag();
  await interruptibleWait(rand(LOOK_UP_HOLD_MS[0], LOOK_UP_HOLD_MS[1]));
  if (withFlies) stopFlies();
  settleToSit();
}

// ---------- walk: stride-locked translation + vertical bob, fixed timestep ----------
// Stops moving and animating the instant she reaches the target, then
// settles through idle cat2 -> cat1 as her "coming to a stop" beat.
// Includes a once-per-leg camera glance at GLANCE_FRAME_INDEX (walk_07 ->
// look_02).
async function walkTo(targetX, fps = SAUNTER_FPS) {
  targetX = Math.max(0, Math.min(maxX(), targetX));
  if (Math.abs(targetX - state.x) < 1) return; // already there -- no walking in place
  setStateName("walk");
  const frameCount = ASSETS.walk.length;
  const pxPerFrame = STRIDE_LENGTH_PX / frameCount;
  state.direction = targetX >= state.x ? 1 : -1;
  applyTransform();

  const clock = new FrameClock(fps);
  let lastTime = performance.now();
  let glanced = false; // only one camera-glance pause per walk leg

  await new Promise((resolve) => {
    function step() {
      const now = performance.now();
      const dt = now - lastTime;
      lastTime = now;
      const steps = clock.tick(dt, frameCount);

      for (let s = 0; s < steps; s++) {
        const dx = targetX - state.x;
        if (Math.abs(dx) < 0.01) {
          resolve();
          return;
        }
        if (Math.abs(dx) <= pxPerFrame) setX(targetX);
        else setX(state.x + Math.sign(dx) * pxPerFrame);

        const phase = (clock.frame / frameCount) * Math.PI * 2;
        state.bobY = -BOB_AMPLITUDE_PX * Math.abs(Math.sin(phase));
        applyTransform();

        if (!glanced && clock.frame === GLANCE_FRAME_INDEX) {
          glanced = true;
          setFrame(ASSETS.look[1]); // she pauses to glance at the viewer mid-stride
          diag();
          setTimeout(() => {
            lastTime = performance.now(); // don't let the pause register as elapsed walk-time
            requestAnimationFrame(step);
          }, GLANCE_PAUSE_MS);
          return;
        }

        setFrame(ASSETS.walk[clock.frame]);

        if (Math.abs(targetX - state.x) < 0.01) {
          resolve();
          return;
        }
      }
      requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  });

  state.bobY = 0;
  setStateName("idle"); // she's stopped -- switch off "walk"'s baseline before showing idle frames
  setFrame(ASSETS.idle[1]); // cat2
  diag();
  await wait(SETTLE_HOLD_MS);
  setFrame(ASSETS.idle[0]); // cat1
  diag();
}

// ---------- stretch: standing-only, straight through ----------
// Frame 1 (neutral stand) is never used: she starts at 2 (arched yawn)
// since she's already up by the time this plays. Plays straight through
// 2->3->4->5->6->7, holds briefly on 7, then either settles into sit_01
// (default) or steps back to frame 2 -- still standing, ready to walk.
async function stretchBehavior(settle = "sit") {
  setStateName("stretch");
  await playFrames(ASSETS.stretch.slice(1), [450, 500, 400, 250, 550, 700]); // 2->3->4->5->6->7, brief hold on 7

  if (settle === "walk") {
    setFrame(ASSETS.stretch[1]); // back to 2 -- still standing, ready to move
    diag();
    return;
  }
  settleToSit();
}

// ---------- get up and walk: stretch, walk out, walk home, sit back down.
// No sit-to-stand transition frame exists yet, so the cut from sit_01
// straight to the stretch pose is deliberate, not a bug -- same known gap
// as everywhere else she needs to visibly stand up from sitting. ----------
async function getUpAndWalk() {
  await stretchBehavior("walk");
  await walkTo(rand(0, maxX()), SAUNTER_FPS);
  await walkTo(homeX(), SAUNTER_FPS);
  settleToSit();
}

// ---------- behaviour loop: sit, mostly blinking, sometimes looking up,
// occasionally getting up to walk around ----------
function pickIdleAction() {
  const r = Math.random();
  if (r < GET_UP_CHANCE) return "get-up-walk";
  if (r < GET_UP_CHANCE + LOOK_UP_CHANCE) return "look-up";
  return "blink";
}

async function runIdleAction(name) {
  if (name === "get-up-walk") await getUpAndWalk();
  else if (name === "look-up") await lookUp();
  else await blink();
}

async function behaviourLoop() {
  while (true) {
    if (previewMode) {
      await wait(150); // parked -- remote is holding a single pose frame steady
      continue;
    }
    if (manualOverrideName) {
      const forced = manualOverrideName;
      manualOverrideName = null;
      await runIdleAction(forced);
      continue;
    }
    await interruptibleWait(rand(BLINK_GAP_MS[0], BLINK_GAP_MS[1]));
    if (previewMode || manualOverrideName) continue; // a remote command landed mid-gap -- let the branches above handle it next pass
    await runIdleAction(pickIdleAction());
  }
}

// ---------- remote control ----------
function handleRemoteCommand(payload) {
  if (!payload || typeof payload !== "object") return;
  switch (payload.kind) {
    case "behavior":
      previewMode = false;
      manualOverrideName = payload.name;
      requestSkip();
      break;
    case "skip":
      requestSkip();
      break;
    case "pose": {
      previewMode = true;
      requestSkip();
      const frames = ASSETS[payload.name];
      if (!frames) break;
      const list = Array.isArray(frames) ? frames : [frames];
      const idx = Math.max(0, Math.min(list.length - 1, payload.frameIndex ?? 0));
      const isLookUp = payload.name === "sit" && idx === 1;
      setStateName(isLookUp ? "sit-lookup" : payload.name === "sitBlink" ? "sit" : payload.name);
      setFrame(list[idx]);
      diag();
      break;
    }
    case "resume":
      previewMode = false;
      break;
  }
}

// ---------- boot ----------
async function boot() {
  await loadManifest();

  state.x = homeX();
  setX(state.x);
  settleToSit();

  window.ezra.onTrigger(handleRemoteCommand);

  behaviourLoop();
}

boot();
