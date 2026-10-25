const { contextBridge, ipcRenderer, webUtils } = require('electron');
const invoke = channel => (...args) => ipcRenderer.invoke(channel, ...args);
contextBridge.exposeInMainWorld('wetmytt', {
  connectCodex: invoke('mcp:connect-codex'),
  connectClaude: invoke('mcp:connect-claude'),
  exportPDF: invoke('deck:export-pdf'),
  state: invoke('deck:state'), open: invoke('deck:open'), create: invoke('deck:create'), close: invoke('deck:close'),
  readContent: invoke('deck:read-content'), saveContent: invoke('deck:save-content'),
  reveal: invoke('deck:reveal'), settings: invoke('ai:settings'), saveSettings: invoke('ai:save'),
  chat: invoke('ai:chat'), cancel: invoke('ai:cancel'), present: invoke('deck:present'),
  chats: invoke('ai:chats'), loadChat: invoke('ai:load-chat'),
  importAssets: (root, files) => ipcRenderer.invoke('deck:import-assets', root, files.map(file => webUtils.getPathForFile(file))),
  chooseAssets: invoke('deck:choose-assets'),
  on: (name, callback) => {
    if (!['deck:changed', 'ai:activity', 'deck:fullscreen'].includes(name)) return () => {};
    const listener = (_event, value) => callback(value);
    ipcRenderer.on(name, listener);
    return () => ipcRenderer.removeListener(name, listener);
  },
});
