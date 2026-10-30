const { contextBridge, ipcRenderer, webUtils } = require('electron');
const invoke = channel => (...args) => ipcRenderer.invoke(channel, ...args);
contextBridge.exposeInMainWorld('wetmytt', {
  updateState: invoke('updates:state'), checkForUpdates: invoke('updates:check'), restartToUpdate: invoke('updates:restart'),
  connectCodex: invoke('mcp:connect-codex'),
  connectClaude: invoke('mcp:connect-claude'),
  exportPDF: invoke('deck:export-pdf'),
  recentFolders: invoke('recent:list'), openRecent: invoke('recent:open'),
  removeRecent: invoke('recent:remove'), clearRecent: invoke('recent:clear'),
  state: invoke('deck:state'), open: invoke('deck:open'), create: invoke('deck:create'), close: invoke('deck:close'),
  thumbnails: invoke('deck:thumbnails'),
  readSlideManagement: invoke('deck:read-slide-management'), mutateSlide: invoke('deck:mutate-slide'),
  readContent: invoke('deck:read-content'), saveContent: invoke('deck:save-content'),
  projectFiles: invoke('deck:files'), gitAction: invoke('deck:git-action'),
  gitSummary: invoke('deck:git-summary'), gitHistory: invoke('deck:history'),
  restoreLastSave: invoke('deck:restore-last-save'),
  reveal: invoke('deck:reveal'), settings: invoke('ai:settings'), saveSettings: invoke('ai:save'), savePreferences: invoke('ai:preferences'),
  chat: invoke('ai:chat'), cancel: invoke('ai:cancel'), context: invoke('ai:context'), present: invoke('deck:present'),
  chats: invoke('ai:chats'), loadChat: invoke('ai:load-chat'),
  importAssets: (root, files) => ipcRenderer.invoke('deck:import-assets', root, files.map(file => webUtils.getPathForFile(file))),
  chooseAssets: invoke('deck:choose-assets'),
  on: (name, callback) => {
    if (!['deck:changed', 'ai:conversation', 'ai:progress', 'deck:fullscreen', 'recent:changed', 'recent:error', 'updates:changed'].includes(name)) return () => {};
    const listener = (_event, value) => callback(value);
    ipcRenderer.on(name, listener);
    return () => ipcRenderer.removeListener(name, listener);
  },
});
