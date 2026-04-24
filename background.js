// ============================================================
// Meet Transcriber — Background Service Worker
// Manages session persistence
// ============================================================

function bgLog(step, details) {
  if (details === undefined) {
    console.log('[MeetTranscriber][background] ' + step);
    return;
  }
  console.log('[MeetTranscriber][background] ' + step, details);
}

function bgWarn(step, details) {
  if (details === undefined) {
    console.warn('[MeetTranscriber][background] ' + step);
    return;
  }
  console.warn('[MeetTranscriber][background] ' + step, details);
}

bgLog('service-worker-init');

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  bgLog('runtime.onMessage', {
    type: message && message.type ? message.type : 'unknown',
    senderTabId: sender && sender.tab ? sender.tab.id : null,
    senderUrl: sender && sender.url ? sender.url : null
  });

  if (message.type === 'OPEN_URL') {
    const url = typeof message.url === 'string' ? message.url : '';
    if (!url) {
      bgWarn('OPEN_URL:missing-url');
      sendResponse({ ok: false, error: 'missing_url' });
      return;
    }

    chrome.tabs.create({ url }, (tab) => {
      if (chrome.runtime.lastError) {
        bgWarn('OPEN_URL:tabs.create:lastError', chrome.runtime.lastError.message || 'unknown');
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      bgLog('OPEN_URL:tabs.create:ok', { tabId: tab && tab.id ? tab.id : null, url: url });
      sendResponse({ ok: true, tabId: tab && tab.id ? tab.id : null });
    });

    return true;
  }

  if (message.type === 'SAVE_SESSION') {
    const session = message.session;
    bgLog('SAVE_SESSION:start', {
      sessionId: session && session.id ? session.id : null,
      phraseCount: session && session.phraseCount ? session.phraseCount : 0,
      meetingCode: session && session.meetingCode ? session.meetingCode : null
    });
    
    chrome.storage.local.get(['sessions'], (res) => {
      if (chrome.runtime.lastError) {
        bgWarn('SAVE_SESSION:storage.get:lastError', chrome.runtime.lastError.message || 'unknown');
      }
      const sessions = res.sessions || [];
      
      // Check if this session already exists (by meetingCode + date)
      const existingIdx = sessions.findIndex(s => s.id === session.id);
      if (existingIdx >= 0) {
        sessions[existingIdx] = session;
        bgLog('SAVE_SESSION:update-existing', { index: existingIdx, sessionId: session.id });
      } else {
        sessions.unshift(session); // newest first
        bgLog('SAVE_SESSION:insert-new', { sessionId: session.id });
      }
      
      // Keep max 50 sessions
      if (sessions.length > 50) sessions.length = 50;
      
      chrome.storage.local.set({ sessions }, () => {
        if (chrome.runtime.lastError) {
          bgWarn('SAVE_SESSION:storage.set:lastError', chrome.runtime.lastError.message || 'unknown');
        }
        bgLog('SAVE_SESSION:done', { totalSessions: sessions.length, sessionId: session.id });
        sendResponse({ ok: true });
      });
    });
    
    return true; // async response
  }
  
  if (message.type === 'DELETE_SESSION') {
    bgLog('DELETE_SESSION:start', { sessionId: message.sessionId });
    chrome.storage.local.get(['sessions'], (res) => {
      if (chrome.runtime.lastError) {
        bgWarn('DELETE_SESSION:storage.get:lastError', chrome.runtime.lastError.message || 'unknown');
      }
      let sessions = res.sessions || [];
      sessions = sessions.filter(s => s.id !== message.sessionId);
      chrome.storage.local.set({ sessions }, () => {
        if (chrome.runtime.lastError) {
          bgWarn('DELETE_SESSION:storage.set:lastError', chrome.runtime.lastError.message || 'unknown');
        }
        bgLog('DELETE_SESSION:done', { remainingSessions: sessions.length, sessionId: message.sessionId });
        sendResponse({ ok: true });
      });
    });
    return true;
  }

  bgWarn('runtime.onMessage:unhandled-type', message && message.type ? message.type : 'unknown');
});
