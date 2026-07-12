window.onerror = (msg, url, line, col, error) => {
  console.error("GLOBAL ERROR", msg, "at", line + ":" + col, error && error.stack);
};
console.log("engine.js starting, window.ezra =", typeof window.ezra);

// ============================================================
// v1 base state: she lives in the bottom-right corner. Weighted,
// corner-biased behavior loop -- no cursor reactions in this pass.
// ============================================================

const SPRITE_WIDTH = 220;
const GROUND_BOTTOM = 2; // matches CSS #stage bottom -- diagnostics only
const STRIDE_LENGTH_PX = 70; // px covered by one full walk cycle -- tunable
const BOB_AMPLITUDE_PX = 2; // vertical bob amplitude while walking
const SAUNTER_FPS = 7; // the only walk pace now -- faster paces made the legs blur/flutter
const HOME_MARGIN = 20; // px from the right edge for her home corner
const SETTLE_HOLD_MS = 120; // cat2 hold before dropping to cat1 when a walk stops
const GLANCE_FRAME_INDEX = 6; // walk_07, 0-indexed -- substituted with look_02 ("Sq 7")
const GLANCE_PAUSE_MS = 900; // roughly a second, holding the camera-glance pose

// Every pose's canvas has a different amount of empty transparent space
// below her feet (measured directly from the art: idle ~190px, sit ~168px,
// walk ~218px, etc, out of a 1000px canvas -- NOT consistent across poses).
// Without correcting for this, "sit exactly on the taskbar" is impossible:
// whichever offset makes one pose touch the ground makes every other pose
// float or clip. GROUND_SCALE converts the measured 1000px-canvas margin
// into a display-scale px shift applied on top of the bob.
const GROUND_SCALE = SPRITE_WIDTH / 1000;
const DEFAULT_GROUND_OFFSET = 190; // idle's margin, used for any unlisted state
const STATE_GROUND_OFFSET = {
  "sit-in-corner": 168,
  "sit-blink": 168,
  "sit-lookup": 162,
  "sit-tailwag": 168,
  walk: 220,
  groom: 214,
  "groom-pause": 214,
  stretch: 205,
  "wander-walk": 220,
  "sleep-settle": 218,
  "sleep-deep": 218,
  "sleep-stir": 218,
  "long-rest": 168,
  "wander-off": 220,
};

const stageEl = document.getElementById("stage");
const spriteEl = document.getElementById("sprite");
const fliesEl = document.getElementById("flies");
const fly1El = document.getElementById("fly1");
const fly2El = document.getElementById("fly2");
const zzzEl = document.getElementById("zzz");

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
  ASSETS.sitBlink = `../assets/ezra/${manifest.sitVariants.blink.file}`;
  console.log("manifest loaded:", Object.keys(ASSETS).map((k) => `${k}:${Array.isArray(ASSETS[k]) ? ASSETS[k].length : "single"}`).join(", "));
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
  frame: 0,
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

// unclamped -- only for the rare wander-off-screen behavior, which needs to
// push state.x past the normal [0, maxX()] viewport bounds
function setXRaw(x) {
  state.x = x;
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
    diag(true);
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

// ---------- oneshot playback helper ----------
async function playFrames(frames, holdsMs) {
  for (let i = 0; i < frames.length; i++) {
    state.frame = i;
    setFrame(frames[i]);
    diag(true);
    await wait(Array.isArray(holdsMs) ? holdsMs[i] : holdsMs);
  }
}

// ---------- fly dots (shown during sit_02 look-up) ----------
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

// ---------- walk: stride-locked translation + vertical bob, fixed timestep ----------
// Stops moving and animating the instant she reaches the target -- no
// riding out leftover walk frames in place -- then settles through
// cat2 -> cat1 (idle[1] -> idle[0]) as her "coming to a stop" beat.
// Callers decide what happens next (sit, groom, walk again).
// { clamp: false } lets targetX go past the screen edges and skips the
// viewport clamp on every step -- only used by the wander-off behavior,
// which needs her to actually leave and re-enter the visible screen.
// { settle: false } skips the cat2->cat1 stop beat, for when the caller
// has more to do before she's meant to look settled (e.g. she's offscreen).
async function walkTo(targetX, fps = SAUNTER_FPS, { clamp = true, settle = true } = {}) {
  if (clamp) targetX = Math.max(0, Math.min(maxX(), targetX));
  if (Math.abs(targetX - state.x) < 1) return; // already there -- no walking in place
  setStateName(clamp ? "walk" : "wander-off");
  const frameCount = ASSETS.walk.length;
  const pxPerFrame = STRIDE_LENGTH_PX / frameCount;
  const setPos = clamp ? setX : setXRaw;
  state.direction = targetX >= state.x ? 1 : -1;
  applyTransform();

  const clock = new FrameClock(fps);
  let lastTime = performance.now();

  let glanced = false; // only one camera-glance pause per walk leg, not every stride cycle

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
        if (Math.abs(dx) <= pxPerFrame) setPos(targetX);
        else setPos(state.x + Math.sign(dx) * pxPerFrame);

        state.frame = clock.frame;
        const phase = (clock.frame / frameCount) * Math.PI * 2;
        state.bobY = -BOB_AMPLITUDE_PX * Math.abs(Math.sin(phase));
        applyTransform();

        if (!glanced && clock.frame === GLANCE_FRAME_INDEX) {
          glanced = true;
          setFrame(ASSETS.look[1]); // "Sq 7" -- she pauses to glance at the viewer mid-stride
          diag(true);
          setTimeout(() => {
            lastTime = performance.now(); // don't let the pause register as elapsed walk-time
            requestAnimationFrame(step);
          }, GLANCE_PAUSE_MS);
          return;
        }

        setFrame(ASSETS.walk[clock.frame]);
        diag();

        if (Math.abs(targetX - state.x) < 0.01) {
          resolve();
          return;
        }
      }
      requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  });

  if (!settle) return; // caller decides what happens next
  state.bobY = 0;
  applyTransform();
  setFrame(ASSETS.idle[1]); // cat2
  diag(true);
  await wait(SETTLE_HOLD_MS);
  setFrame(ASSETS.idle[0]); // cat1
  diag(true);
}

