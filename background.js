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

const DEFAULT_WHISPER_ENDPOINT = 'http://127.0.0.1:8765/transcribe';

function updateWhisperBackendState(nextState, callback) {
  chrome.storage.local.set(nextState, () => {
    if (chrome.runtime.lastError) {
      bgWarn('WHISPER_BACKEND:storage.set:lastError', chrome.runtime.lastError.message || 'unknown');
    }
    if (typeof callback === 'function') callback();
  });
}

function deriveWhisperHealthUrl(endpoint) {
  const rawEndpoint = typeof endpoint === 'string' && endpoint.trim()
    ? endpoint.trim()
    : DEFAULT_WHISPER_ENDPOINT;

  try {
    const url = new URL(rawEndpoint);
    if (url.pathname.endsWith('/transcribe')) {
      url.pathname = url.pathname.slice(0, -'/transcribe'.length) + '/health';
    } else if (url.pathname === '/' || url.pathname === '') {
      url.pathname = '/health';
    } else if (!url.pathname.endsWith('/health')) {
      url.pathname = url.pathname.replace(/\/+$/, '') + '/health';
    }
    url.search = '';
    return url.toString();
  } catch (_error) {
    return 'http://127.0.0.1:8765/health';
  }
}

function checkWhisperBackendHealth(sendResponse) {
  chrome.storage.local.get(['whisperEndpoint'], async (res) => {
    const whisperEndpoint = typeof res.whisperEndpoint === 'string' && res.whisperEndpoint.trim()
      ? res.whisperEndpoint.trim()
      : DEFAULT_WHISPER_ENDPOINT;
    const healthUrl = deriveWhisperHealthUrl(whisperEndpoint);
    const checkedAt = Date.now();

    updateWhisperBackendState({
      whisperBackendStatus: 'checking',
      whisperBackendLastError: '',
      whisperBackendLastCheckedAt: checkedAt,
      whisperBackendHealthUrl: healthUrl
    });

    try {
      const resp = await fetch(healthUrl, {
        method: 'GET',
        cache: 'no-store'
      });

      if (!resp.ok) {
        const error = 'http_' + String(resp.status);
        updateWhisperBackendState({
          whisperBackendStatus: 'error',
          whisperBackendLastError: error,
          whisperBackendLastCheckedAt: checkedAt,
          whisperBackendHealthUrl: healthUrl
        }, () => {
          sendResponse({ ok: false, status: 'error', error, endpoint: whisperEndpoint, healthUrl });
        });
        return;
      }

      const payload = await resp.json().catch(() => ({}));
      const rawStatus = payload && typeof payload.status === 'string' ? payload.status : 'ready';
      const status = ['ready', 'error', 'installing'].includes(rawStatus) ? rawStatus : 'ready';
      const storageStatus = status === 'installing' ? 'unavailable' : status;
      const error = status === 'error' && payload && typeof payload.error === 'string'
        ? payload.error
        : '';

      updateWhisperBackendState({
        whisperBackendStatus: storageStatus,
        whisperBackendLastError: error,
        whisperBackendLastCheckedAt: checkedAt,
        whisperBackendHealthUrl: healthUrl
      }, () => {
        sendResponse({
          ok: status === 'ready',
          status: storageStatus,
          reportedStatus: status,
          error,
          endpoint: whisperEndpoint,
          healthUrl,
          payload
        });
      });
    } catch (error) {
      const message = error && error.message ? error.message : 'unreachable';
      updateWhisperBackendState({
        whisperBackendStatus: 'unavailable',
        whisperBackendLastError: message,
        whisperBackendLastCheckedAt: checkedAt,
        whisperBackendHealthUrl: healthUrl
      }, () => {
        sendResponse({ ok: false, status: 'unavailable', error: message, endpoint: whisperEndpoint, healthUrl });
      });
    }
  });
}

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

  if (message.type === 'CHECK_WHISPER_BACKEND') {
    checkWhisperBackendHealth(sendResponse);
    return true;
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
