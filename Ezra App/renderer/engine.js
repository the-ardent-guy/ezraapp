window.onerror = (msg, url, line, col, error) => {
  console.error("GLOBAL ERROR", msg, "at", line + ":" + col, error && error.stack);
};
console.log("engine.js starting, window.ezra =", typeof window.ezra);

// ============================================================
// Phase 1 checkpoint: manifest-driven core engine + one demo
// sequence (walk with vertical bob -> eat at bowl -> back to
// idle). Per EZRA_BUILD_BRIEF.md section 9, this is shown before
// the full state machine (transition graph, all interaction
// triggers, weighted picker) gets wired in.
// ============================================================

const SPRITE_WIDTH = 220;
const GROUND_BOTTOM = 60; // px from bottom of screen, matches CSS
const STRIDE_LENGTH_PX = 70; // px covered by one full walk cycle -- tunable, starting value
const BOB_AMPLITUDE_PX = 2; // vertical bob amplitude, 1-3px per brief
const WALK_FPS = 12; // ~83ms/frame, brief's starting value
const SAUNTER_FPS = 7; // slower deliberate pace, same stride length -> no foot-skate

const spriteEl = document.getElementById("sprite");
const bowlEl = document.getElementById("bowl");

const pad2 = (n) => String(n).padStart(2, "0");
const rand = (min, max) => min + Math.random() * (max - min);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function framePaths(name, count) {
  return Array.from({ length: count }, (_, i) => `../assets/ezra/${name}_${pad2(i + 1)}.png`);
}

// ---------- manifest loading (asset-driven, never hardcode frame counts) ----------
let manifest = null;
let ASSETS = null;

async function loadManifest() {
  const res = await fetch("../assets/ezra/manifest.json");
  manifest = await res.json();
  ASSETS = {};
  for (const [name, def] of Object.entries(manifest.states)) {
    ASSETS[name] = framePaths(name, def.frames);
  }
  ASSETS.bowl = {
    empty: `../assets/ezra/${manifest.props.bowl.empty}`,
    full: `../assets/ezra/${manifest.props.bowl.full}`,
  };
  console.log("manifest loaded:", Object.keys(ASSETS).map((k) => `${k}:${(ASSETS[k].length ?? "prop")}`).join(", "));
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
  // Advances frame(s) owed by dtMs. Returns how many frame-steps advanced
  // (can be >1 if the render loop hiccupped) so callers can translate by
  // exactly that many stride-steps -- keeps translation locked to frames.
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
  reset() {
    this.acc = 0;
    this.frame = 0;
  }
}

// ---------- global state ----------
const state = {
  x: 0,
  direction: -1, // -1 = facing left (native art direction), 1 = flipped right
  name: "boot",
  frame: 0,
  bobY: 0,
};

function maxX() {
  return window.innerWidth - SPRITE_WIDTH;
}

function setFacing(direction) {
  state.direction = direction;
  applyTransform();
}

function applyTransform() {
  const flip = state.direction === 1 ? -1 : 1;
  spriteEl.style.transform = `translateY(${state.bobY}px) scaleX(${flip})`;
}

function setX(x) {
  state.x = Math.max(0, Math.min(maxX(), x));
  spriteEl.style.left = `${state.x}px`;
}

function setFrame(src) {
  spriteEl.src = src;
}

function setStateName(name) {
  if (state.name !== name) {
    state.name = name;
    diag();
  }
}

// ---------- diagnostics: one line per state change and every N frames ----------
let diagFrameCounter = 0;
function diag(force) {
  diagFrameCounter++;
  if (force || diagFrameCounter % 30 === 0) {
    console.log(`${state.name} | frame${state.frame} | ${Math.round(state.x)},${GROUND_BOTTOM - Math.round(state.bobY)} | ${Date.now()}`);
  }
}

// ---------- oneshot playback helper (for eat/stretch/etc, not frame-locked) ----------
async function playFrames(frames, holdsMs) {
  for (let i = 0; i < frames.length; i++) {
    state.frame = i;
    setFrame(frames[i]);
    diag(true);
    await wait(Array.isArray(holdsMs) ? holdsMs[i] : holdsMs);
  }
}

