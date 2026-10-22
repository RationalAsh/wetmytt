const { contextBridge, ipcRenderer } = require('electron');
const invoke = channel => (...args) => ipcRenderer.invoke(channel, ...args);
contextBridge.exposeInMainWorld('decklet', {
  state: invoke('deck:state'), open: invoke('deck:open'), create: invoke('deck:create'),
  reveal: invoke('deck:reveal'), settings: invoke('ai:settings'), saveSettings: invoke('ai:save'),
  chat: invoke('ai:chat'), cancel: invoke('ai:cancel'), present: invoke('deck:present'),
  on: (name, callback) => {
    if (!['deck:changed', 'ai:activity', 'deck:fullscreen'].includes(name)) return () => {};
    const listener = (_event, value) => callback(value);
    ipcRenderer.on(name, listener);
    return () => ipcRenderer.removeListener(name, listener);
  },
});