// ---------- groom: paw-licking loop ----------
async function groomLoop(durationMs) {
  setStateName("groom");
  const endAt = performance.now() + durationMs;
  let i = 0;
  while (performance.now() < endAt) {
    state.frame = i % ASSETS.groom.length;
    setFrame(ASSETS.groom[state.frame]);
    diag();
    await wait(rand(300, 450));
    i++;
  }
}

// ---------- sit-in-corner: blink loop with look-up and tail-wag interrupts ----------
async function blinkLoop(durationMs) {
  setStateName("sit-blink");
  const endAt = performance.now() + durationMs;
  while (performance.now() < endAt) {
    state.frame = 0;
    setFrame(ASSETS.sit[0]);
    diag();
    await wait(rand(2500, 4500)); // eyes open between blinks
    state.frame = 1;
    setFrame(ASSETS.sitBlink);
    diag();
    await wait(rand(120, 220)); // blink duration
  }
  state.frame = 0;
  setFrame(ASSETS.sit[0]);
}

async function lookUpAtFlies() {
  setStateName("sit-lookup");
  state.frame = 1;
  setFrame(ASSETS.sit[1]); // sit_02
  startFlies();
  diag(true);
  await wait(rand(10000, 12000)); // at least 10-12s, per direction
  stopFlies();
  state.frame = 0;
  setFrame(ASSETS.sit[0]);
  diag(true);
}

async function tailWagCycle(durationMs = rand(8000, 12000)) {
  setStateName("sit-tailwag");
  const endAt = performance.now() + durationMs;
  const frameCount = ASSETS.tailwag.length;
  let i = 0;
  let dir = 1; // ping-pong (0->3->0->3...) so the tail sweeps back out instead of snapping
  while (performance.now() < endAt) {
    state.frame = i;
    setFrame(ASSETS.tailwag[state.frame]);
    diag();
    await wait(rand(300, 500));
    if (i + dir >= frameCount || i + dir < 0) dir *= -1;
    i += dir;
  }
  state.frame = 0;
  setFrame(ASSETS.sit[0]);
}

async function sitInCorner(totalMs) {
  setStateName("sit-in-corner");
  const endAt = performance.now() + totalMs;
  while (performance.now() < endAt) {
    await blinkLoop(rand(8000, 15000));
    if (performance.now() >= endAt) break;
    if (Math.random() < 0.75) {
      await lookUpAtFlies();
    } else {
      await tailWagCycle();
    }
  }
  setFrame(ASSETS.sit[0]);
}

// ---------- stretch: oneshot forward, hold, reverse ----------
// Three separate places want to trigger this (the standalone "stretch"
// behavior, getting up from sit-in-corner, settling in before long-rest)
// -- without a cooldown they can fire back-to-back and she stretches
// two or three times in a row, which no cat does. { force: true } is for
// the standalone behavior, where a real stretch is the whole point.
let lastStretchAt = -Infinity;
const STRETCH_COOLDOWN_MS = 30000;

async function stretchBehavior({ force = false } = {}) {
  if (!force && performance.now() - lastStretchAt < STRETCH_COOLDOWN_MS) {
    setFrame(ASSETS.idle[0]); // just stretched recently -- stand up quietly instead
    return;
  }
  lastStretchAt = performance.now();
  setStateName("stretch");
  await playFrames(ASSETS.stretch, [300, 450, 600]); // 1 -> 2 -> 3
  await wait(1000); // hold frame 3 ~1s
  await playFrames([ASSETS.stretch[1], ASSETS.stretch[0]], [400, 300]); // 3 -> 2 -> 1
  setFrame(ASSETS.idle[0]); // settle onto standing idle rather than freezing on the stretch pose
}

