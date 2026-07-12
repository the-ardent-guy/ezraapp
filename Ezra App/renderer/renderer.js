window.onerror = (msg, url, line, col, error) => {
  console.error("GLOBAL ERROR", msg, "at", line + ":" + col, error && error.stack);
};
console.log("renderer.js starting, window.ezra =", typeof window.ezra);

// ---------- assets ----------
const ASSETS = {
  walk: Array.from({ length: 12 }, (_, i) => `../assets/walk/${i + 1}.png`),
  look: ["../assets/poses/Cat look/1.png", "../assets/poses/Cat look/2.png"], // substitutes for walk frames #4 and #7
  idle: ["../assets/poses/Cat idle/1.png", "../assets/poses/Cat idle/2.png"],
  sit: ["../assets/poses/Cat sit/1.png", "../assets/poses/Cat sit/2.png"],
  sleep: ["../assets/poses/Sleep/1.png", "../assets/poses/Sleep/2.png"],
  stretch: ["../assets/poses/Stretch/1.png", "../assets/poses/Stretch/2.png", "../assets/poses/Stretch/3.png"],
  pounce: ["../assets/poses/Pounce/1.png", "../assets/poses/Pounce/2.png", "../assets/poses/Pounce/3.png"],
  eat: ["../assets/poses/Eat/1.png", "../assets/poses/Eat/2.png"],
  catnip: [
    "../assets/poses/Catnip/1.png",
    "../assets/poses/Catnip/2.png",
    "../assets/poses/Catnip/3.png",
    "../assets/poses/Catnip/4.png", // front-facing "catnip stare"
  ],
};
const BOWL = { empty: "../assets/props/bowl_empty.png", full: "../assets/props/bowl_full.png" };

const SPRITE_WIDTH = 220;
const GROUND_BOTTOM = 60; // px from bottom of screen, matches CSS

const spriteEl = document.getElementById("sprite");
const bowlEl = document.getElementById("bowl");

// ---------- helpers ----------
const rand = (min, max) => min + Math.random() * (max - min);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const maxX = () => window.innerWidth - SPRITE_WIDTH;

function setFacing(direction) {
  // native art faces left. direction -1 = left (default), 1 = right (mirrored)
  spriteEl.style.transform = direction === 1 ? "scaleX(-1)" : "scaleX(1)";
}

function setFrame(src) {
  spriteEl.src = src;
}

function setX(x) {
  state.x = Math.max(0, Math.min(maxX(), x));
  spriteEl.style.left = `${state.x}px`;
}

// Same as setX but allows positions outside [0, maxX()] — used only for the
// walk-off/walk-on transit portions of groomAndLeaveSequence.
function setXUnclamped(x) {
  state.x = x;
  spriteEl.style.left = `${state.x}px`;
}

// Plays a sequence of frames once, each held for `ms`. Resolves when done.
async function playOnce(frames, ms) {
  for (const f of frames) {
    setFrame(f);
    await wait(ms);
  }
}

// Alternates two frames every `ms` for `durationMs` total. Resolves when done.
async function alternate(frames, ms, durationMs) {
  const cycles = Math.max(1, Math.round(durationMs / (ms * frames.length)));
  for (let c = 0; c < cycles; c++) {
    for (const f of frames) {
      setFrame(f);
      await wait(ms);
    }
  }
}

// ---------- global state ----------
const state = {
  x: window.innerWidth / 2,
  direction: -1, // -1 = walking/facing left, 1 = walking/facing right
  busy: false, // true while a one-shot sequence (stretch/pounce/eat/catnip/etc) owns the sprite
  cursor: { x: -9999, y: -9999, t: performance.now() },
  followingSince: 0,
  walkSpeed: rand(80, 120),
  distracted: false,
};

setX(state.x);
setFacing(state.direction);

// ---------- report sprite bounds to main process for click-through hit-testing ----------
function reportBounds() {
  const rect = spriteEl.getBoundingClientRect();
  window.ezra.reportSpriteBounds({
    x: Math.round(rect.left + window.screenX),
    y: Math.round(rect.top + window.screenY),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  });
}
setInterval(reportBounds, 100);

