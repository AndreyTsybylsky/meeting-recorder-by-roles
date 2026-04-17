// ============================================================
// Meet Transcriber — Background Service Worker
// Manages session persistence
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'OPEN_URL') {
    const url = typeof message.url === 'string' ? message.url : '';
    if (!url) {
      sendResponse({ ok: false, error: 'missing_url' });
      return;
    }

    chrome.tabs.create({ url }, (tab) => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      sendResponse({ ok: true, tabId: tab && tab.id ? tab.id : null });
    });

    return true;
  }

  if (message.type === 'SAVE_SESSION') {
    const session = message.session;
    
    chrome.storage.local.get(['sessions'], (res) => {
      const sessions = res.sessions || [];
      
      // Check if this session already exists (by meetingCode + date)
      const existingIdx = sessions.findIndex(s => s.id === session.id);
      if (existingIdx >= 0) {
        sessions[existingIdx] = session;
      } else {
        sessions.unshift(session); // newest first
      }
      
      // Keep max 50 sessions
      if (sessions.length > 50) sessions.length = 50;
      
      chrome.storage.local.set({ sessions }, () => {
        sendResponse({ ok: true });
      });
    });
    
    return true; // async response
  }
  
  if (message.type === 'DELETE_SESSION') {
    chrome.storage.local.get(['sessions'], (res) => {
      let sessions = res.sessions || [];
      sessions = sessions.filter(s => s.id !== message.sessionId);
      chrome.storage.local.set({ sessions }, () => {
        sendResponse({ ok: true });
      });
    });
    return true;
  }
});
