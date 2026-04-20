// ============================================================
// Meet Transcriber — Content Script
// Captures meeting captions (Google Meet + Microsoft Teams + Zoom)
// ============================================================

const PLATFORM = detectPlatform();

const CAPTION_SELECTORS = {
  meet: {
    container: 'div[jsname="W297wb"], .iY996, .V006ub, .nS7Zeb, .nMcdL, [jsname="YSZ4cc"]',
    block: 'div[jsname="W297wb"], .iY996, .V006ub, .nS7Zeb',
    name: '.KcIKyf, .adE6rb, .NWpY1d, [jsname="IT69ne"]',
    text: '.nMcdL, .ygicle, [jsname="YSZ4cc"], [jsname="Vpvi7b"]'
  },
  teams: {
    container: '[data-tid="closed-captions-v2-items-renderer"], [data-tid="closed-caption-text"], [data-tid="author"], [data-tid="closed-caption-renderer-wrapper"]',
    block: '[data-tid="closed-captions-v2-items-renderer"], .fui-ChatMessageCompact',
    name: '[data-tid="author"], .fui-ChatMessageCompact__author, [data-tid*="caption-speaker" i]',
    text: '[data-tid="closed-caption-text"], [data-tid*="caption-text" i], .fui-ChatMessageCompact__body'
  },
  zoom: {
    container: '#live-transcription-subtitle, .live-transcription-subtitle__box, .live-transcription-subtitle__item, [aria-live="polite"], [aria-live="assertive"], [data-testid*="caption" i], [data-testid*="transcript" i], [class*="caption" i], [class*="transcript" i]',
    block: '#live-transcription-subtitle, .live-transcription-subtitle__box, .live-transcription-subtitle__item, [data-testid*="caption-message" i], [data-testid*="transcript-message" i], [class*="caption-message" i], [class*="transcript-message" i], [class*="caption-item" i], [class*="transcript-item" i]',
    name: '[data-testid*="speaker" i], .speaker-active-container__wrap, [class*="speaker" i], [class*="name" i]',
    text: '.live-transcription-subtitle__item, #live-transcription-subtitle, [data-testid*="caption-text" i], [data-testid*="transcript-text" i], [class*="caption-text" i], [class*="transcript-text" i], [class*="subtitle" i], [class*="caption-line" i], [class*="caption-content" i]'
  }
};

function detectPlatform() {
  const host = window.location.hostname;
  if (host.includes('meet.google.com')) return 'meet';
  if (host.includes('teams.microsoft.com') || host.includes('teams.live.com')) return 'teams';
  if (host.includes('zoom.us')) return 'zoom';
  return 'unknown';
}

function getCaptionConfig() {
  return CAPTION_SELECTORS[PLATFORM] || CAPTION_SELECTORS.meet;
}
let widgetHost = null;

function shouldShowWidget() {
  if (PLATFORM === 'meet') {
    return true;
  }

  if (PLATFORM === 'teams') {
    // On Mac / new Teams the meeting URL lives in the hash fragment (#/l/meetup-join/…),
    // so we must check both pathname and hash.
    const path = (window.location.pathname || '').toLowerCase();
    const hash = (window.location.hash || '').toLowerCase();
    const fullPath = path + hash;
    const looksLikeMeetingPath =
      /\/meet\//.test(fullPath) ||
      /\/meetup-join\//.test(fullPath) ||
      /\/l\/meetup-join\//.test(fullPath) ||
      /\/pre-join\//.test(fullPath) ||
      /\/meeting\//.test(fullPath);
    const hasCallControls = !!document.querySelector(
      '[data-tid*="hangup" i], [data-tid*="microphone" i], [data-tid*="camera" i], [data-tid*="share" i], button[aria-label*="Leave" i], button[aria-label*="Покинуть" i], button[aria-label*="Hang up" i], button[aria-label*="Mute" i], button[aria-label*="Unmute" i]'
    );
    const hasMeetingSurface = !!document.querySelector(
      '[data-tid*="meeting-stage" i], [data-tid*="calling" i], [data-tid="closed-caption-renderer-wrapper"], [data-tid="closed-captions-v2-items-renderer"], [data-tid*="video-gallery" i], [data-tid*="roster" i]'
    );

    // Show the widget if the path matches OR if Teams call UI elements are present.
    // On Mac/new Teams, hash-routing can make path detection unreliable,
    // so DOM-based detection alone is sufficient.
    return looksLikeMeetingPath || hasCallControls || hasMeetingSurface;
  }

  if (PLATFORM === 'zoom') {
    const path = (window.location.pathname || '').toLowerCase();
    const looksLikeMeetingPath = /\/wc\//.test(path) || /\/j\//.test(path) || /\/w\//.test(path) || /\/meeting\//.test(path) || /\/start\//.test(path) || /\/join\//.test(path);
    const hasCallControls = !!document.querySelector(
      'button[aria-label*="Leave" i], button[aria-label*="Leave Meeting" i], button[aria-label*="End" i], button[aria-label*="End Meeting" i], button[aria-label*="Mute" i], button[aria-label*="Unmute" i], button[aria-label*="mute my microphone" i], button[aria-label*="Start Video" i], button[aria-label*="Stop Video" i], button[aria-label*="start my video" i], [data-testid*="leave" i], [data-testid*="mute" i], [data-testid*="video" i]'
    );
    const hasMeetingSurface = !!document.querySelector(
      '[class*="meeting-client" i], [class*="meeting-app" i], [class*="in-meeting" i], [class*="video-layout" i], [data-testid*="video" i], [data-testid*="meeting" i]'
    );

    return looksLikeMeetingPath && (hasCallControls || hasMeetingSurface);
  }

  return false;
}

