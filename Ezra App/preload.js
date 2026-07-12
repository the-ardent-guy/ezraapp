const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ezra", {
  onTrigger: (callback) => ipcRenderer.on("trigger", (_event, name) => callback(name)),
  onCursor: (callback) => ipcRenderer.on("cursor", (_event, point) => callback(point)),
  reportSpriteBounds: (bounds) => ipcRenderer.send("sprite-bounds", bounds),
});
