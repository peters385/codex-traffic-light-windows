const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("codexTrafficLight", {
  onStateChange(callback) {
    const handler = (_, state) => callback(state);
    ipcRenderer.on("state-change", handler);
    return () => ipcRenderer.removeListener("state-change", handler);
  },
  onPreferencesChange(callback) {
    const handler = (_, preferences) => callback(preferences);
    ipcRenderer.on("preferences-change", handler);
    return () => ipcRenderer.removeListener("preferences-change", handler);
  },
  getState: () => ipcRenderer.invoke("get-state"),
  setState: (state) => ipcRenderer.send("set-state", state),
  getPreferences: () => ipcRenderer.invoke("get-preferences"),
  setPreferences: (preferences) => ipcRenderer.send("set-preferences", preferences),
  installHooks: () => ipcRenderer.invoke("install-hooks"),
  getPaths: () => ipcRenderer.invoke("get-paths"),
  quit: () => ipcRenderer.send("quit"),
});
