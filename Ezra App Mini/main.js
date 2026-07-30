const { app, BrowserWindow, Tray, Menu, screen, ipcMain } = require("electron");
const path = require("path");

let win = null;
let tray = null;
let remoteWin = null;
let lastSpriteBounds = null; // {x, y, width, height} in screen coordinates
let lastIgnoring = true;

function createWindow() {
  // Use the work area (screen minus taskbar), not the full display bounds.
  // With .bounds the window spans behind the taskbar and her ground line
  // sits above it with a gap; .workArea stops exactly at the taskbar's top
  // edge, so a small/zero ground offset puts her right on top of it.
  const { x, y, width, height } = screen.getPrimaryDisplay().workArea;

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

function createTray() {
  tray = new Tray(path.join(__dirname, "assets", "tray-icon-32.png"));
  tray.setToolTip("Ezra");

  const menu = Menu.buildFromTemplate([
    {
      label: "Show Ezra",
      type: "checkbox",
      checked: true,
      click: (item) => {
        if (item.checked) win.show();
        else win.hide();
      },
    },
    { type: "separator" },
    { label: "Feed", click: () => win.webContents.send("trigger", "feed") },
    { label: "Catnip", click: () => win.webContents.send("trigger", "catnip") },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]);

  tray.setContextMenu(menu);
  tray.on("click", () => win.webContents.send("trigger", "toggle-show"));
}

ipcMain.on("sprite-bounds", (_event, bounds) => {
  lastSpriteBounds = bounds;
});

// Relay remote-window commands straight through to Ezra's renderer on the
// existing "trigger" channel -- same channel the tray's Feed/Catnip items
// already send bare strings on, engine.js just ignores anything that isn't
// one of the object-shaped commands the remote sends.
ipcMain.on("remote-command", (_event, payload) => {
  if (win) win.webContents.send("trigger", payload);
});

app.whenReady().then(() => {
  createWindow();
  createTray();
  createRemoteWindow();
});

app.on("window-all-closed", () => {
  app.quit();
});
