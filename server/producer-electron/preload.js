const { contextBridge, ipcRenderer } = require("electron");

const marker = "--luma-config=";
const arg = process.argv.find((a) => a.startsWith(marker));
const config = arg ? JSON.parse(arg.slice(marker.length)) : undefined;

contextBridge.exposeInMainWorld("lumaProducer", {
  config,
  reportStatus: (status) => ipcRenderer.send("producer-status", status),
  startGdiRelay: (monitorIndex) => ipcRenderer.invoke("start-gdi-relay", { monitorIndex }),
  onGdiFrame: (callback) => ipcRenderer.on("gdi-frame", (_event, buffer) => callback(buffer)),
});
