const { contextBridge, ipcRenderer, webUtils } = require('electron');
const invoke = channel => (...args) => ipcRenderer.invoke(channel, ...args);
contextBridge.exposeInMainWorld('wetmytt', {
  state: invoke('deck:state'), open: invoke('deck:open'), create: invoke('deck:create'), close: invoke('deck:close'),
  reveal: invoke('deck:reveal'), settings: invoke('ai:settings'), saveSettings: invoke('ai:save'),
  chat: invoke('ai:chat'), cancel: invoke('ai:cancel'), present: invoke('deck:present'),
  importAssets: (root, files) => ipcRenderer.invoke('deck:import-assets', root, files.map(file => webUtils.getPathForFile(file))),
  on: (name, callback) => {
    if (!['deck:changed', 'ai:activity', 'deck:fullscreen'].includes(name)) return () => {};
    const listener = (_event, value) => callback(value);
    ipcRenderer.on(name, listener);
    return () => ipcRenderer.removeListener(name, listener);
  },
});