// ---------- cursor tracking ----------
window.ezra.onCursor(({ x, y }) => {
  const now = performance.now();
  const prev = state.cursor;
  const dt = (now - prev.t) / 1000;
  const dist = Math.hypot(x - prev.x, y - prev.y);
  const cursorSpeed = dt > 0 ? dist / dt : 0;
  state.cursor = { x, y, t: now };

  if (state.busy) return; // don't interrupt a one-shot sequence

  const rect = spriteEl.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const distToSprite = Math.hypot(x - cx, y - cy);

  if (cursorSpeed > 500 && distToSprite < 250) {
    triggerPounce();
    return;
  }

  if (distToSprite < 80) {
    if (state.mode !== "following") {
      state.mode = "following";
      state.followingSince = now;
    }
  } else if (distToSprite < 200) {
    if (state.mode !== "following") {
      if (state.mode !== "noticing") {
        // roll a stalk depth once per fresh notice, not every frame
        state.stalkFrame = Math.random() < 0.5 ? ASSETS.pounce[0] : ASSETS.pounce[2];
      }
      state.mode = "noticing";
    }
  } else if (state.mode === "noticing") {
    state.mode = null;
  }
});

// ---------- tray triggers ----------
window.ezra.onTrigger((name) => {
  if (name === "feed") feedSequence();
  if (name === "catnip") catnipSequence();
});

// ---------- one-shot sequences ----------
async function triggerPounce() {
  if (state.busy) return;
  state.busy = true;
  state.mode = null;
  await playOnce(ASSETS.pounce, 125); // crouch -> leap -> land, ~375ms total
  state.busy = false;
}

async function stretchSequence() {
  state.busy = true;
  await playOnce(ASSETS.stretch, 1000 / 6);
  await wait(1000); // hold final stretch frame
  state.busy = false;
}

async function sleepSequence(minMs, maxMs) {
  state.busy = true;
  setFrame(ASSETS.sleep[0]);
  await wait(5000); // curled, eyes open
  setFrame(ASSETS.sleep[1]); // deep sleep
  await wait(rand(minMs, maxMs));
  // wake
  setFrame(ASSETS.sleep[0]); // stirring
  await wait(1200);
  await playOnce(ASSETS.stretch, 1000 / 6);
  await wait(500);
  state.busy = false;
}

async function feedSequence() {
  if (state.busy) return;
  state.busy = true;
  bowlEl.src = BOWL.full;

  const bowlX = 24 + 80 - SPRITE_WIDTH / 2; // roughly centered over the bowl prop
  if (Math.abs(state.x - bowlX) > 300) {
    setFrame(ASSETS.idle[1]); // sniff/alert frame
    await wait(2000);
    await walkTo(bowlX);
  }

  await alternate(ASSETS.eat, 1000 / 2, rand(5000, 8000));
  bowlEl.src = BOWL.empty;

  await playOnce(ASSETS.stretch, 1000 / 6);
  await sitAndStare(30000);
  state.busy = false;
}

async function catnipSequence() {
  if (state.busy) return;
  state.busy = true;

  await playOnce(ASSETS.stretch, 1000 / 6); // she stretches before going into catnip mode
  setFrame(ASSETS.catnip[3]); // catnip stare (front-facing)
  await wait(2000);
  await alternate([ASSETS.catnip[0], ASSETS.catnip[1]], 1000 / 3, 5000); // rolling
  setFrame(ASSETS.catnip[2]); // settle, sprawled on side
  await wait(1500);

  await sleepSequence(3 * 60000, 5 * 60000);
  state.busy = false;
}

async function sitAndStare(durationMs) {
  const wasBusy = state.busy;
  state.busy = true;
  setFrame(ASSETS.sit[0]);
  await wait(durationMs);
  state.busy = wasBusy;
}