function ensureWidgetState() {
  if (shouldShowWidget()) {
    if (!widgetHost || !document.body.contains(widgetHost)) {
      injectWidget();
    }
    return;
  }

  destroyWidget();
}

function destroyWidget() {
  if (widgetHost && widgetHost.parentNode) {
    widgetHost.parentNode.removeChild(widgetHost);
  }
  widgetHost = null;
  delete window.__meetTranscriberRefreshUI;
}

let isRecording = false;
let transcript = []; // Array of { id: string, name: string, text: string }
let currentSessionId = null;
let storageStateInitialized = false;
let storageStateTouchedLocally = false;

// Extract meeting code from URL
function getMeetingCode() {
  if (PLATFORM === 'meet') {
    const match = window.location.pathname.match(/\/([a-z]{3}-[a-z]{4}-[a-z]{3})/);
    return match ? match[1] : 'unknown';
  }

  if (PLATFORM === 'teams') {
    const path = (window.location.pathname || '') + (window.location.hash || '');
    const match = path.match(/\/meetup-join\/([^\/&#]+)/i) || path.match(/\/l\/meetup-join\/([^\/&#]+)/i) || path.match(/\/meet\/([^\/&#]+)/i);
    return match ? match[1] : 'teams-session';
  }

  if (PLATFORM === 'zoom') {
    const path = window.location.pathname || '';
    const match = path.match(/\/wc\/([^\/]+)/i) || path.match(/\/j\/([^\/]+)/i) || path.match(/\/w\/([^\/]+)/i);
    return match ? match[1] : 'zoom-session';
  }

  return 'unknown';
}

let memoizedMeetingTitle = null;
let memoizedUserName = null;

function cleanTitle(str) {
  if (!str) return str;
  // Remove UI boilerplate
  const junk = [
    /meeting_room/g,
    /Присоединиться к звонку могут все желающие/g,
    /Everyone can join/g,
    /Join by phone/g,
    /More phone numbers/g,
    /\[.*?\]/g // Remove things in square brackets
  ];
  let cleaned = str.split('\n')[0]; // Take only first line
  junk.forEach(pattern => {
    cleaned = cleaned.replace(pattern, '');
  });
  // Remove duplicate repeating words (e.g., TelenentTelenent -> Telenent)
  cleaned = cleaned.replace(/(\b\w+\b)(?:\s+\1\b)+/g, "$1");
  // A simple hack for the TelenentTelenent case specifically if regex fails
  if (cleaned.startsWith('TelenentTelenent')) cleaned = cleaned.replace('TelenentTelenent', 'Telenet');
  
  return cleaned.replace(/\s+/g, ' ').trim();
}

function getMeetingTitle() {
  if (memoizedMeetingTitle) return memoizedMeetingTitle;

  if (PLATFORM === 'teams') {
    const teamsTitle = getTeamsMeetingTitle();
    if (teamsTitle) {
      memoizedMeetingTitle = teamsTitle;
      return teamsTitle;
    }
  }

  if (PLATFORM === 'zoom') {
    const zoomTitle = getZoomMeetingTitle();
    if (zoomTitle) {
      memoizedMeetingTitle = zoomTitle;
      return zoomTitle;
    }
  }

  // 1. Try to get title from the page DOM (bottom left corner)
  const titleEl = document.querySelector('[data-meeting-title]') 
    || document.querySelector('.u6vdEc')
    || document.querySelector('.J87Pc')
    || document.querySelector('[data-call-id]');
  
  let title = titleEl ? cleanTitle(titleEl.textContent) : null;

  // 2. Try to get title from document.title (usually "Meet - Title")
  if (!title || title === getMeetingCode() || title.length < 3) {
    const docTitle = document.title;
    if (docTitle && docTitle.startsWith('Meet - ')) {
      title = cleanTitle(docTitle.replace('Meet - ', ''));
    }
  }

  // If we found a "real" title (not just code or generic "Google Meet"), memoize it
  if (title && title !== 'Google Meet' && title !== getMeetingCode() && !title.includes('meet.google.com')) {
    memoizedMeetingTitle = title;
    return title;
  }

  return title || getMeetingCode();
}

function getTeamsMeetingTitle() {
  const titleCandidates = [
    document.querySelector('[data-tid="meeting-title"]'),
    document.querySelector('[data-tid*="meeting-title" i]'),
    document.querySelector('[data-tid*="call-title" i]'),
    document.querySelector('[class*="meeting-title" i]')
  ];

  for (const el of titleCandidates) {
    if (!el || !el.textContent) continue;
    const candidate = cleanTitle(el.textContent);
    if (candidate && candidate.length > 2) {
      return candidate;
    }
  }

  const docTitle = document.title || '';
  const normalized = cleanTitle(
    docTitle
      .replace(/\|\s*Microsoft Teams.*/i, '')
      .replace(/\s*-\s*Microsoft Teams.*/i, '')
      .replace(/^Microsoft Teams\s*-\s*/i, '')
  );

  if (normalized && normalized.length > 2 && normalized !== 'Microsoft Teams') {
    return normalized;
  }

  return null;
}

function getZoomMeetingTitle() {
  const titleCandidates = [
    document.querySelector('[data-testid*="meeting-title" i]'),
    document.querySelector('[class*="meeting-title" i]'),
    document.querySelector('[class*="topic" i]'),
    document.querySelector('[title*="Zoom" i]')
  ];

  for (const el of titleCandidates) {
    if (!el || !el.textContent) continue;
    const candidate = cleanTitle(el.textContent);
    if (candidate && candidate.length > 2) {
      return candidate;
    }
  }

  const docTitle = document.title || '';
  const normalized = cleanTitle(
    docTitle
      .replace(/\|\s*Zoom.*/i, '')
      .replace(/\s*-\s*Zoom.*/i, '')
      .replace(/^Zoom\s*Meeting\s*-\s*/i, '')
      .replace(/^Zoom\s*-/i, '')
  );

  if (normalized && normalized.length > 2 && normalized !== 'Zoom' && normalized !== 'Zoom Meeting') {
    return normalized;
  }

  return null;
}

function isRealName(name) {
  if (!name) return false;
  // Filter out technical strings
  const technical = ['720p', '360p', '1080p', 'HD', 'SD', 'unknown', 'null', 'undefined'];
  if (technical.includes(name.toLowerCase())) return false;
  if (name.length < 2) return false;
  // Should have at least one letter
  if (!/[a-zA-Zа-яА-Я]/.test(name)) return false;
  return true;
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sanitizeSpeechText(speakerName, speechText) {
  let normalizedText = (speechText || '').replace(/\s+/g, ' ').trim();
  if (!normalizedText) return '';

  if (speakerName) {
    const escapedName = escapeRegExp(speakerName.trim());
    const leadingSpeakerPattern = new RegExp(`^(?:${escapedName}[\\s:,-]*)+`, 'i');
    normalizedText = normalizedText.replace(leadingSpeakerPattern, '').trim();
  }

  return normalizedText;
}

function sanitizeZoomSpeechText(speechText) {
  if (!speechText) return '';

  const lines = speechText
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  if (lines.length === 0) return '';

  // Zoom often renders speaker avatar initial in a separate line before caption text.
  if (lines.length > 1 && lines[0].length <= 3) {
    return lines.slice(1).join(' ').trim();
  }

  const normalized = lines.join(' ').trim();
  // Guard against picking full-page text when a selector is too broad.
  if (normalized.length > 260) return '';
  return normalized;
}

function getZoomActiveSpeakerName() {
  const iframe = document.querySelector('iframe');
  const doc = iframe && iframe.contentDocument ? iframe.contentDocument : document;
  const candidates = [
    doc.querySelector('.speaker-active-container__wrap'),
    doc.querySelector('.speaker-active-container__video-frame'),
    doc.querySelector('[data-testid*="speaker" i]')
  ];

  for (const el of candidates) {
    if (!el) continue;
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (isRealName(text)) return text;
  }

  return null;
}

function getCaptionObservationRoot() {
  if (PLATFORM === 'zoom') {
    const iframe = document.querySelector('iframe');
    const doc = iframe && iframe.contentDocument ? iframe.contentDocument : null;
    if (doc && doc.body) return doc.body;
  }

  return document.body;
}

function getUserRealName() {
  if (memoizedUserName) return memoizedUserName;

  // 1. Try account button aria-label (format: "Google Account: Name (email)")
  const accountBtn = document.querySelector('[aria-label*="Account"], [aria-label*="Аккаунт"], [aria-label*="account"]');
  if (accountBtn) {
    const label = accountBtn.getAttribute('aria-label');
    // Patterns: "Google Account: Name (email)", "Аккаунт Google: Имя (email)"
    const match = label.match(/:\s*(.*?)\s*\(/) || label.match(/:\s*(.*)$/);
    if (match && match[1] && !match[1].includes('@') && isRealName(match[1])) {
      memoizedUserName = match[1].trim();
      return memoizedUserName;
    }
  }

  // 2. Try the "You" / "Вы" video tile label which often contains the name in brackets
  const selfTooltips = document.querySelectorAll('[aria-label*="You"], [aria-label*="Вы"]');
  for (const el of selfTooltips) {
    const label = el.getAttribute('aria-label');
    const match = label.match(/\((.*?)\)/);
    if (match && match[1] && isRealName(match[1])) {
      memoizedUserName = match[1].trim();
      return memoizedUserName;
    }
  }

  // 3. Try data-self-name attribute
  const selfVideo = document.querySelector('[data-self-name]');
  if (selfVideo) {
    const name = selfVideo.getAttribute('data-self-name');
    if (isRealName(name)) {
      memoizedUserName = name.trim();
      return memoizedUserName;
    }
  }

  // 4. Try profile picture title/alt
  const profileImg = document.querySelector('img[src*="googleusercontent.com/a/"]');
  if (profileImg) {
    const name = profileImg.title || profileImg.alt;
    if (name && !name.includes('http') && !name.includes('@')) {
      memoizedUserName = name.trim();
      return memoizedUserName;
    }
  }

  return null;
}

const STORAGE_SCOPE = `${PLATFORM}:${getMeetingCode()}`;
const RECORDING_STORAGE_KEY = `isRecording:${STORAGE_SCOPE}`;
const TRANSCRIPT_STORAGE_KEY = `transcript:${STORAGE_SCOPE}`;

const DEV_DEBUG_ENABLED = (() => {
  try {
    return !!(chrome && chrome.runtime && chrome.runtime.getManifest && !chrome.runtime.getManifest().update_url);
  } catch (e) {
    return false;
  }
})();

function debugDevLog(scope, details) {
  if (!DEV_DEBUG_ENABLED) return;
  const suffix = details ? ` ${details}` : '';
  console.debug(`[MeetTranscriber][dev] ${scope}${suffix}`);
}

function isExtensionContextAvailable() {
  try {
    return !!(chrome && chrome.runtime && chrome.runtime.id && chrome.storage && chrome.storage.local);
  } catch (e) {
    debugDevLog('context-check', 'threw while checking extension context');
    return false;
  }
}

function safeStorageSet(payload, callback) {
  if (!isExtensionContextAvailable()) {
    debugDevLog('storage.set', 'skipped: extension context unavailable');
    if (typeof callback === 'function') callback();
    return;
  }

  try {
    chrome.storage.local.set(payload, () => {
      if (typeof callback === 'function') callback();
    });
  } catch (e) {
    debugDevLog('storage.set', `failed: ${e && e.message ? e.message : 'unknown error'}`);
    if (typeof callback === 'function') callback();
  }
}

function safeStorageGet(keys, callback) {
  if (!isExtensionContextAvailable()) {
    debugDevLog('storage.get', 'skipped: extension context unavailable');
    callback({});
    return;
  }

  try {
    chrome.storage.local.get(keys, (res) => {
      callback(res || {});
    });
  } catch (e) {
    debugDevLog('storage.get', `failed: ${e && e.message ? e.message : 'unknown error'}`);
    callback({});
  }
}

function safeSendMessage(message, callback) {
  if (!isExtensionContextAvailable()) {
    debugDevLog('runtime.sendMessage', 'skipped: extension context unavailable');
    if (typeof callback === 'function') callback(false);
    return;
  }

  try {
    chrome.runtime.sendMessage(message, () => {
      if (typeof callback === 'function') {
        let ok = true;
        try {
          ok = !chrome.runtime.lastError;
          if (!ok) {
            debugDevLog('runtime.sendMessage', `runtime.lastError: ${chrome.runtime.lastError.message || 'unknown'}`);
          }
        } catch (e) {
          debugDevLog('runtime.sendMessage', 'failed while reading runtime.lastError');
          ok = false;
        }
        callback(ok);
      }
    });
  } catch (e) {
    debugDevLog('runtime.sendMessage', `failed: ${e && e.message ? e.message : 'unknown error'}`);
    if (typeof callback === 'function') callback(false);
  }
}

function setScopedRecordingState(nextIsRecording, nextTranscript) {
  storageStateTouchedLocally = true;
  safeStorageSet({
    [RECORDING_STORAGE_KEY]: nextIsRecording,
    [TRANSCRIPT_STORAGE_KEY]: nextTranscript
  });
}

// ── Persistence ─────────────────────────────────────────────
safeStorageGet([RECORDING_STORAGE_KEY, TRANSCRIPT_STORAGE_KEY, 'isRecording', 'transcript'], (res) => {
  const scopedIsRecording = res[RECORDING_STORAGE_KEY];
  const scopedTranscript = res[TRANSCRIPT_STORAGE_KEY];

  // If the user already toggled recording locally, don't overwrite state with stale async read.
  if (!storageStateTouchedLocally) {
    if (scopedIsRecording !== undefined) {
      isRecording = scopedIsRecording;
    } else if (res.isRecording !== undefined) {
      // Migrate legacy global state into scoped state for this meeting context.
      isRecording = res.isRecording;
      safeStorageSet({ [RECORDING_STORAGE_KEY]: isRecording });
    }

    if (Array.isArray(scopedTranscript)) {
      transcript = scopedTranscript;
    } else if (Array.isArray(res.transcript)) {
      transcript = res.transcript;
      safeStorageSet({ [TRANSCRIPT_STORAGE_KEY]: transcript });
    }
  }

  storageStateInitialized = true;
  refreshUI();
});

if (isExtensionContextAvailable()) {
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local') {
        if (changes[RECORDING_STORAGE_KEY] !== undefined) {
          isRecording = changes[RECORDING_STORAGE_KEY].newValue;
        }
        if (changes[TRANSCRIPT_STORAGE_KEY] !== undefined) {
          transcript = changes[TRANSCRIPT_STORAGE_KEY].newValue;
        }
        refreshUI();
      }
    });
  } catch (e) {
    debugDevLog('storage.onChanged', `listener registration skipped: ${e && e.message ? e.message : 'unknown error'}`);
  }
}

let saveTimeout;
function saveTranscript() {
  storageStateTouchedLocally = true;
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    safeStorageSet({ [TRANSCRIPT_STORAGE_KEY]: transcript });
    refreshUI();
  }, 500);
}

