const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("trainMenu", {
  getState: () => ipcRenderer.invoke("state:get"),
  // Station names for the setup picker. Bundled with the app, so the picker works
  // before the user has entered a key.
  getStations: () => ipcRenderer.invoke("stations:list"),
  save: (config) => ipcRenderer.invoke("config:save", config),
  refresh: () => ipcRenderer.send("data:refresh"),
  quit: () => ipcRenderer.send("app:quit"),
  resize: (height) => ipcRenderer.send("ui:resize", height),
  onState: (callback) => ipcRenderer.on("state", (_event, state) => callback(state)),
});