// Walks the sprite to targetX. By default honors screen bounds and uses
// state.walkSpeed; pass { speed } to override pace, or { clamp: false } to
// allow walking past the screen edge (used to exit off-screen).
async function walkTo(targetX, { speed, clamp = true } = {}) {
  if (clamp) targetX = Math.max(0, Math.min(maxX(), targetX));
  const moveSpeed = speed ?? state.walkSpeed;
  const setter = clamp ? setX : setXUnclamped;
  state.direction = targetX >= state.x ? 1 : -1;
  setFacing(state.direction);
  let frame = 0;
  let last = performance.now();
  while (Math.abs(state.x - targetX) > 2) {
    const now = performance.now();
    const dt = (now - last) / 1000;
    last = now;
    const step = moveSpeed * dt * (targetX >= state.x ? 1 : -1);
    let next = state.x + step;
    if ((state.direction === 1 && next >= targetX) || (state.direction === -1 && next <= targetX)) {
      next = targetX;
    }
    setter(next);
    setFrame(ASSETS.walk[frame % ASSETS.walk.length]);
    frame++;
    await wait(1000 / 12);
  }
}

// ---------- corner -> groom -> off-screen -> random re-entry ----------
const SAUNTER_SPEED = 45; // slower, deliberate — distinct from the 80-120 default walk
const GROOM_MIN = 4000, GROOM_MAX = 9000; // stub hold duration
const OFFSCREEN_MIN = 30000, OFFSCREEN_MAX = 90000; // how long she's "gone"

async function groomStub(ms) {
  // Placeholder: just holds her current pose for the duration. Once real
  // paw-licking frames exist, replace this call with:
  //   await alternate(ASSETS.groom, ms_per_frame, ms)
  await wait(ms);
}

async function groomAndLeaveSequence() {
  state.busy = true;
  const exitLeft = Math.random() < 0.5;
  const cornerX = exitLeft ? 0 : maxX();

  await walkTo(cornerX, { speed: SAUNTER_SPEED });
  await groomStub(rand(GROOM_MIN, GROOM_MAX));

  const offX = exitLeft ? -SPRITE_WIDTH - 40 : maxX() + SPRITE_WIDTH + 40;
  await walkTo(offX, { speed: SAUNTER_SPEED, clamp: false });
  spriteEl.style.visibility = "hidden";

  await wait(rand(OFFSCREEN_MIN, OFFSCREEN_MAX));

  const enterLeft = Math.random() < 0.5; // may differ from the edge she left by
  const startX = enterLeft ? -SPRITE_WIDTH - 40 : maxX() + SPRITE_WIDTH + 40;
  setXUnclamped(startX);
  state.direction = enterLeft ? 1 : -1;
  setFacing(state.direction);
  spriteEl.style.visibility = "visible";

  const settleX = enterLeft ? rand(40, 200) : rand(maxX() - 200, maxX() - 40);
  await walkTo(settleX, { speed: SAUNTER_SPEED }); // clamped — she's back on screen now
  state.busy = false;
}

// ---------- behaviour timer (weighted random) ----------
const BEHAVIOURS = [
  { name: "sleep", weight: 30 },
  { name: "sit-stare", weight: 20 },
  { name: "walk", weight: 15 },
  { name: "stretch", weight: 10 },
  { name: "corner-sit", weight: 8 },
  { name: "look-at-user", weight: 7 },
  { name: "zoomies", weight: 5 }, // no zoomies frames yet -> falls back to sit-stare, see below
  { name: "groom-and-leave", weight: 10 },
  { name: "rare-event", weight: 2 }, // only the asset-free sub-case is implemented for now
];
const TOTAL_WEIGHT = BEHAVIOURS.reduce((sum, b) => sum + b.weight, 0);

function pickBehaviour() {
  let r = Math.random() * TOTAL_WEIGHT;
  for (const b of BEHAVIOURS) {
    if (r < b.weight) return b.name;
    r -= b.weight;
  }
  return "sit-stare";
}

