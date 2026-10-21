const { contextBridge, ipcRenderer } = require('electron');

const sessionPattern = /^[A-Za-z0-9_-]{1,80}$/;
const listeners = new Set();

ipcRenderer.on('mingle.browser.popout.closed', (_event, sessionId) => {
  if (typeof sessionId !== 'string' || !sessionPattern.test(sessionId)) return;
  for (const listener of listeners) listener(sessionId);
});

contextBridge.exposeInMainWorld('mingleBrowserDesktop', Object.freeze({
  openPopout: (sessionId) => sessionPattern.test(sessionId) ? ipcRenderer.invoke('mingle.browser.open-popout', sessionId) : Promise.resolve(false),
  isPopoutOpen: (sessionId) => sessionPattern.test(sessionId) ? ipcRenderer.invoke('mingle.browser.is-popout-open', sessionId) : Promise.resolve(false),
  focusPopout: (sessionId) => sessionPattern.test(sessionId) ? ipcRenderer.invoke('mingle.browser.focus-popout', sessionId) : Promise.resolve(false),
  dockPopout: (sessionId) => sessionId === undefined || sessionPattern.test(sessionId)
    ? ipcRenderer.invoke('mingle.browser.dock-popout', sessionId)
    : Promise.resolve(false),
  onPopoutClosed: (listener) => {
    if (typeof listener !== 'function') return () => undefined;
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
}));
