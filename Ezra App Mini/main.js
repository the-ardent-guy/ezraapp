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

// Work area (screen minus taskbar), not the full display bounds -- with
// .bounds the window spans behind the taskbar and her ground line sits above
// it with a gap; .workArea stops exactly at the taskbar's top edge, so a
// small/zero ground offset puts her right on top of it. Re-read and reapplied
// on every display change, not just at launch, so unplugging a monitor or
// changing resolution/scaling doesn't strand her off the visible screen.
function currentWorkArea() {
  return screen.getPrimaryDisplay().workArea;
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
  setInterval(() => {
    if (!lastSpriteBounds) return;
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
ipcMain.on("remote-command", (_event, payload) => {
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