// ---------- long-rest: walk to corner, sleep (still, Zzz), wake, stretch ----------
async function longRestBehavior() {
  setStateName("long-rest");
  if (Math.abs(state.x - homeX()) > 2) {
    await walkTo(homeX(), SAUNTER_FPS);
  }
  setFacing(-1);
  await stretchBehavior(); // stretches before lying down, not an abrupt drop to sitting

  // settle down before curling up -- idle -> sit_01 -> sit_02 -> sleep_01,
  // not a straight stand-to-asleep cut
  state.frame = 0;
  setFrame(ASSETS.sit[0]);
  diag(true);
  await wait(rand(1000, 2000));
  state.frame = 1;
  setFrame(ASSETS.sit[1]);
  diag(true);
  await wait(rand(800, 1500));

  setStateName("sleep-settle");
  setFrame(ASSETS.sleep[0]); // curled, eyes open
  diag(true);
  await wait(rand(4000, 7000));

  setStateName("sleep-deep");
  setFrame(ASSETS.sleep[1]);
  zzzEl.style.display = "block";
  diag(true);

  // holds still -- no Y-bob. Breathing will come from a dedicated
  // lung-expansion sprite frame later, not a fake up/down motion.
  await wait(rand(60000, 180000));
  zzzEl.style.display = "none";

  setStateName("sleep-stir");
  setFrame(ASSETS.sleep[0]);
  diag(true);
  await wait(1200);

  await stretchBehavior(); // ends standing on idle -- no forced re-seat after
}

// ---------- wander-walk: random point, then groom / sit / head home ----------
async function wanderWalkBehavior() {
  setStateName("wander-walk");
  await walkTo(rand(0, maxX()), SAUNTER_FPS);
  // settled on cat1 -- decide what happens next, per "she doesn't have to
  // keep marching": groom right here, sit a moment, or usually head home.
  const roll = Math.random();
  if (roll < 0.3) {
    await groomLoop(rand(10000, 15000));
    setFrame(ASSETS.idle[0]);
  } else if (roll < 0.5) {
    setFrame(ASSETS.idle[0]);
    await wait(rand(5000, 15000));
  } else {
    await walkTo(homeX(), SAUNTER_FPS);
    setFacing(-1);
  }
}

// ---------- groom-pause: stop wherever she is and groom ----------
async function groomPauseBehavior() {
  await groomLoop(rand(10000, 15000));
  setFrame(ASSETS.idle[0]);
}

// ---------- wander-off: rarely, she walks clean off the edge of the
// screen, stays gone a while, then wanders back in on her own ----------
async function wanderOffScreenBehavior() {
  setStateName("wander-off");
  const exitLeft = Math.random() < 0.5;
  const exitX = exitLeft ? -SPRITE_WIDTH - 40 : maxX() + SPRITE_WIDTH + 40;
  await walkTo(exitX, SAUNTER_FPS, { clamp: false, settle: false });
  await wait(rand(15000, 45000)); // gone for a while before wandering back in
  await walkTo(homeX(), SAUNTER_FPS, { clamp: false });
  setFacing(-1);
}

// ---------- behaviour picker (weighted, corner-biased) ----------
const BEHAVIOURS = [
  { name: "sit-in-corner", weight: 45 },
  { name: "wander-walk", weight: 25 },
  { name: "groom-pause", weight: 15 },
  { name: "stretch", weight: 10 },
  { name: "long-rest", weight: 5 },
  { name: "wander-off", weight: 3 }, // rare -- keep this low
];
const TOTAL_WEIGHT = BEHAVIOURS.reduce((sum, b) => sum + b.weight, 0);

function pickBehaviour() {
  let r = Math.random() * TOTAL_WEIGHT;
  for (const b of BEHAVIOURS) {
    if (r < b.weight) return b.name;
    r -= b.weight;
  }
  return "sit-in-corner";
}

async function runBehaviour(name) {
  switch (name) {
    case "sit-in-corner":
      if (Math.abs(state.x - homeX()) > 2) await walkTo(homeX(), SAUNTER_FPS);
      setFacing(-1);
      await sitInCorner(rand(20000, 60000));
      await stretchBehavior(); // gets up onto 4 legs before whatever's next
      break;
    case "wander-walk":
      await wanderWalkBehavior();
      break;
    case "groom-pause":
      await groomPauseBehavior();
      break;
    case "stretch":
      await stretchBehavior({ force: true }); // picked deliberately -- always show the real thing
      break;
    case "long-rest":
      await longRestBehavior();
      break;
    case "wander-off":
      await wanderOffScreenBehavior();
      break;
  }
}

async function behaviourLoop() {
  while (true) {
    await runBehaviour(pickBehaviour());
    setFrame(ASSETS.idle[0]);
    await wait(rand(500, 1500)); // brief settle beat between behaviors
  }
}

// ---------- boot ----------
async function boot() {
  await loadManifest();

  state.x = homeX();
  setX(state.x);
  setFacing(-1);
  setFrame(ASSETS.idle[0]);
  diag(true);

  behaviourLoop();
}

boot();
