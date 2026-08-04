window.onerror = (msg, url, line, col, error) => {
  console.error("GLOBAL ERROR", msg, "at", line + ":" + col, error && error.stack);
};
console.log("engine.js (V1mini) starting, window.ezra =", typeof window.ezra);

// ============================================================
// V1mini. She sits on the cushion, mostly blinking (sit_01 <-> sit_blink),
// occasionally looking up (sit_02, sometimes at flies), occasionally
// grooming or flicking her tail, occasionally napping, and occasionally
// getting up -- almost always just a short stroll away from the cushion and
// back, rarely a full walk clear across the screen. The cursor-whack system
// exists in this file (see the "Cursor-whack system" block below) but is
// deliberately NOT started in boot() -- it's not part of V1mini yet.
// ============================================================

const SPRITE_WIDTH = 220;
const HOME_MARGIN = 0; // px from the right edge -- flush against it, matches the cushion's anchor
const GROUND_SCALE = SPRITE_WIDTH / 1000;
const DEFAULT_GROUND_OFFSET = 168; // sit_01's measured ground margin
const STATE_GROUND_OFFSET = {
  sit: 168,
  "sit-lookup": 157, // sit_02 -- tilted head shifts the measured offset slightly (re-measured 2026-08-01 after a fresh art pass)
  idle: 190,
  walk: 220,
  stretch: 205,
  sleep: 168, // all 5 frames recentered in-place to share this exact bottom margin (see manifest.json sleep note) -- ground-contact line holds steady across the whole sequence
  tailwag: 168, // same body as sit_01 throughout -- bottom bbox margin drifts 163-186 across frames 1-4, but that's the tail lifting off the ground, not the body/paws shifting, so unlike sleep this does NOT need per-frame recentering
  groom: 168, // seated sit_01 body pose throughout -- measured margins 170/171/171, close enough to sit's 168 to not need recentering (the small left-edge drift across frames is the raised paw, not the body)
  whack: 199, // dedicated whack art (own body pose) -- frames 02-05 recentered in-place to share this exact margin, see manifest.json's whack note
};

const BLINK_HOLD_MS = [90, 160]; // eyes-closed duration range -- quick, not a slow fade
const BLINK_GAP_MS = [2000, 6000]; // natural time between blinks -- drives blinkLoop's own cadence now, independent of the other-behaviors roll below
const ACTION_ROLL_GAP_MS = [2000, 6000]; // how often the other-behaviors loop rerolls whether to start something (look-up/sleep/tailwag/groom/walk/wander-off) -- separate cadence from blinking so the two don't compete for the same slot
const LOOK_UP_CHANCE = 0.15; // rolled at each action-roll gap
const LOOK_UP_HOLD_MS = [4000, 8000]; // how long she holds sit_02 before settling back
const LOOK_UP_FLIES_CHANCE = 0.5; // of a look-up, how often it's because a fly's caught her eye vs. just glancing up
const GET_UP_CHANCE = 0.04; // rolled at the same gap -- getting up and walking ALL THE WAY ACROSS THE SCREEN. Deliberately rarer than SHORT_STROLL_CHANCE below -- crossing the whole screen should read as an occasional event, not routine.
const SHORT_STROLL_CHANCE = 0.08; // rolled at the same gap -- a brief step away from the cushion and back, more common than the full crossing but still not the default
const STROLL_DISTANCE_PX = [90, 220]; // how far she wanders from home during a short stroll -- stays near the cushion, well short of a screen crossing
const WANDER_OFF_CHANCE = 0.03; // rolled at the same gap -- rarer than even the full-screen walk: she leaves the screen entirely for a while
const WANDER_AWAY_MS = [20000, 120000]; // how long she stays off-screen before coming back -- randomized ("at her own will"), 20s-2min per behavior request; tune freely
const SLEEP_CHANCE = 0.08; // rolled at the same gap -- settling down for a nap, straight from sit, no stretch/stand involved
const SLEEP_TRANSITION_MS = [500, 450]; // lowering (frame 2), curling in (frame 3)
const SLEEP_BREATH_MS = [1900, 2600]; // hold per breathing-loop frame (4 <-> 5) -- slow, deliberate, not a quick flicker
const SLEEP_BREATH_CYCLES = [145, 260]; // number of full breath pairs before waking -- at ~4.5s/cycle avg this is roughly 11-19.5 minutes per nap (~15 min avg), a real minimum-length request, not a quick doze
const ZZZ_START_CYCLE = 2; // breathing cycles in before the Zzz overlay appears -- not the instant she lies down, only once she's properly settled
const TAILWAG_CHANCE = 0.12; // rolled at the same gap -- a quick tail flick, straight from sit, no stretch/stand involved
const TAILWAG_FRAME_MS = [110, 170]; // hold per frame during the sweep -- snappy, not a slow drift
const TAILWAG_REPEATS = [3, 4]; // how many out-and-back sweeps per flick -- rounds to 3 or 4, not a single sweep
const GROOM_CHANCE = 0.1; // rolled at the same gap -- a bout of paw-licking, straight from sit, no stretch/stand involved
const GROOM_FRAME_MS = [220, 380]; // hold per frame within a lick cycle -- more deliberate than tailwag's flick, faster than sleep's breathing

