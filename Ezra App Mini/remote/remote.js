// Ezra Remote -- a standalone control window for manually triggering
// behaviors and stepping through raw pose frames while testing new art,
// instead of waiting for the weighted random picker to get there.

const POSES = ["sit", "sitBlink", "idle", "walk", "stretch", "look"];

let manifest = null;
let currentPose = POSES[0];
let currentFrame = 0;

function frameCount(pose) {
  if (pose === "sitBlink") return 1;
  return manifest?.states?.[pose]?.frames ?? 1;
}

function status(msg) {
  document.getElementById("status").textContent = msg;
}

function sendPose() {
  window.remote.send({ kind: "pose", name: currentPose, frameIndex: currentFrame });
  document.getElementById("frameLabel").textContent = `frame ${currentFrame + 1} / ${frameCount(currentPose)}`;
  status(`Previewing: ${currentPose}[${currentFrame}]`);
}

const poseSelect = document.getElementById("poseSelect");
POSES.forEach((p) => {
  const opt = document.createElement("option");
  opt.value = p;
  opt.textContent = p;
  poseSelect.appendChild(opt);
});

poseSelect.addEventListener("change", () => {
  currentPose = poseSelect.value;
  currentFrame = 0;
  sendPose();
});

document.getElementById("prevFrame").addEventListener("click", () => {
  currentFrame = Math.max(0, currentFrame - 1);
  sendPose();
});

document.getElementById("nextFrame").addEventListener("click", () => {
  currentFrame = Math.min(frameCount(currentPose) - 1, currentFrame + 1);
  sendPose();
});

document.getElementById("behaviors").addEventListener("click", (e) => {
  const name = e.target?.dataset?.behavior;
  if (!name) return;
  window.remote.send({ kind: "behavior", name });
  status(`Triggered: ${name}`);
});

document.getElementById("skip").addEventListener("click", () => {
  window.remote.send({ kind: "skip" });
  status("Skipped / waking now");
});

document.getElementById("resumeAuto").addEventListener("click", () => {
  window.remote.send({ kind: "resume" });
  status("Resumed automatic behavior");
});

(async () => {
  const res = await fetch("../assets/ezra/manifest.json");
  manifest = await res.json();
  document.getElementById("frameLabel").textContent = `frame 1 / ${frameCount(currentPose)}`;
})();
