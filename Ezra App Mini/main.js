const { app, BrowserWindow, Tray, Menu, screen, ipcMain, session } = require("electron");
const path = require("path");
const { autoUpdater } = require("electron-updater");

const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // she can stay open for days, so re-check periodically, not just at launch

let win = null;
let tray = null;
let remoteWin = null;
let showMenuItem = null;
let lastSpriteBounds = null; // {x, y, width, height} in screen coordinates
let lastIgnoring = true;
let wasShownBeforeHide = true; // preserves show/hide state across a display-change reposition

// Windows: work area (screen minus taskbar), not the full display bounds --
// with .bounds the window spans behind the taskbar and her ground line sits
// above it with a gap; .workArea stops exactly at the taskbar's top edge, so
// a small/zero ground offset puts her right on top of it.
//
// macOS: deliberately the opposite -- .workArea there excludes the Dock too
// (same mechanism as the taskbar), which would float her above the Dock
// instead of sitting at the true bottom of the screen. There's no taskbar
// equivalent to dock the ground line against on Mac, so we use the full
// .bounds instead and let her sit at the literal bottom edge regardless of
// whether the Dock is visible. Known/accepted tradeoff: the window is
// alwaysOnTop at "screen-saver" level (see createWindow), which is above the
// Dock's own level, so if her window region overlaps a visible, non-auto-hidden
// Dock, she'll draw on top of it rather than tucking behind -- left as-is for
// now, not treated as a bug.
//
// Re-read and reapplied on every display change, not just at launch, so
// unplugging a monitor or changing resolution/scaling doesn't strand her off
// the visible screen.
function currentWorkArea() {
  const display = screen.getPrimaryDisplay();
  return process.platform === "darwin" ? display.bounds : display.workArea;
}

function repositionWindow() {
  if (!win) return;
  const { x, y, width, height } = currentWorkArea();
  win.setBounds({ x, y, width, height });
}

function createWindow() {
  const { x, y, width, height } = currentWorkArea();

  win = new BrowserWindow({
    x,
    y,
    width,
    height,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setAlwaysOnTop(true, "screen-saver");
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.show();

  win.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
  });
  win.webContents.on("did-fail-load", (_event, code, desc, url) => {
    console.error("[did-fail-load]", code, desc, url);
  });

  // Click-through everywhere except over the sprite's current bounds.
  // Electron's ignore-mouse-events is all-or-nothing per window, so we poll the
  // cursor position and toggle it based on whether the cursor sits inside the
  // sprite's last-reported bounding box.
  //
  // BUG FIXED HERE: this interval was never cleared when the window closed
  // (via the "Exit Ezra" Remote button, or any other close path), so once
  // `win` was destroyed it kept firing every 33ms and throwing "Object has
  // been destroyed" on win.webContents.send() -- and since nothing stopped
  // the interval, it threw again 33ms later, and again, producing an
  // uncaught-exception dialog that reappeared the instant you dismissed it.
  // isDestroyed() guard is the actual fix; clearInterval on "closed" is
  // there too so the timer doesn't keep spinning in the background forever
  // after the window's gone.
  const clickThroughInterval = setInterval(() => {
    if (!win || win.isDestroyed() || !lastSpriteBounds) return;
    const p = screen.getCursorScreenPoint();
    win.webContents.send("cursor", p);

    const inside =
      p.x >= lastSpriteBounds.x &&
      p.x <= lastSpriteBounds.x + lastSpriteBounds.width &&
      p.y >= lastSpriteBounds.y &&
      p.y <= lastSpriteBounds.y + lastSpriteBounds.height;

    const shouldIgnore = !inside;
    if (shouldIgnore !== lastIgnoring) {
      lastIgnoring = shouldIgnore;
      win.setIgnoreMouseEvents(shouldIgnore, { forward: true });
    }
  }, 33); // ~30Hz
  // `win` is a shared module-level reference read by every other function in
  // this file (repositionWindow, setShown, the remote-command relay) via a
  // plain `if (win)`/`if (!win) return` guard -- none of those actually
  // protected anything, because the variable was never set back to null when
  // the window closed, so it stayed a truthy (but destroyed) reference
  // forever. Nulling it here is what makes every one of those existing
  // guards throughout the file actually correct, not just this interval.
  win.on("closed", () => {
    clearInterval(clickThroughInterval);
    win = null;
  });

  // Monitor unplugged/replugged, resolution changed, DPI/scaling changed --
  // recompute her corner against whatever the screen looks like now.
  screen.on("display-added", repositionWindow);
  screen.on("display-removed", repositionWindow);
  screen.on("display-metrics-changed", repositionWindow);
}

