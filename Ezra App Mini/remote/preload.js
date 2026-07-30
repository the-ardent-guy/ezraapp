const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("remote", {
  send: (cmd) => ipcRenderer.send("remote-command", cmd),
});