// ---------- idle: always a breathing ping-pong loop, never a frozen frame ----------
async function idleLoop(signal) {
  setStateName("idle");
  let i = 0;
  while (!signal.stopped) {
    setFrame(ASSETS.idle[i % ASSETS.idle.length]);
    state.frame = i % ASSETS.idle.length;
    diag();
    await wait(rand(700, 900));
    i++;
  }
}

// ---------- walk: stride-locked translation + vertical bob, fixed timestep ----------
// Walks to targetX. Always finishes on the walk cycle's contact frame
// (index 0) rather than a hard cut, per "no hard cuts" rule -- once within
// range of the target she keeps cycling frames (translating the remaining
// distance) until frame 0 comes back around.
async function walkTo(targetX, fps = WALK_FPS) {
  setStateName("walk");
  targetX = Math.max(0, Math.min(maxX(), targetX));
  const frameCount = ASSETS.walk.length;
  const pxPerFrame = STRIDE_LENGTH_PX / frameCount; // locks translation to stride -- kills foot-skating
  state.direction = targetX >= state.x ? 1 : -1;
  applyTransform();

  const clock = new FrameClock(fps);
  let lastTime = performance.now();

  return new Promise((resolve) => {
    function step() {
      const now = performance.now();
      const dt = now - lastTime;
      lastTime = now;

      const steps = clock.tick(dt, frameCount);

      for (let s = 0; s < steps; s++) {
        // Recompute per frame-step (not once per rAF callback): snap exactly
        // to targetX on the final approaching step instead of letting a
        // pxPerFrame-sized step overshoot past it -- an overshoot flips the
        // sign next step and never converges (bounces forever, never <1px).
        const dx = targetX - state.x;
        if (Math.abs(dx) > 0.01) {
          if (Math.abs(dx) <= pxPerFrame) {
            setX(targetX);
          } else {
            setX(state.x + Math.sign(dx) * pxPerFrame);
          }
        }

        state.frame = clock.frame;
        setFrame(ASSETS.walk[clock.frame]);

        // vertical bob: two dips per 12-frame cycle, synced to step cadence
        const phase = (clock.frame / frameCount) * Math.PI * 2;
        state.bobY = -BOB_AMPLITUDE_PX * Math.abs(Math.sin(phase));
        applyTransform();
        diag();

        // arrived at target AND landed on the contact frame (0) -> done
        if (Math.abs(targetX - state.x) < 0.01 && clock.frame === 0) {
          state.bobY = 0;
          applyTransform();
          resolve();
          return;
        }
      }
      requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  });
}

// ---------- eat-at-bowl hook ----------
// Recipe per brief: up 250 -> down 250 -> hold-down 400 -> up; repeat 3-5 bites.
async function eatAtBowl(bites = rand(3, 5)) {
  setStateName("eat");
  bowlEl.src = ASSETS.bowl.full;
  for (let b = 0; b < Math.round(bites); b++) {
    state.frame = 0;
    setFrame(ASSETS.eat[0]); // up
    diag(true);
    await wait(250);
    state.frame = 1;
    setFrame(ASSETS.eat[1]); // down
    diag(true);
    await wait(250);
    await wait(400); // hold-down
  }
  state.frame = 0;
  setFrame(ASSETS.eat[0]); // up, cycle ends head-up
  bowlEl.src = ASSETS.bowl.empty;
  diag(true);
}

// ---------- boot: the Phase 1 checkpoint demo ----------
async function boot() {
  await loadManifest();

  state.x = window.innerWidth / 2;
  setX(state.x);
  setFacing(-1);
  setFrame(ASSETS.idle[0]);
  diag(true);

  const idleSignal = { stopped: false };
  let idleHandle = idleLoop(idleSignal);

  await wait(2000); // settle in idle briefly so the loop is visible before walking

  idleSignal.stopped = true;
  await idleHandle;

  // bowl prop sits at fixed CSS position (left:24px, bottom:24px, width:160px)
  const bowlX = 24 + 80 - SPRITE_WIDTH / 2; // roughly centered over the bowl
  await walkTo(bowlX, SAUNTER_FPS);
  await eatAtBowl();

  await walkTo(window.innerWidth / 2, WALK_FPS);

  const restSignal = { stopped: false };
  idleLoop(restSignal); // runs forever -- full state machine takes over from here next phase
}

boot();