// ── Session Auto-Save ───────────────────────────────────────
function finalizeSession() {
  if (transcript.length === 0) return;
  
  if (!currentSessionId) {
    currentSessionId = Date.now().toString();
  }

  // Merge consecutive entries from same speaker for clean output
  const merged = [];
  transcript.forEach(item => {
    const last = merged[merged.length - 1];
    if (last && last.name === item.name) {
      last.text += ' ' + item.text;
    } else {
      merged.push({ name: item.name, text: item.text });
    }
  });

  const realMe = getUserRealName();
  let uniqueSpeakers = [...new Set(transcript.map(t => {
    if (realMe && (t.name === 'Вы' || t.name === 'You')) return realMe;
    return t.name;
  }))].filter(n => n);
  
  // If we have multiple speakers and one of them is "Вы"/"You" (or our real name), 
  // prioritize others for the title but if it's the only speaker, keep it.
  if (uniqueSpeakers.length > 1) {
    uniqueSpeakers = uniqueSpeakers.filter(n => n !== 'Вы' && n !== 'You' && n !== realMe);
  }
  
  uniqueSpeakers = uniqueSpeakers.slice(0, 3);
  let participants = uniqueSpeakers.join(', ');
  if (participants.length > 50) participants = participants.substring(0, 47) + '...';
  if (!participants) participants = 'No speakers';

  const startTime = parseInt(currentSessionId) || Date.now();
  const d = new Date(startTime);
  const dateStr = d.toLocaleDateString('ru-RU').replace(/\//g, '.');
  const timeStr = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

  const rawTitle = getMeetingTitle();
  const fullTitle = `MR-[${participants}] — ${rawTitle} — ${dateStr} ${timeStr}`;

  const session = {
    id: currentSessionId,
    meetingCode: getMeetingCode(),
    title: fullTitle,
    date: new Date().toISOString(),
    phraseCount: transcript.length,
    transcript: merged
  };
  
  // Send to background for persistent storage, fallback to local list if messaging fails.
  safeSendMessage({ type: 'SAVE_SESSION', session }, (ok) => {
    if (ok) return;

    safeStorageGet(['sessions'], (res) => {
      const sessions = res.sessions || [];
      const idx = sessions.findIndex(s => s.id === session.id);
      if (idx >= 0) sessions[idx] = session;
      else sessions.unshift(session);
      if (sessions.length > 50) sessions.length = 50;
      safeStorageSet({ sessions });
    });
  });
}

// Auto-save when leaving the page or meeting ends
function stopAndSave() {
  if (!isRecording) return;
  finalizeSession();
  isRecording = false;
  setScopedRecordingState(false, []);
  currentSessionId = null;
  refreshUI();
}

window.addEventListener('beforeunload', stopAndSave);

// Monitor if the meeting is still active
setInterval(() => {
  if (isRecording) {
    // 1. Every 30s save progress to history without stopping (heartbeat)
    if (transcript.length > 0 && Date.now() % 30000 < 3000) {
       finalizeSession();
    }

    // 2. Check if meeting ended.
    let leaveBtn;
    let endedScreen;
    let meetingContainer;

    if (PLATFORM === 'teams') {
      leaveBtn = document.querySelector('[data-tid*="hangup" i], button[aria-label*="Leave" i], button[aria-label*="Покинуть" i]');
      endedScreen = document.querySelector('[data-tid*="call-ended" i], [data-tid*="meeting-ended" i]');
      meetingContainer = document.querySelector('[data-tid*="calling" i], [data-tid*="meeting-stage" i], [data-tid*="roster" i]');
    } else if (PLATFORM === 'zoom') {
      leaveBtn = document.querySelector('button[aria-label*="Leave" i], button[aria-label*="Leave Meeting" i], button[aria-label*="End" i], button[aria-label*="End Meeting" i], [data-testid*="leave" i]');
      endedScreen = document.querySelector('[data-testid*="meeting-ended" i], [class*="meeting-ended" i], [class*="ended" i], [aria-label*="Meeting ended" i]');
      meetingContainer = document.querySelector('[class*="meeting-client" i], [class*="meeting-app" i], [class*="in-meeting" i], [class*="video-layout" i], [data-testid*="meeting" i], [data-testid*="video" i]');
    } else {
      leaveBtn = document.querySelector('[aria-label*="Leave"], [aria-label*="встречу"], [aria-label*="Покинуть"]');
      endedScreen = document.querySelector('[data-termination-message], .V006ub, .J57M8c');
      meetingContainer = document.querySelector('.view-container, .wrapper, .a4cQT');
    }
    
    if ((!leaveBtn && !meetingContainer) || endedScreen) {
      console.log('Meet Transcriber: Meeting end detected. Saving and stopping.');
      stopAndSave();
    }
  }
}, 3000);

const captionObserver = new MutationObserver((mutations) => {
  if (!isRecording) return;

  const captionConfig = getCaptionConfig();

  const processedContainers = new Set();

  for (const mutation of mutations) {
    let target = mutation.target;
    let element = target.nodeType === Node.ELEMENT_NODE ? target : target.parentElement;
    if (!element) continue;

    // Search for the wrapper that contains speech (and hopefully speaker)
    // We look for common Meet caption segment containers
    const container = element.closest(captionConfig.container);
    if (!container) continue;
    
    // We want the HIGHEST level container that still represents this specific speaker block
    const blockContainer = container.closest(captionConfig.block) || container;
    
    if (processedContainers.has(blockContainer)) continue;
    processedContainers.add(blockContainer);

    // Find speaker and text elements
    const nameEl = blockContainer.querySelector(captionConfig.name);
    const textEl = blockContainer.querySelector(captionConfig.text);

    if (textEl || PLATFORM === 'zoom') {
      let speechText = textEl ? textEl.textContent.trim() : blockContainer.innerText.trim();
      if (!speechText) continue;

      if (PLATFORM === 'zoom') {
        speechText = sanitizeZoomSpeechText(speechText);
        if (!speechText) continue;
      }

      let speakerName = nameEl ? nameEl.textContent.trim() : "";
      
      // Resolve "You/Вы" or missing names to real name
      if (!speakerName || speakerName === "Вы" || speakerName === "You" || !isRealName(speakerName)) {
        const discoveredName = PLATFORM === 'zoom' ? getZoomActiveSpeakerName() : getUserRealName();
        if (discoveredName) {
          speakerName = discoveredName;
        } else {
          speakerName = speakerName || "Speaker";
        }
      }

      speechText = sanitizeSpeechText(speakerName, speechText);
      if (!speechText) continue;

      // Track by a unique ID assigned to the DOM container
      let blockId = blockContainer.getAttribute('data-transcript-id');
      if (!blockId) {
        blockId = Date.now().toString() + '-' + Math.floor(Math.random() * 10000);
        blockContainer.setAttribute('data-transcript-id', blockId);
      }

      let existingEntry = transcript.find(e => e.id === blockId);
      if (existingEntry) {
        if (existingEntry.text !== speechText) {
          existingEntry.text = speechText;
          saveTranscript();
        }
      } else {
        transcript.push({ id: blockId, name: speakerName, text: speechText });
        saveTranscript();
      }
    }
  }
});

let observedCaptionRoot = null;
function ensureCaptionObserverAttached() {
  const nextRoot = getCaptionObservationRoot();
  if (!nextRoot || observedCaptionRoot === nextRoot) return;

  captionObserver.disconnect();
  captionObserver.observe(nextRoot, { childList: true, subtree: true, characterData: true });
  observedCaptionRoot = nextRoot;
}

ensureCaptionObserverAttached();

// ── Floating Widget (Shadow DOM) ────────────────────────────

function injectWidget() {
  if (widgetHost && document.body.contains(widgetHost)) {
    return;
  }

  const widgetTitle = PLATFORM === 'teams'
    ? '📝 Teams Transcriber'
    : PLATFORM === 'zoom'
      ? '📝 Zoom Transcriber'
      : '📝 Meet Transcriber';
  const host = document.createElement('div');
  host.id = 'meet-transcriber-host';
  // Keep host out of normal document flow to avoid shifting page layout.
  host.style.position = 'fixed';
  host.style.top = '0';
  host.style.left = '0';
  host.style.width = '0';
  host.style.height = '0';
  host.style.zIndex = '2147483647';
  document.body.appendChild(host);
  widgetHost = host;

  const shadow = host.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = `
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');

    :host {
      all: initial;
      font-family: 'Inter', sans-serif;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    /* ── Toggle Button ──────────────────────── */
    .toggle-btn {
      position: fixed;
      right: 0;
      top: 50%;
      transform: translateY(-50%);
      z-index: 999999;
      width: 36px;
      height: 72px;
      border: none;
      border-radius: 12px 0 0 12px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      background: linear-gradient(135deg, #6366f1, #8b5cf6);
      color: #fff;
      font-size: 18px;
      box-shadow: -2px 2px 12px rgba(99,102,241,.45);
      transition: all .25s cubic-bezier(.4,0,.2,1);
      outline: none;
    }
    .toggle-btn:hover {
      width: 42px;
      background: linear-gradient(135deg, #818cf8, #a78bfa);
      box-shadow: -4px 2px 20px rgba(139,92,246,.55);
    }
    .toggle-btn.open {
      right: 320px;
    }
    .toggle-btn .icon {
      transition: transform .3s ease;
      line-height: 1;
    }
    .toggle-btn.open .icon {
      transform: rotate(180deg);
    }

    /* ── Panel ───────────────────────────────── */
    .panel {
      position: fixed;
      right: -320px;
      top: 0;
      width: 320px;
      height: 100vh;
      z-index: 999998;
      background: rgba(15, 15, 25, .92);
      backdrop-filter: blur(24px) saturate(1.4);
      -webkit-backdrop-filter: blur(24px) saturate(1.4);
      border-left: 1px solid rgba(255,255,255,.08);
      display: flex;
      flex-direction: column;
      transition: right .3s cubic-bezier(.4,0,.2,1);
      font-family: 'Inter', sans-serif;
      color: #e2e8f0;
    }
    .panel.open {
      right: 0;
    }

    .panel-header {
      padding: 20px 20px 16px;
      border-bottom: 1px solid rgba(255,255,255,.06);
    }
    .panel-header h2 {
      font-size: 15px;
      font-weight: 700;
      letter-spacing: .3px;
      background: linear-gradient(135deg, #c7d2fe, #a78bfa);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .status {
      margin-top: 8px;
      font-size: 12px;
      font-weight: 500;
      color: #94a3b8;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .status .dot {
      width: 8px; height: 8px;
      border-radius: 50%;
      background: #475569;
      flex-shrink: 0;
    }
    .status.recording .dot {
      background: #ef4444;
      box-shadow: 0 0 8px rgba(239,68,68,.6);
      animation: pulse 1.5s ease-in-out infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: .4; }
    }

    /* ── Buttons ─────────────────────────────── */
    .panel-actions {
      padding: 16px 20px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .btn {
      width: 100%;
      padding: 10px 14px;
      border: none;
      border-radius: 10px;
      font-family: 'Inter', sans-serif;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: all .2s ease;
      outline: none;
    }
    .btn-primary {
      background: linear-gradient(135deg, #6366f1, #8b5cf6);
      color: #fff;
    }
    .btn-primary:hover { filter: brightness(1.15); transform: translateY(-1px); }

    .btn-stop {
      background: linear-gradient(135deg, #ef4444, #dc2626);
      color: #fff;
    }
    .btn-stop:hover { filter: brightness(1.15); transform: translateY(-1px); }

    .btn-secondary {
      background: rgba(255,255,255,.06);
      color: #cbd5e1;
      border: 1px solid rgba(255,255,255,.08);
    }
    .btn-secondary:hover { background: rgba(255,255,255,.1); }
    .btn-secondary:disabled {
      opacity: .35;
      cursor: not-allowed;
    }

    /* ── Transcript Preview ──────────────────── */
    .panel-transcript {
      flex: 1;
      overflow-y: auto;
      padding: 16px 20px;
      border-top: 1px solid rgba(255,255,255,.06);
      user-select: text;
      -webkit-user-select: text;
    }
    .panel-transcript::-webkit-scrollbar { width: 4px; }
    .panel-transcript::-webkit-scrollbar-thumb { background: rgba(255,255,255,.12); border-radius: 4px; }

    .transcript-empty {
      text-align: center;
      color: #64748b;
      font-size: 12px;
      padding-top: 32px;
    }
    .transcript-entry {
      margin-bottom: 12px;
    }
    .transcript-entry .speaker {
      font-size: 11px;
      font-weight: 600;
      color: #a78bfa;
      margin-bottom: 2px;
    }
    .transcript-entry .text {
      font-size: 12px;
      line-height: 1.5;
      color: #cbd5e1;
    }
  `;
  shadow.appendChild(style);

  // ── HTML Structure ──
  const wrapper = document.createElement('div');
  wrapper.innerHTML = `
    <button class="toggle-btn" id="togglePanel">
      <span class="icon">◀</span>
    </button>
    <div class="panel" id="panel">
      <div class="panel-header">
        <h2>${widgetTitle}</h2>
        <div class="status" id="status">
          <span class="dot"></span>
          <span class="status-text">Ожидание...</span>
        </div>
      </div>
      <div class="panel-actions">
        <button class="btn btn-primary" id="toggleRecord">Начать запись</button>
        <button class="btn btn-secondary" id="downloadBtn" disabled>Скачать .txt</button>
        <button class="btn btn-secondary" id="clearBtn" disabled>Очистить</button>
      </div>
      <div class="panel-transcript" id="transcriptPreview">
        <div class="transcript-empty">Нет записей</div>
      </div>
    </div>
  `;
  shadow.appendChild(wrapper);

  // ── Element References ──
  const togglePanelBtn = shadow.getElementById('togglePanel');
  const panel = shadow.getElementById('panel');
  const toggleRecordBtn = shadow.getElementById('toggleRecord');
  const downloadBtn = shadow.getElementById('downloadBtn');
  const clearBtn = shadow.getElementById('clearBtn');
  const statusEl = shadow.getElementById('status');
  const statusText = statusEl.querySelector('.status-text');
  const transcriptPreview = shadow.getElementById('transcriptPreview');

  function legacyCopyToClipboard(text) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.top = '-9999px';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    try {
      document.execCommand('copy');
    } finally {
      document.body.removeChild(textarea);
    }
  }

  function getSelectedTranscriptText() {
    const selection = typeof shadow.getSelection === 'function'
      ? shadow.getSelection()
      : window.getSelection();

    if (!selection || selection.rangeCount === 0) return '';

    const selectedText = selection.toString().trim();
    if (!selectedText) return '';

    const anchorNode = selection.anchorNode;
    if (anchorNode && !transcriptPreview.contains(anchorNode)) return '';

    return selectedText;
  }

  shadow.addEventListener('keydown', (event) => {
    const key = (event.key || '').toLowerCase();
    const isCopyShortcut = (event.ctrlKey || event.metaKey) && !event.altKey && key === 'c';
    if (!isCopyShortcut) return;

    const selectedText = getSelectedTranscriptText();
    if (!selectedText) return;

    event.preventDefault();

    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(selectedText).catch(() => legacyCopyToClipboard(selectedText));
    } else {
      legacyCopyToClipboard(selectedText);
    }
  });

  let panelOpen = false;

  function setPanelOpen(nextOpen) {
    panelOpen = nextOpen;
    panel.classList.toggle('open', panelOpen);
    togglePanelBtn.classList.toggle('open', panelOpen);
    if (panelOpen) refreshUI();
  }

  togglePanelBtn.addEventListener('click', () => {
    setPanelOpen(!panelOpen);
  });

  toggleRecordBtn.addEventListener('click', () => {
    if (!storageStateInitialized) return;

    const newState = !isRecording;
    isRecording = newState;
    
    if (isRecording) {
      // Start of a new session
      currentSessionId = Date.now().toString();
      // Clear transcript for a fresh start if it wasn't already cleared
      transcript = []; 
      ensureCaptionObserverAttached();
      setScopedRecordingState(true, []);
      setPanelOpen(false);
    } else {
      // End of session - finalize and save to history
      finalizeSession();
      // We clear the active transcript after saving to history
      transcript = [];
      setScopedRecordingState(false, []);
      currentSessionId = null;
    }
    
    refreshUI();
  });

  downloadBtn.addEventListener('click', () => {
    if (transcript.length === 0) return;

    // Merge consecutive entries from same speaker
    const merged = [];
    transcript.forEach(item => {
      const last = merged[merged.length - 1];
      if (last && last.name === item.name) {
        last.text += ' ' + item.text;
      } else {
        merged.push({ name: item.name, text: item.text });
      }
    });

    const textContent = merged.map(item => `${item.name}: ${item.text}`).join('\n\n');
    const blob = new Blob([textContent], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);

    // Generate filename similar to finalizeSession logic
    const d = new Date();
    const dateStr = d.toLocaleDateString('ru-RU').replace(/\//g, '.');
    const timeStr = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }).replace(':', '-');
    
    const rawTitle = getMeetingTitle();
    const fileName = `MR-${rawTitle}-${dateStr}-${timeStr}.txt`.replace(/[<>:"/\\|?*]/g, '_');

    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });

  clearBtn.addEventListener('click', () => {
    if (confirm('Очистить текущий экран? История сессий сохранится.')) {
      transcript = [];
      safeStorageSet({ [TRANSCRIPT_STORAGE_KEY]: [] });
      refreshUI();
    }
  });

  // ── Expose refreshUI globally within this script ──
  window.__meetTranscriberRefreshUI = function () {
    if (!storageStateInitialized) {
      statusEl.classList.remove('recording');
      statusText.textContent = 'Инициализация...';
      toggleRecordBtn.textContent = 'Подготовка...';
      toggleRecordBtn.className = 'btn btn-secondary';
      toggleRecordBtn.disabled = true;
      downloadBtn.disabled = true;
      clearBtn.disabled = true;
      return;
    }

    toggleRecordBtn.disabled = false;

    // Status
    if (isRecording) {
      statusEl.classList.add('recording');
      statusText.textContent = `Запись идёт (${transcript.length} фраз)`;
      toggleRecordBtn.textContent = 'Остановить запись';
      toggleRecordBtn.className = 'btn btn-stop';
    } else {
      statusEl.classList.remove('recording');
      statusText.textContent = transcript.length > 0
        ? `Остановлена (${transcript.length} фраз)`
        : 'Ожидание...';
      toggleRecordBtn.textContent = 'Начать запись';
      toggleRecordBtn.className = 'btn btn-primary';
    }

    downloadBtn.disabled = transcript.length === 0;
    clearBtn.disabled = transcript.length === 0 && !isRecording;

    // Transcript preview (show last 50 entries, reversed)
    if (transcript.length === 0) {
      transcriptPreview.innerHTML = '<div class="transcript-empty">Нет записей</div>';
    } else {
      const last = transcript.slice(-50);
      transcriptPreview.innerHTML = last.map(e =>
        `<div class="transcript-entry">
          <div class="speaker">${escapeHTML(e.name)}</div>
          <div class="text">${escapeHTML(e.text)}</div>
        </div>`
      ).join('');
      // Auto-scroll to bottom
      transcriptPreview.scrollTop = transcriptPreview.scrollHeight;
    }
  };
}

function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function refreshUI() {
  if (typeof window.__meetTranscriberRefreshUI === 'function') {
    window.__meetTranscriberRefreshUI();
  }
}

// Inject the widget once the page is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    ensureWidgetState();
    ensureCaptionObserverAttached();
  });
} else {
  ensureWidgetState();
  ensureCaptionObserverAttached();
}

window.addEventListener('popstate', ensureWidgetState);
window.addEventListener('hashchange', ensureWidgetState);
setInterval(() => {
  ensureWidgetState();
  ensureCaptionObserverAttached();
}, 2000);