// Testing/dev tool: a small normal (non-transparent) window with buttons
// that let you fire a specific behavior or freeze her on one raw pose
// frame, instead of waiting for the weighted random picker.
function createRemoteWindow() {
  remoteWin = new BrowserWindow({
    width: 340,
    height: 460,
    title: "Ezra Remote",
    resizable: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, "remote", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  remoteWin.setMenuBarVisibility(false);
  remoteWin.loadFile(path.join(__dirname, "remote", "index.html"));
}

// Shared by the tray icon's own click and the "Show Ezra" checkbox, so
// clicking the icon directly stays in sync with the checkbox's state instead
// of drifting (Electron doesn't auto-sync a checkbox item to window state).
function setShown(shown) {
  if (!win) return;
  if (shown) win.show();
  else win.hide();
  wasShownBeforeHide = shown;
  if (showMenuItem) showMenuItem.checked = shown;
}

function createTray() {
  tray = new Tray(path.join(__dirname, "assets", "tray-icon-32.png"));
  tray.setToolTip("Ezra");

  const menu = Menu.buildFromTemplate([
    {
      label: "Show Ezra",
      type: "checkbox",
      checked: true,
      click: (item) => setShown(item.checked),
    },
    {
      label: "Start with Windows",
      type: "checkbox",
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]);

  showMenuItem = menu.items[0];
  tray.setContextMenu(menu);
  tray.on("click", () => setShown(!wasShownBeforeHide));
}

ipcMain.on("sprite-bounds", (_event, bounds) => {
  lastSpriteBounds = bounds;
});

// Relay remote-window commands straight through to Ezra's renderer on the
// "trigger" channel. Harmless to leave registered in packaged builds even
// though createRemoteWindow() never runs there -- nothing will ever send on
// this channel without the remote window existing to send it.
//
// "hide"/"show"/"quit" are handled here instead, not relayed -- they're
// main-process window/app actions (show/hide the transparent overlay, quit
// the whole app), not renderer behaviors, so the renderer has no authority
// to carry them out itself.
ipcMain.on("remote-command", (_event, payload) => {
  if (payload && payload.kind === "hide") return setShown(false);
  if (payload && payload.kind === "show") return setShown(true);
  if (payload && payload.kind === "quit") return app.quit();
  if (win) win.webContents.send("trigger", payload);
});

app.whenReady().then(async () => {
  // Sprite art gets hand-edited on disk during development (re-imports, realignment
  // passes) while filenames stay the same -- clear the disk cache first so a re-edited
  // sleep_04.png etc. can never be served stale from a prior run.
  await session.defaultSession.clearCache();
  createWindow();
  createTray();
  // Art-review/testing tool only -- never open it in a packaged (installed)
  // build. app.isPackaged is false under `npm start`/`electron .` and true
  // once electron-builder has packaged the app, so this needs no separate flag.
  if (!app.isPackaged) createRemoteWindow();

  // Auto-update only makes sense for an installed build (dev mode has no
  // app-update.yml for electron-updater to read, and would just error).
  // checkForUpdatesAndNotify() downloads silently in the background and shows
  // a native OS notification once ready; the update installs on next quit --
  // no custom UI needed for a background pet app like this.
  if (app.isPackaged) {
    autoUpdater.checkForUpdatesAndNotify().catch((err) => console.error("[autoUpdater]", err));
    setInterval(() => {
      autoUpdater.checkForUpdatesAndNotify().catch((err) => console.error("[autoUpdater]", err));
    }, UPDATE_CHECK_INTERVAL_MS);
  }
});

app.on("window-all-closed", () => {
  app.quit();
});