async function runBehaviour(name) {
  switch (name) {
    case "sleep":
      await walkTo(state.direction === -1 ? 0 : maxX());
      await sleepSequence(3 * 60000, 8 * 60000);
      break;
    case "sit-stare":
      await sitAndStare(rand(30000, 90000));
      break;
    case "walk":
      state.busy = true;
      await walkTo(rand(0, maxX()));
      state.busy = false;
      break;
    case "stretch":
      await stretchSequence();
      break;
    case "corner-sit": {
      const corner = state.x > maxX() / 2 ? maxX() : 0;
      state.busy = true;
      await walkTo(corner);
      state.busy = false;
      await sitAndStare(rand(20000, 40000));
      break;
    }
    case "look-at-user":
      // NOTE: no dedicated "look at user" front-facing asset yet; reusing the
      // catnip-stare frame (Catnip/4.png) as a placeholder per project notes.
      state.busy = true;
      setFrame(ASSETS.catnip[3]);
      await wait(rand(3000, 5000));
      state.busy = false;
      break;
    case "zoomies":
      // NOTE: no zoomies frames exist yet -- fall back to a safe default.
      await sitAndStare(rand(30000, 90000));
      break;
    case "groom-and-leave":
      await groomAndLeaveSequence();
      break;
    case "rare-event":
      // NOTE: only implementing the asset-free sub-case ("falls asleep mid-walk")
      // for now; the other two options need the zoomies frames.
      await sleepSequence(3 * 60000, 8 * 60000);
      break;
  }
}

async function behaviourLoop() {
  while (true) {
    await wait(rand(3 * 60000, 8 * 60000));
    if (state.busy || state.mode === "following") continue; // don't interrupt
    await runBehaviour(pickBehaviour());
  }
}
behaviourLoop();

// ---------- idle / walking main loop ----------
let idleFrameToggle = 0;
let lastIdleSwap = performance.now();
let idleSwapInterval = rand(2000, 4000);

let walkFrameIndex = 0;
let lastWalkFrameTime = performance.now();
const WALK_FRAME_MS = 1000 / 12;

let lastTick = performance.now();

function mainLoop() {
  const now = performance.now();
  const dt = (now - lastTick) / 1000;
  lastTick = now;

  if (!state.busy) {
    if (state.mode === "following") {
      // slowly follow the cursor horizontally
      if (now - state.followingSince > 10000) {
        state.mode = null; // lost interest
      } else {
        const targetX = state.cursor.x - SPRITE_WIDTH / 2;
        const dir = targetX > state.x ? 1 : -1;
        state.direction = dir;
        setFacing(dir);
        setX(state.x + dir * 60 * dt);
        if (now - lastWalkFrameTime > WALK_FRAME_MS) {
          walkFrameIndex = (walkFrameIndex + 1) % ASSETS.walk.length;
          setFrame(ASSETS.walk[walkFrameIndex]);
          lastWalkFrameTime = now;
        }
      }
    } else if (state.mode === "noticing") {
      // stalking: locks onto the cursor, faces it, bends low and stares.
      // stalkFrame is rolled once per fresh notice (see onCursor) between the
      // shallow crouch (Pounce/1) and the deeper flat crouch (Pounce/3).
      const dir = state.cursor.x > state.x + SPRITE_WIDTH / 2 ? 1 : -1;
      state.direction = dir;
      setFacing(dir);
      setFrame(state.stalkFrame || ASSETS.pounce[0]);
    } else {
      // default resting state — still, occasional idle-frame breathing swap.
      // Purposeful walking only happens via behaviourLoop (walk, corner-sit,
      // groom-and-leave, ...) or cursor-follow above, not ambiently here.
      if (now - lastIdleSwap > idleSwapInterval) {
        idleFrameToggle = 1 - idleFrameToggle;
        setFrame(ASSETS.idle[idleFrameToggle]);
        lastIdleSwap = now;
        idleSwapInterval = rand(2000, 4000);
      }
    }
  }

  requestAnimationFrame(mainLoop);
}
requestAnimationFrame(mainLoop);