// Cursor-whack system. Deliberately NOT part of the idle roll (see
// whackLoop/whackSequence further down): no chance constant here feeds
// pickIdleAction, on purpose.
const WHACK_APPROACH_DIST = 150; // px, 2D distance from cursor to her live sprite bbox -- lingering within this starts the approach, and doubles as the "far enough to disengage" threshold once she's striking
const WHACK_APPROACH_DWELL_MS = 2000; // how long the cursor has to stay within that radius before she reacts and walks over
const WHACK_STRIKE_DIST = 60; // px -- once she's within this distance (either already, or by walking over), she stops and starts whacking
const WHACK_WATCH_MS = 2000; // hold on whack_02 (the watching pose) once she's stopped, before the strike beats begin
const WHACK_BEAT_MS = [90, 140]; // snappy per-beat hold during the 3-4-5 strike loop -- quicker than tailwag's flick, this is a hit not a sweep
const WHACK_COOLDOWN_MS = 2500; // minimum gap after disengaging before the approach can arm again
const GROOM_LICK_CYCLES = [2, 5]; // number of full lick cycles before settling back

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
const zzzEl = document.getElementById("zzz");

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
    sleep: framePaths("sleep", manifest.states.sleep.frames), // 01 = sit-matched, 02 = lowering, 03 = curled settle, 04/05 = breathing loop
    tailwag: framePaths("tailwag", manifest.states.tailwag.frames), // 01 = curled in (matches sit_01), 02-04 = tail sweeping out
    groom: framePaths("groom", manifest.states.groom.frames), // 01 = eyes open mid-lick, 02 = eyes closed paw lower, 03 = eyes closed paw raised
    pounce: framePaths("pounce", manifest.states.pounce.frames), // 01 = coiled ready crouch, 02 = airborne leap, 03 = landed crouch -- imported but currently unused by any behavior
    whack: framePaths("whack", manifest.states.whack.frames), // 01 = unused (play-bow stretch), 02 = watching pose, 03-05 = paw-swipe cycle
  };
  console.log(
    `manifest loaded: sit:${ASSETS.sit.length}, sitBlink:single, idle:${ASSETS.idle.length}, walk:${ASSETS.walk.length}, stretch:${ASSETS.stretch.length}, look:${ASSETS.look.length}, sleep:${ASSETS.sleep.length}, tailwag:${ASSETS.tailwag.length}, groom:${ASSETS.groom.length}, pounce:${ASSETS.pounce.length}, whack:${ASSETS.whack.length}`
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

function setX(x, allowOffscreen = false) {
  state.x = allowOffscreen ? x : Math.max(0, Math.min(maxX(), x));
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

// ---------- Zzz overlay (shown partway through the sleep breathing loop) ----------
function startZzz() {
  zzzEl.style.display = "block";
}
function stopZzz() {
  zzzEl.style.display = "none";
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
//
// `shouldStop`, if given, is checked every step and cuts the walk short the
// instant it returns true -- used by the whack system to stop her partway
// through a walk-to-cursor the moment she's close enough, rather than
// forcing her all the way to a fixed target first. Existing callers don't
// pass it, so `stoppedEarly` is always false for them and this changes
// nothing about their behavior. When a walk *is* cut short, the normal
// idle-settle tail (cat2 -> pause -> cat1) is skipped -- she isn't "arriving
// home", she's stopping because something else is about to take over, and
// that caller is responsible for its own settle.
//
// `allowOffscreen`, if true, skips the normal clamp-to-[0, maxX()] on both
// the target and every intermediate step -- used only by wanderOff() so she
// can actually walk past the screen edge and back rather than snapping to
// the boundary. Every other caller leaves this false and keeps the old
// stay-on-screen behavior.
async function walkTo(targetX, fps = SAUNTER_FPS, shouldStop = null, allowOffscreen = false) {
  if (!allowOffscreen) targetX = Math.max(0, Math.min(maxX(), targetX));
  if (Math.abs(targetX - state.x) < 1) return; // already there -- no walking in place
  setStateName("walk");
  const frameCount = ASSETS.walk.length;
  const pxPerFrame = STRIDE_LENGTH_PX / frameCount;
  state.direction = targetX >= state.x ? 1 : -1;
  applyTransform();

  const clock = new FrameClock(fps);
  let lastTime = performance.now();
  let glanced = false; // only one camera-glance pause per walk leg
  let stoppedEarly = false;

  await new Promise((resolve) => {
    function step() {
      const now = performance.now();
      const dt = now - lastTime;
      lastTime = now;
      const steps = clock.tick(dt, frameCount);

      for (let s = 0; s < steps; s++) {
        if (shouldStop && shouldStop()) {
          stoppedEarly = true;
          resolve();
          return;
        }
        const dx = targetX - state.x;
        if (Math.abs(dx) < 0.01) {
          resolve();
          return;
        }
        if (Math.abs(dx) <= pxPerFrame) setX(targetX, allowOffscreen);
        else setX(state.x + Math.sign(dx) * pxPerFrame, allowOffscreen);

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
  if (stoppedEarly) return;

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

// ---------- get up and walk: stretch, walk ALL THE WAY ACROSS THE SCREEN to
// a random point, walk home, sit back down. The rare, big-traversal walk --
// see SHORT_STROLL_CHANCE above for the more common, cushion-local version.
// No sit-to-stand transition frame exists yet, so the cut from sit_01
// straight to the stretch pose is deliberate, not a bug -- same known gap
// as everywhere else she needs to visibly stand up from sitting. ----------
async function getUpAndWalk() {
  await stretchBehavior("walk");
  await walkTo(rand(0, maxX()), SAUNTER_FPS);
  await walkTo(homeX(), SAUNTER_FPS);
  settleToSit();
}

// ---------- short stroll: stretch, step a short distance away from the
// cushion, walk straight back, sit back down. Same stretch/walk/settle shape
// as getUpAndWalk, just a much smaller round trip -- she never leaves the
// cushion's neighborhood. This is the common walking behavior; getUpAndWalk
// (a full screen crossing) is the rare one. ----------
async function shortStroll() {
  await stretchBehavior("walk");
  const dist = rand(STROLL_DISTANCE_PX[0], STROLL_DISTANCE_PX[1]);
  await walkTo(homeX() - dist, SAUNTER_FPS);
  await walkTo(homeX(), SAUNTER_FPS);
  settleToSit();
}

// ---------- wander off: stretch, walk clean off the left edge of the screen
// (allowOffscreen -- see walkTo), stay gone for a randomized stretch of time,
// then walk back in and settle. Rarer than even the full-screen crossing --
// this is the "where'd she go" behavior. The away-wait is interruptible so a
// Remote "Skip" can call her back early instead of forcing the full random
// wait. If she's called back early or the wait just runs out, setX() snaps
// her exactly to the off-screen jump-off point before walking back in, so
// the walk-back always starts from the same place regardless of how the
// wait ended. ----------
async function wanderOff() {
  await stretchBehavior("walk");
  const offX = -SPRITE_WIDTH - 40; // fully clear of the left edge, well past any anti-aliased sliver
  await walkTo(offX, SAUNTER_FPS, null, true);
  setX(offX, true); // guard against any float drift leaving her a hair on-screen
  await interruptibleWait(rand(WANDER_AWAY_MS[0], WANDER_AWAY_MS[1]));
  await walkTo(homeX(), SAUNTER_FPS, null, true);
  settleToSit();
}

// ---------- sleep: straight from sit, no stretch/stand -- she lowers in
// place, curls up, breathes for a while, then reverses the same transition
// back up into sit. Only the breathing hold is interruptible (skip cuts a
// nap short); the lowering/curling/waking beats play straight through like
// blink's and walk's own timing, so a skip can't freeze her mid-motion. ----------
async function sleepBehavior() {
  setStateName("sleep");
  setFrame(ASSETS.sleep[1]); // lowering
  diag();
  await wait(SLEEP_TRANSITION_MS[0]);
  setFrame(ASSETS.sleep[2]); // curled, settling
  diag();
  await wait(SLEEP_TRANSITION_MS[1]);

  const cycles = Math.round(rand(SLEEP_BREATH_CYCLES[0], SLEEP_BREATH_CYCLES[1]));
  for (let i = 0; i < cycles; i++) {
    if (i === ZZZ_START_CYCLE) startZzz(); // only once she's been under a while, not the instant she lies down
    setFrame(ASSETS.sleep[3]);
    diag();
    if (await interruptibleWait(rand(SLEEP_BREATH_MS[0], SLEEP_BREATH_MS[1]))) break;
    setFrame(ASSETS.sleep[4]);
    diag();
    if (await interruptibleWait(rand(SLEEP_BREATH_MS[0], SLEEP_BREATH_MS[1]))) break;
  }
  stopZzz(); // waking begins here (skip-interrupted or cycles ran out) -- Zzz is gone before the reverse transition starts

  setFrame(ASSETS.sleep[2]); // curled, waking
  diag();
  await wait(SLEEP_TRANSITION_MS[1]);
  setFrame(ASSETS.sleep[1]); // rising back through the lowering pose
  diag();
  await wait(SLEEP_TRANSITION_MS[0]);
  settleToSit();
}

// ---------- tail wag: several quick flicks, straight from sit -- same body
// as sit_01 throughout (per manifest note only the tail itself moves), so
// this is a full-frame swap like blink, not a stretch/stand behavior. Each
// pass sweeps out 1->2->3 then back down 2->1, repeated TAILWAG_REPEATS
// times (only settling fully curled on the very last pass) rather than
// curling all the way in between -- a real flick reads as several quick
// swings in a row, not curl-uncurl-curl-uncurl. No interruptible wait since
// it's short enough not to need a skip mid-flick. ----------
async function tailWag() {
  setStateName("tailwag");
  const repeats = Math.round(rand(TAILWAG_REPEATS[0], TAILWAG_REPEATS[1]));
  for (let r = 0; r < repeats; r++) {
    const sweep = r === repeats - 1 ? [1, 2, 3, 2, 1, 0] : [1, 2, 3, 2, 1]; // only the last pass settles to curled (0)
    for (const idx of sweep) {
      setFrame(ASSETS.tailwag[idx]);
      diag();
      await wait(rand(TAILWAG_FRAME_MS[0], TAILWAG_FRAME_MS[1]));
    }
  }
  settleToSit();
}

// ---------- groom: a bout of paw-licking, straight from sit -- seated sit_01
// body pose throughout (per manifest note), so this is a full-frame swap like
// blink/tailwag, not a stretch/stand behavior. Cycles through a lick beat
// (open -> paw-lower -> paw-raised -> paw-lower) a few times before settling.
// The lick-cycle hold is interruptible so a skip can end a bout early instead
// of forcing it to run out. ----------
async function groomBehavior() {
  setStateName("groom");
  const cycles = Math.round(rand(GROOM_LICK_CYCLES[0], GROOM_LICK_CYCLES[1]));
  outer: for (let i = 0; i < cycles; i++) {
    for (const idx of [0, 1, 2, 1]) {
      setFrame(ASSETS.groom[idx]);
      diag();
      if (await interruptibleWait(rand(GROOM_FRAME_MS[0], GROOM_FRAME_MS[1]))) break outer;
    }
  }
  settleToSit();
}

// ---------- other-behaviors loop: sometimes looking up, occasionally getting
// up (short stroll near the cushion, rarer full walk across the screen,
// rarer still wandering off-screen entirely), settling in for a nap,
// flicking her tail, or grooming. Blinking is NOT rolled here anymore -- see
// blinkLoop below, which runs continuously and independently whenever she's
// just sitting, instead of competing with these for the same slot. A null
// return means nothing special won this roll -- blinkLoop covers that time. ----------
function pickIdleAction() {
  const r = Math.random();
  if (r < WANDER_OFF_CHANCE) return "wander-off";
  if (r < WANDER_OFF_CHANCE + GET_UP_CHANCE) return "get-up-walk";
  if (r < WANDER_OFF_CHANCE + GET_UP_CHANCE + SHORT_STROLL_CHANCE) return "short-stroll";
  if (r < WANDER_OFF_CHANCE + GET_UP_CHANCE + SHORT_STROLL_CHANCE + LOOK_UP_CHANCE) return "look-up";
  if (r < WANDER_OFF_CHANCE + GET_UP_CHANCE + SHORT_STROLL_CHANCE + LOOK_UP_CHANCE + SLEEP_CHANCE) return "sleep";
  if (
    r <
    WANDER_OFF_CHANCE + GET_UP_CHANCE + SHORT_STROLL_CHANCE + LOOK_UP_CHANCE + SLEEP_CHANCE + TAILWAG_CHANCE
  )
    return "tailwag";
  if (
    r <
    WANDER_OFF_CHANCE +
      GET_UP_CHANCE +
      SHORT_STROLL_CHANCE +
      LOOK_UP_CHANCE +
      SLEEP_CHANCE +
      TAILWAG_CHANCE +
      GROOM_CHANCE
  )
    return "groom";
  return null;
}

async function runIdleAction(name) {
  if (name === "wander-off") await wanderOff();
  else if (name === "get-up-walk") await getUpAndWalk();
  else if (name === "short-stroll") await shortStroll();
  else if (name === "look-up") await lookUp();
  else if (name === "sleep") await sleepBehavior();
  else if (name === "tailwag") await tailWag();
  else if (name === "groom") await groomBehavior();
  else if (name === "blink") await blink(); // still reachable via manual override / Remote button
}

// ============================================================
// Cursor-whack system.
//
// Standalone, intentionally kept OUT of pickIdleAction()/runIdleAction()'s
// dispatch table above -- never part of the random idle roll. Driven purely
// by live cursor position, via its own independent loop (whackLoop, started
// in boot() alongside behaviourLoop) rather than being dispatched through
// behaviourLoop the way the old single-shot prototype was. While a sequence
// is running, `whackActive` tells behaviourLoop to stand down (checked at
// the top of its while-loop, same pattern as previewMode) so the two never
// fight over state/frames.
//
// Uses the real dedicated "whack" art (5 frames, imported 2026-08-02 -- see
// manifest.json's whack note), not a reuse of pounce/other poses like the
// first prototype. whack_01 is never used here. whack_02 is the watching/
// stalking pose; whack_03/04/05 are a paw-swipe cycle that reads as
// continuous batting when looped 03->04->05->03...
//
// Two stages:
//  1. APPROACH -- the cursor has to stay within WHACK_APPROACH_DIST of her
//     (2D distance to her live sprite bbox, tracked continuously by
//     onCursorMove/approachDwellMs below) for WHACK_APPROACH_DWELL_MS
//     straight before she reacts. She then walks toward the cursor's
//     x-position using her normal walking art/pace (no separate slow-walk
//     system -- her existing stride speed already works out to roughly the
//     requested ~40px/second), via walkTo()'s new `shouldStop` hook, which
//     cuts the walk short the moment she's within WHACK_STRIKE_DIST rather
//     than forcing her all the way to a fixed target. If she's already
//     within strike range when the dwell completes, this stage is skipped
//     entirely. Known simplification: the walk targets the cursor's
//     position at the moment the approach begins, not a continuously
//     re-aimed position -- if the cursor moves a lot mid-approach she
//     doesn't chase it, she may just end up not reaching strike range and
//     settle normally at the end of the walk.
//  2. STRIKE -- once close enough, she holds whack_02 for WHACK_WATCH_MS,
//     then loops the 03-04-05 swipe cycle for as long as the cursor stays
//     within WHACK_APPROACH_DIST (reused here as the disengage threshold --
//     comfortably looser than the WHACK_STRIKE_DIST that triggered this in
//     the first place, so it doesn't flicker in and out right at the
//     boundary). Checked once per beat, not continuously, so a strike beat
//     always finishes cleanly instead of freezing mid-swing.
//
// Only starts a fresh approach from a plain "sit" (not "walk") -- if she's
// already mid-walk from the normal idle loop when the dwell completes, this
// deliberately waits rather than starting a second, concurrent walkTo()
// call, which would race the in-flight one over state.x/frame. The moment
// she settles back to sit, the next poll picks it up immediately since the
// dwell condition is already satisfied.
// ============================================================

let whackActive = false;
let whackCooldownUntil = 0; // performance.now()-scale timestamp
let lastCursorPoint = { x: -9999, y: -9999 }; // latest raw point from window.ezra.onCursor
let approachDwellStart = null; // null while the cursor is outside WHACK_APPROACH_DIST, else the timestamp it entered

// PREREQUISITE FIX, discovered while building the first whack prototype:
// main.js's "cursor" broadcast is gated behind `lastSpriteBounds`, which is
// only ever populated by a renderer calling window.ezra.reportSpriteBounds()
// -- and this file never did, so the broadcast was silently dead. This
// mirrors the sibling Ezra App's own renderer.js reportBounds()/
// setInterval(..., 100) pattern exactly, and is additive -- it doesn't touch
// any existing behavior function. As a side effect this also revives
// main.js's click-through hit-testing (toggling ignoreMouseEvents over the
// sprite), which was equally dead for the same reason.
function reportSpriteBounds() {
  const rect = spriteEl.getBoundingClientRect();
  window.ezra.reportSpriteBounds({
    x: Math.round(rect.left + window.screenX),
    y: Math.round(rect.top + window.screenY),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  });
}

// Distance (px) from a screen point to her sprite's live screen bbox -- 0
// while the point is inside it, not just center-to-center.
function distanceToSprite(cursorX, cursorY) {
  const rect = spriteEl.getBoundingClientRect();
  const left = rect.left + window.screenX;
  const top = rect.top + window.screenY;
  const dx = Math.max(left - cursorX, 0, cursorX - (left + rect.width));
  const dy = Math.max(top - cursorY, 0, cursorY - (top + rect.height));
  return Math.hypot(dx, dy);
}

// Fed by window.ezra.onCursor (~30Hz from main.js) on every tick regardless
// of state -- just tracks the raw point and maintains the approach-dwell
// clock (an anchor timestamp that resets to null the instant the cursor
// leaves WHACK_APPROACH_DIST, so approachDwellMs() reflects "how long has it
// been continuously within range", not "time since it first arrived").
function onCursorMove(x, y) {
  lastCursorPoint = { x, y };
  const dist = distanceToSprite(x, y);
  if (dist > WHACK_APPROACH_DIST) {
    approachDwellStart = null;
  } else if (approachDwellStart === null) {
    approachDwellStart = performance.now();
  }
}

function approachDwellMs() {
  return approachDwellStart === null ? 0 : performance.now() - approachDwellStart;
}

// Stage 2: hold the watch pose, then loop the swipe cycle for as long as
// `shouldContinue()` says to. Always ends by settling back to sit.
//
// shouldContinue is a parameter (not hardcoded to the real distance check)
// specifically so manualWhackTest() can preview the beats without depending
// on where the real OS cursor happens to be -- an earlier version hardcoded
// the distance check here, which meant pressing the manual test button while
// your mouse was anywhere near the Remote window (i.e. always) played the
// watch pose and then silently settled with zero swipe beats, defeating the
// button's entire purpose. Caught by actually running it, not just reading
// the code.
async function runWhackStrike(shouldContinue) {
  setStateName("whack");
  setFrame(ASSETS.whack[1]); // whack_02: watching
  diag();
  await wait(WHACK_WATCH_MS);

  while (shouldContinue()) {
    for (const idx of [2, 3, 4]) {
      // whack_03 -> 04 -> 05: the "3-4-5" swipe cycle
      setFrame(ASSETS.whack[idx]);
      diag();
      await wait(rand(WHACK_BEAT_MS[0], WHACK_BEAT_MS[1]));
    }
  }
  settleToSit();
}

// Full sequence: approach (if needed) then strike. Sets whackActive for the
// duration so behaviourLoop stands down, and starts a cooldown afterward so
// a cursor sitting right at the boundary can't immediately re-trigger.
async function whackSequence() {
  whackActive = true;
  requestSkip(); // interrupt behaviourLoop's current interruptible gap so it notices whackActive promptly

  const alreadyClose = distanceToSprite(lastCursorPoint.x, lastCursorPoint.y) <= WHACK_STRIKE_DIST;
  if (!alreadyClose) {
    const cursorRelativeX = lastCursorPoint.x - window.screenX;
    const targetX = cursorRelativeX - SPRITE_WIDTH / 2; // aim to end up roughly centered under the cursor
    await walkTo(targetX, SAUNTER_FPS, () => distanceToSprite(lastCursorPoint.x, lastCursorPoint.y) <= WHACK_STRIKE_DIST);
  }

  if (distanceToSprite(lastCursorPoint.x, lastCursorPoint.y) <= WHACK_STRIKE_DIST) {
    await runWhackStrike(() => distanceToSprite(lastCursorPoint.x, lastCursorPoint.y) <= WHACK_APPROACH_DIST); // ends with settleToSit()
  } else {
    // Walked all the way to the target without ever getting close enough --
    // e.g. the cursor sits well above her ground line, vertical distance
    // alone keeps her out of strike range. Don't get stuck; just settle.
    settleToSit();
  }

  whackCooldownUntil = performance.now() + WHACK_COOLDOWN_MS;
  whackActive = false;
}

// Independent poll loop -- NOT started in boot() for V1mini (see the WHACK_V1
// note in boot() below). Cheap enough at a plain 150ms interval -- this only
// decides *when* to hand off to whackSequence(), it doesn't drive any
// animation itself.
async function whackLoop() {
  while (true) {
    await wait(150);
    if (whackActive || previewMode || manualOverrideName) continue;
    if (state.name !== "sit") continue;
    if (performance.now() < whackCooldownUntil) continue;
    if (approachDwellMs() < WHACK_APPROACH_DWELL_MS) continue;
    await whackSequence();
  }
}

// Manual Remote-panel test trigger: skips the approach/dwell entirely and
// runs the strike sequence in place. Your real mouse is almost certainly
// hovering the Remote window when you press this, nowhere near her actual
// on-screen sprite -- gating this on live cursor position would mean it
// could basically never fire, defeating its point as a preview/feel-testing
// tool. Still respects whackActive/state guards so it can't collide with a
// real in-progress sequence.
async function manualWhackTest() {
  if (whackActive) return;
  if (state.name !== "sit" && state.name !== "walk") return;
  whackActive = true;
  requestSkip();
  let loops = 0;
  await runWhackStrike(() => loops++ < 3); // fixed 3 rounds for a preview, independent of real cursor position
  whackActive = false;
}

// `sitBusy` is a lock shared between blinkLoop and behaviourLoop -- both loops
// can independently decide "do something" while she's sitting, and without
// this they could land in the same instant and stomp on each other's frames
// (e.g. blink() overwriting a frame mid-tailwag). Whichever loop starts an
// action first claims the lock via runGuarded(); the other checks it before
// starting anything of its own and just waits for the next tick if it's held.
let sitBusy = false;

async function runGuarded(fn) {
  sitBusy = true;
  try {
    await fn();
  } finally {
    sitBusy = false;
  }
}

// ---------- blink loop: independent, continuous ambient blinking. Runs on
// its own natural cadence (BLINK_GAP_MS) the entire time she's in plain "sit"
// -- not just on the rounds nothing else won -- so she reads as alive and
// paying attention rather than freezing between behaviors. Stands down
// whenever she's mid another behavior (state.name isn't "sit" then) or the
// other-behaviors loop has already claimed sitBusy. ----------
async function blinkLoop() {
  while (true) {
    await interruptibleWait(rand(BLINK_GAP_MS[0], BLINK_GAP_MS[1]));
    if (previewMode || manualOverrideName || whackActive || sitBusy) continue;
    if (state.name !== "sit") continue;
    await runGuarded(blink);
  }
}

async function behaviourLoop() {
  while (true) {
    if (previewMode) {
      await wait(150); // parked -- remote is holding a single pose frame steady
      continue;
    }
    // whackLoop has taken control (see whackSequence/manualWhackTest) --
    // stand down entirely until it's done, same pattern as previewMode.
    if (whackActive) {
      await wait(150);
      continue;
    }
    if (manualOverrideName) {
      if (sitBusy) {
        await wait(50); // let an in-flight blink finish first rather than colliding with it
        continue;
      }
      const forced = manualOverrideName;
      manualOverrideName = null;
      await runGuarded(() => runIdleAction(forced));
      continue;
    }
    await interruptibleWait(rand(ACTION_ROLL_GAP_MS[0], ACTION_ROLL_GAP_MS[1]));
    if (previewMode || manualOverrideName || whackActive || sitBusy) continue; // a remote command, the whack system, or a blink landed mid-gap -- let the relevant branch handle it next pass
    if (state.name !== "sit") continue; // only start a fresh action from neutral sit
    const action = pickIdleAction();
    if (action) await runGuarded(() => runIdleAction(action));
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
    case "whack":
      // Manual test trigger -- routed through manualWhackTest(), not through
      // the "behavior" case above, so it can never touch manualOverrideName /
      // runIdleAction()'s dispatch table. Fire-and-forget: handleRemoteCommand
      // itself is synchronous.
      manualWhackTest();
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
  // Whack system's real cursor-proximity tracking -- see onCursorMove().
  // main.js broadcasts live cursor position on this channel at ~30Hz, but
  // only once it has sprite bounds to hit-test against -- see
  // reportSpriteBounds()'s comment for why that call is here now. Cursor
  // tracking itself stays on (cheap, and reportSpriteBounds/click-through
  // hit-testing in main.js depends on it) -- only the automatic whackLoop
  // poll below is disabled for V1mini.
  window.ezra.onCursor(({ x, y }) => onCursorMove(x, y));
  setInterval(reportSpriteBounds, 100);

  behaviourLoop();
  blinkLoop();
  // WHACK_V1: whackLoop() intentionally not started -- the cursor-whack
  // behavior isn't part of V1mini yet (still being built/tuned). The rest of
  // the whack system (runWhackStrike, whackSequence, manualWhackTest, the
  // Remote panel's "Experimental" test button) stays wired up so it's easy
  // to pick back up later; only the automatic "she notices your cursor and
  // walks over" trigger is switched off. manualWhackTest() (fired from the
  // Remote panel) still works for dev preview since it doesn't depend on
  // this loop.
  // whackLoop();
}

boot();
