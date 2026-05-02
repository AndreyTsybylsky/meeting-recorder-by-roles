// ============================================================
// Meet Transcriber — Content Script
// Captures meeting captions (Google Meet + Microsoft Teams + Zoom)
// ============================================================

const PLATFORM = detectPlatform();

function mtLog(step, details) {
  if (details === undefined) {
    console.log('[MeetTranscriber][content][' + PLATFORM + '] ' + step);
    return;
  }
  console.log('[MeetTranscriber][content][' + PLATFORM + '] ' + step, details);
}

function mtWarn(step, details) {
  if (details === undefined) {
    console.warn('[MeetTranscriber][content][' + PLATFORM + '] ' + step);
    return;
  }
  console.warn('[MeetTranscriber][content][' + PLATFORM + '] ' + step, details);
}

function mtError(step, error) {
  console.error('[MeetTranscriber][content][' + PLATFORM + '] ' + step, error);
}

mtLog('script-init', {
  url: window.location.href,
  title: document.title
});

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
    // Broad container: catches both the classic subtitle div and newer aria-live regions
    container: [
      '#live-transcription-subtitle',
      '.live-transcription-subtitle__box',
      '.live-transcription-subtitle__item',
      '[aria-live="assertive"]',
      '[aria-live="polite"]',
      '[data-testid*="caption" i]',
      '[data-testid*="transcript" i]',
      '[class*="caption" i]',
      '[class*="transcript" i]',
      '[id*="subtitle" i]',
      '[id*="caption" i]',
      '[id*="transcript" i]'
    ].join(', '),
    block: [
      '#live-transcription-subtitle',
      '.live-transcription-subtitle__box',
      '.live-transcription-subtitle__item',
      '[data-testid*="caption-message" i]',
      '[data-testid*="transcript-message" i]',
      '[class*="caption-message" i]',
      '[class*="transcript-message" i]',
      '[class*="caption-item" i]',
      '[class*="transcript-item" i]',
      '[class*="subtitle-item" i]',
      '[id*="caption-item" i]'
    ].join(', '),
    name: [
      '[data-testid*="speaker" i]',
      '.speaker-active-container__wrap',
      '[class*="speaker-name" i]',
      '[class*="participant-name" i]',
      '[class*="display-name" i]',
      '[class*="user-name" i]',
      '[class*="speaker" i]'
    ].join(', '),
    text: [
      '.live-transcription-subtitle__item',
      '[data-testid*="caption-text" i]',
      '[data-testid*="transcript-text" i]',
      '[class*="caption-text" i]',
      '[class*="transcript-text" i]',
      '[class*="subtitle-text" i]',
      '[class*="caption-line" i]',
      '[class*="caption-content" i]',
      '[class*="caption-body" i]'
    ].join(', ')
  }
};

function detectPlatform() {
  const host = window.location.hostname;
  if (host.includes('meet.google.com')) return 'meet';
  if (host.includes('teams.microsoft.com') || host.includes('teams.live.com') || host.includes('teams.cloud.microsoft')) return 'teams';
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
  const shouldShow = shouldShowWidget();
  mtLog('ensureWidgetState', { shouldShow: shouldShow, hasWidget: !!widgetHost });
  if (shouldShow) {
    if (!widgetHost || !document.body.contains(widgetHost)) {
      mtLog('widget-inject:trigger');
      injectWidget();
    }
    return;
  }

  mtWarn('widget-destroy:should-hide');
  destroyWidget();
}

function destroyWidget() {
  mtLog('widget-destroy:start', { hadWidget: !!widgetHost, transcriptLength: transcript.length });
  // Always save transcript before destroying widget to prevent data loss
  if (transcript.length > 0) {
    safeStorageSet({ [TRANSCRIPT_STORAGE_KEY]: transcript });
    mtLog('widget-destroy:saved-transcript', { length: transcript.length });
  }
  if (widgetHost && widgetHost.parentNode) {
    widgetHost.parentNode.removeChild(widgetHost);
  }
  widgetHost = null;
  delete window.__meetTranscriberRefreshUI;
}

let isRecording = false;
let transcript = []; // Array of { id: string, name: string, text: string }
let captionBuffer = [];
let asrBuffer = [];
let currentSessionId = null;
let storageStateInitialized = false;
let storageStateTouchedLocally = false;
let sidebarEnabled = false;    // off by default for stealth; user enables via popup
let autoRecordEnabled = true;  // record automatically on join; user can disable via popup
let qualityFusionEnabled = true; // Buzz-inspired live quality heuristics
let minCaptionChars = 6; // Skip tiny noisy fragments
let hideUnconfirmedEnabled = true; // Hide unstable short interim-looking fragments
let whisperBackupEnabled = false; // Experimental backup ASR via external Whisper endpoint
let whisperBackendStatus = 'unknown';
let whisperBackendLastError = '';
let whisperCaptureMode = 'tab'; // 'tab' (preferred for all participants) | 'mic'
let whisperEndpoint = 'http://127.0.0.1:8765/transcribe';
let whisperLanguage = 'ru';
let whisperChunkMs = 7000;
let meetCaptionOverlayHidden = true; // Tactiq-like default: capture continues while native overlay is hidden
let meetTryEnableCaptionsOnStart = false; // Optional bootstrap: try enabling captions once on recording start
let meetCaptionBootstrapAttemptedForSession = false;
let meetCaptionBootstrapTimer = null;
let meetCaptionManualVisible = false;
let meetCaptionEnabledByBootstrap = false;
let suppressNextMeetCaptionToggleClick = false;
// Guard: only trigger "meeting ended" detection after the meeting container has been
// seen at least once. Prevents false-positive stopAndSave() on initial page load
// before the meeting UI finishes rendering (Teams SPA issue).
let meetingContainerEverSeen = false;
let meetingUiMissingStreak = 0;

const whisperBackupState = {
  active: false,
  stream: null,
  sourceMode: 'unknown',
  recorder: null,
  sessionToken: 0,
  inFlight: 0,
  lastText: '',
  lastTextAt: 0
};

const MAX_STREAM_BUFFER_ITEMS = 500;

function trimStreamBuffer(buffer) {
  if (!Array.isArray(buffer)) return;
  if (buffer.length > MAX_STREAM_BUFFER_ITEMS) {
    buffer.splice(0, buffer.length - MAX_STREAM_BUFFER_ITEMS);
  }
}

function resetStreamBuffers() {
  captionBuffer = [];
  asrBuffer = [];
}

function upsertCaptionBufferEvent(event) {
  if (!event || !event.id || !event.text) return null;
  const normalizedEvent = {
    id: event.id,
    source: event.source || 'captions',
    startTs: Number.isFinite(Number(event.startTs)) ? Number(event.startTs) : Date.now(),
    endTs: Number.isFinite(Number(event.endTs)) ? Number(event.endTs) : Date.now(),
    speakerName: event.speakerName || 'Speaker',
    text: event.text,
    isFinal: event.isFinal !== undefined ? !!event.isFinal : true
  };

  const existingIndex = captionBuffer.findIndex((item) => item.id === normalizedEvent.id);
  if (existingIndex >= 0) {
    captionBuffer[existingIndex] = { ...captionBuffer[existingIndex], ...normalizedEvent };
  } else {
    captionBuffer.push(normalizedEvent);
    trimStreamBuffer(captionBuffer);
  }

  return normalizedEvent;
}

function appendAsrBufferEvent(event) {
  if (!event || !event.id || !event.text) return null;
  const normalizedEvent = {
    id: event.id,
    source: event.source || 'whisper-backup',
    startTs: Number.isFinite(Number(event.startTs)) ? Number(event.startTs) : Date.now(),
    endTs: Number.isFinite(Number(event.endTs)) ? Number(event.endTs) : Date.now(),
    speakerName: event.speakerName || 'Whisper Backup',
    text: event.text,
    isFinal: event.isFinal !== undefined ? !!event.isFinal : true
  };

  asrBuffer.push(normalizedEvent);
  trimStreamBuffer(asrBuffer);
  return normalizedEvent;
}

function rebuildStreamBuffersFromTranscript() {
  resetStreamBuffers();
  transcript.forEach((item) => {
    if (!item || !item.id || !item.text) return;
    const timestamp = Number.isFinite(Number(item._timestamp)) ? Number(item._timestamp) : Date.now();
    if (item._source === 'whisper-backup') {
      appendAsrBufferEvent({
        id: item.id,
        source: item._source,
        startTs: timestamp,
        endTs: timestamp,
        speakerName: item.name || 'Whisper Backup',
        text: item.text,
        isFinal: true
      });
      return;
    }

    upsertCaptionBufferEvent({
      id: item.id,
      source: item._source || 'captions',
      startTs: timestamp,
      endTs: timestamp,
      speakerName: item.name || 'Speaker',
      text: item.text,
      isFinal: true
    });
  });
}

function replaceTranscript(nextTranscript) {
  transcript = Array.isArray(nextTranscript) ? nextTranscript : [];
  rebuildStreamBuffersFromTranscript();
}

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

mtLog('platform-detected', {
  platform: PLATFORM,
  meetingCode: getMeetingCode(),
  locationPath: window.location.pathname,
  locationHash: window.location.hash
});

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

function isSystemCaptionNoise(text) {
  if (!text) return false;
  const patterns = [
    /turned on live transcription/i,
    /turned off live transcription/i,
    /you have turned on/i,
    /you have turned off/i,
    /has joined/i,
    /has left/i,
    /recording has started/i,
    /recording has stopped/i,
    /^alert$/i
  ];
  return patterns.some((rx) => rx.test(text));
}

function isLikelyUnconfirmedFragment(text) {
  if (!text) return false;
  if (/[.!?…]$/.test(text)) return false;
  const words = text.split(/\s+/).filter(Boolean);
  return words.length <= 3 && text.length < 24;
}

function applyLiveQualityFilters(text) {
  if (!text) return '';
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (!qualityFusionEnabled) return normalized;
  if (isSystemCaptionNoise(normalized)) return '';
  if (normalized.length < Math.max(1, Number(minCaptionChars) || 1)) return '';
  if (hideUnconfirmedEnabled && isLikelyUnconfirmedFragment(normalized)) return '';
  return normalized;
}

function normalizeTranscriptTextForDedupe(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/[.,!?;:]+$/g, '')
    .trim()
    .toLowerCase();
}

function normalizeSpeakerForDedupe(name) {
  return String(name || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function isSelfSpeakerAlias(name) {
  const normalized = normalizeSpeakerForDedupe(name);
  if (!normalized) return false;
  if (normalized === 'you' || normalized === '\u0432\u044b') return true;
  const realName = getUserRealName();
  return !!realName && normalized === normalizeSpeakerForDedupe(realName);
}

function isSameSpeakerForDedupe(a, b) {
  const left = normalizeSpeakerForDedupe(a);
  const right = normalizeSpeakerForDedupe(b);
  if (left && right && left === right) return true;
  if (isSelfSpeakerAlias(a) && (isSelfSpeakerAlias(b) || isRealName(b))) return true;
  if (isSelfSpeakerAlias(b) && (isSelfSpeakerAlias(a) || isRealName(a))) return true;
  return false;
}

function isSameLiveCaptionText(a, b) {
  const left = normalizeTranscriptTextForDedupe(a);
  const right = normalizeTranscriptTextForDedupe(b);
  if (!left || !right) return false;
  if (left === right) return true;
  if (Math.min(left.length, right.length) < 35) return false;
  return left.startsWith(right) || right.startsWith(left);
}

function findDuplicateCaptionEntry(text, speakerName, excludeId) {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const entry = transcript[i];
    if (!entry || entry.id === excludeId || !entry.text) continue;
    if (entry._source === 'whisper-backup') continue;
    if (!isSameSpeakerForDedupe(entry.name, speakerName)) continue;
    if (isSameLiveCaptionText(entry.text, text)) return entry;
  }
  return null;
}

function preferCaptionName(currentName, nextName) {
  if (!nextName) return currentName || 'Speaker';
  if (!currentName || currentName === 'Speaker') return nextName;
  if (isSelfSpeakerAlias(currentName) && !/^(you|\u0432\u044b)$/i.test(normalizeSpeakerForDedupe(nextName))) {
    return nextName;
  }
  return currentName;
}

function mergeDuplicateCaptionEntry(existing, next) {
  if (!existing || !next || !next.text) return false;
  const nextText = next.text;
  const shouldReplaceText = normalizeTranscriptTextForDedupe(nextText).length > normalizeTranscriptTextForDedupe(existing.text).length;
  const nextName = preferCaptionName(existing.name, next.name);
  let changed = false;

  if (shouldReplaceText && existing.text !== nextText) {
    existing.text = nextText;
    changed = true;
  }

  if (nextName && existing.name !== nextName) {
    existing.name = nextName;
    changed = true;
  }

  if (next.source && !existing._source) {
    existing._source = next.source;
  }
  if (Number.isFinite(Number(next.rtcVersion))) {
    existing._rtcVersion = Math.max(Number(existing._rtcVersion) || 0, Number(next.rtcVersion));
  }
  existing._selfUnresolved = false;

  if (changed) {
    upsertCaptionBufferEvent({
      id: existing.id,
      source: existing._source || next.source || 'captions',
      speakerName: existing.name,
      text: existing.text,
      isFinal: true
    });
  }

  return changed;
}

function compactDuplicateCaptionEntries() {
  let removed = 0;
  for (let i = 0; i < transcript.length; i++) {
    const base = transcript[i];
    if (!base || base._source === 'whisper-backup') continue;
    for (let j = i + 1; j < transcript.length; j++) {
      const candidate = transcript[j];
      if (!candidate || candidate._source === 'whisper-backup') continue;
      if (!isSameSpeakerForDedupe(base.name, candidate.name)) continue;
      if (!isSameLiveCaptionText(base.text, candidate.text)) continue;
      mergeDuplicateCaptionEntry(base, {
        name: candidate.name,
        text: candidate.text,
        source: candidate._source || 'captions',
        rtcVersion: candidate._rtcVersion
      });
      transcript.splice(j, 1);
      removed++;
      j--;
    }
  }
  if (removed > 0) {
    rebuildStreamBuffersFromTranscript();
    mtWarn('transcript-dedupe:compacted', {
      removed: removed,
      transcriptLength: transcript.length
    });
  }
  return removed;
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
    mtLog('storage.set', { keys: Object.keys(payload || {}) });
    chrome.storage.local.set(payload, () => {
      if (chrome.runtime && chrome.runtime.lastError) {
        mtWarn('storage.set:lastError', chrome.runtime.lastError.message || 'unknown');
      }
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
    mtLog('storage.get', { keys: keys });
    chrome.storage.local.get(keys, (res) => {
      if (chrome.runtime && chrome.runtime.lastError) {
        mtWarn('storage.get:lastError', chrome.runtime.lastError.message || 'unknown');
      }
      mtLog('storage.get:done', { keys: Object.keys(res || {}) });
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
    mtLog('runtime.sendMessage', { type: message && message.type ? message.type : 'unknown' });
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
  mtLog('setScopedRecordingState', {
    nextIsRecording: nextIsRecording,
    transcriptLength: Array.isArray(nextTranscript) ? nextTranscript.length : -1
  });
  storageStateTouchedLocally = true;
  safeStorageSet({
    [RECORDING_STORAGE_KEY]: nextIsRecording,
    [TRANSCRIPT_STORAGE_KEY]: nextTranscript
  });
}

// ── Persistence ─────────────────────────────────────────────
safeStorageGet([
  RECORDING_STORAGE_KEY,
  TRANSCRIPT_STORAGE_KEY,
  'isRecording',
  'transcript',
  'sidebarEnabled',
  'autoRecordEnabled',
  'meetCaptionOverlayHidden',
  'meetTryEnableCaptionsOnStart',
  'qualityFusionEnabled',
  'minCaptionChars',
  'hideUnconfirmedEnabled',
  'whisperBackupEnabled',
  'whisperBackendStatus',
  'whisperBackendLastError',
  'whisperCaptureMode',
  'whisperEndpoint',
  'whisperLanguage',
  'whisperChunkMs'
], (res) => {
  const scopedIsRecording = res[RECORDING_STORAGE_KEY];
  const scopedTranscript = res[TRANSCRIPT_STORAGE_KEY];

  mtLog('storage-init:received', {
    scopedIsRecording: scopedIsRecording,
    scopedTranscriptLength: Array.isArray(scopedTranscript) ? scopedTranscript.length : -1,
    legacyIsRecording: res.isRecording,
    legacyTranscriptLength: Array.isArray(res.transcript) ? res.transcript.length : -1,
    sidebarEnabled: res.sidebarEnabled,
    autoRecordEnabled: res.autoRecordEnabled,
    qualityFusionEnabled: res.qualityFusionEnabled,
    minCaptionChars: res.minCaptionChars,
    hideUnconfirmedEnabled: res.hideUnconfirmedEnabled,
    whisperBackupEnabled: res.whisperBackupEnabled,
    whisperBackendStatus: res.whisperBackendStatus,
    whisperBackendLastError: res.whisperBackendLastError,
    whisperCaptureMode: res.whisperCaptureMode,
    whisperEndpoint: res.whisperEndpoint,
    whisperLanguage: res.whisperLanguage,
    whisperChunkMs: res.whisperChunkMs,
    meetCaptionOverlayHidden: res.meetCaptionOverlayHidden,
    meetTryEnableCaptionsOnStart: res.meetTryEnableCaptionsOnStart
  });

  // Resolve autoRecordEnabled setting (default true if never set)
  autoRecordEnabled = res.autoRecordEnabled !== undefined ? !!res.autoRecordEnabled : true;

  if (res.sidebarEnabled !== undefined) {
    sidebarEnabled = !!res.sidebarEnabled;
  }
  qualityFusionEnabled = res.qualityFusionEnabled !== undefined ? !!res.qualityFusionEnabled : true;
  minCaptionChars = Number.isFinite(Number(res.minCaptionChars)) ? Math.max(1, Math.min(40, Number(res.minCaptionChars))) : 6;
  hideUnconfirmedEnabled = res.hideUnconfirmedEnabled !== undefined ? !!res.hideUnconfirmedEnabled : true;
  whisperBackupEnabled = res.whisperBackupEnabled !== undefined ? !!res.whisperBackupEnabled : false;
  whisperBackendStatus = typeof res.whisperBackendStatus === 'string' ? res.whisperBackendStatus : 'unknown';
  whisperBackendLastError = typeof res.whisperBackendLastError === 'string' ? res.whisperBackendLastError : '';
  whisperCaptureMode = typeof res.whisperCaptureMode === 'string' && ['mic', 'tab'].includes(res.whisperCaptureMode)
    ? res.whisperCaptureMode
    : 'tab';
  whisperEndpoint = typeof res.whisperEndpoint === 'string' && res.whisperEndpoint.trim()
    ? res.whisperEndpoint.trim()
    : 'http://127.0.0.1:8765/transcribe';
  whisperLanguage = typeof res.whisperLanguage === 'string' && res.whisperLanguage.trim()
    ? res.whisperLanguage.trim()
    : 'ru';
  whisperChunkMs = Number.isFinite(Number(res.whisperChunkMs))
    ? Math.max(2000, Math.min(20000, Number(res.whisperChunkMs)))
    : 7000;
  meetCaptionOverlayHidden = res.meetCaptionOverlayHidden !== undefined
    ? !!res.meetCaptionOverlayHidden
    : true;
  meetTryEnableCaptionsOnStart = res.meetTryEnableCaptionsOnStart !== undefined
    ? !!res.meetTryEnableCaptionsOnStart
    : false;

  // If the user already toggled recording locally, don't overwrite state with stale async read.
  if (!storageStateTouchedLocally) {
    if (scopedIsRecording === true) {
      // Resume an in-progress recording (e.g. page reload mid-session).
      isRecording = true;
      mtLog('storage-init:resume-scoped-recording');
    } else if (scopedIsRecording === undefined && res.isRecording === true) {
      // Migrate legacy global true state into scoped state.
      isRecording = true;
      safeStorageSet({ [RECORDING_STORAGE_KEY]: true });
      mtLog('storage-init:migrate-legacy-recording-flag');
    } else if (autoRecordEnabled) {
      // Auto-start: fresh join OR rejoining after a previous session was stopped.
      isRecording = true;
      currentSessionId = Date.now().toString();
      replaceTranscript([]);
      meetCaptionManualVisible = false;
      meetCaptionEnabledByBootstrap = false;
      meetCaptionBootstrapAttemptedForSession = false;
      clearMeetCaptionBootstrapTimer();
      ensureCaptionObserverAttached();
      setScopedRecordingState(true, []);
      mtLog('storage-init:auto-start-enabled', { sessionId: currentSessionId });
      tryEnableMeetCaptionsOnRecordingStart('auto-start');
      startWhisperBackupIfNeeded('auto-start');
    }

    // Always restore transcript from storage, regardless of autoRecordEnabled status.
    // This ensures the user's previous transcripts are never lost.
    if (Array.isArray(scopedTranscript)) {
      replaceTranscript(scopedTranscript);
      mtLog('storage-init:restored-scoped-transcript', { length: transcript.length });
    } else if (Array.isArray(res.transcript)) {
      replaceTranscript(res.transcript);
      safeStorageSet({ [TRANSCRIPT_STORAGE_KEY]: transcript });
      mtLog('storage-init:migrated-legacy-transcript', { length: transcript.length });
    }
  }

  storageStateInitialized = true;
  if (isRecording) {
    startWhisperBackupIfNeeded('storage-resume');
  }
  mtLog('storage-init:complete', {
    isRecording: isRecording,
    transcriptLength: transcript.length,
    sidebarEnabled: sidebarEnabled,
    autoRecordEnabled: autoRecordEnabled,
    qualityFusionEnabled: qualityFusionEnabled,
    minCaptionChars: minCaptionChars,
    hideUnconfirmedEnabled: hideUnconfirmedEnabled,
    whisperBackupEnabled: whisperBackupEnabled,
    whisperBackendStatus: whisperBackendStatus,
    whisperBackendLastError: whisperBackendLastError,
    whisperCaptureMode: whisperCaptureMode,
    whisperEndpoint: whisperEndpoint,
    whisperLanguage: whisperLanguage,
    whisperChunkMs: whisperChunkMs,
    meetCaptionOverlayHidden: meetCaptionOverlayHidden,
    meetTryEnableCaptionsOnStart: meetTryEnableCaptionsOnStart
  });
  refreshUI();
});

if (isExtensionContextAvailable()) {
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local') {
        mtLog('storage.onChanged', { keys: Object.keys(changes || {}) });
        if (changes[RECORDING_STORAGE_KEY] !== undefined) {
          isRecording = changes[RECORDING_STORAGE_KEY].newValue;
          mtLog('storage.onChanged:recording', { isRecording: isRecording });
        }
        if (changes[TRANSCRIPT_STORAGE_KEY] !== undefined) {
          replaceTranscript(changes[TRANSCRIPT_STORAGE_KEY].newValue);
          mtLog('storage.onChanged:transcript', { length: Array.isArray(transcript) ? transcript.length : -1 });
        }
        if (changes['sidebarEnabled'] !== undefined) {
          sidebarEnabled = !!changes['sidebarEnabled'].newValue;
          mtLog('storage.onChanged:sidebarEnabled', { sidebarEnabled: sidebarEnabled });
        }
        if (changes['autoRecordEnabled'] !== undefined) {
          autoRecordEnabled = !!changes['autoRecordEnabled'].newValue;
          mtLog('storage.onChanged:autoRecordEnabled', { autoRecordEnabled: autoRecordEnabled });
        }
        if (changes['qualityFusionEnabled'] !== undefined) {
          qualityFusionEnabled = !!changes['qualityFusionEnabled'].newValue;
          mtLog('storage.onChanged:qualityFusionEnabled', { qualityFusionEnabled: qualityFusionEnabled });
        }
        if (changes['minCaptionChars'] !== undefined) {
          minCaptionChars = Math.max(1, Math.min(40, Number(changes['minCaptionChars'].newValue) || 6));
          mtLog('storage.onChanged:minCaptionChars', { minCaptionChars: minCaptionChars });
        }
        if (changes['hideUnconfirmedEnabled'] !== undefined) {
          hideUnconfirmedEnabled = !!changes['hideUnconfirmedEnabled'].newValue;
          mtLog('storage.onChanged:hideUnconfirmedEnabled', { hideUnconfirmedEnabled: hideUnconfirmedEnabled });
        }
        if (changes['whisperBackupEnabled'] !== undefined) {
          whisperBackupEnabled = !!changes['whisperBackupEnabled'].newValue;
          mtLog('storage.onChanged:whisperBackupEnabled', { whisperBackupEnabled: whisperBackupEnabled });
          if (!whisperBackupEnabled) {
            stopWhisperBackup('disabled-by-setting');
          } else if (isRecording) {
            startWhisperBackupIfNeeded('enabled-by-setting');
          }
        }
        if (changes['whisperBackendStatus'] !== undefined) {
          const previousStatus = whisperBackendStatus;
          whisperBackendStatus = typeof changes['whisperBackendStatus'].newValue === 'string'
            ? changes['whisperBackendStatus'].newValue
            : 'unknown';
          mtLog('storage.onChanged:whisperBackendStatus', { whisperBackendStatus: whisperBackendStatus });
          if (whisperBackupState.active && whisperBackendStatus !== 'ready') {
            stopWhisperBackup('backend-no-longer-ready');
          } else if (!whisperBackupState.active && previousStatus !== 'ready' && whisperBackendStatus === 'ready' && isRecording && whisperBackupEnabled) {
            startWhisperBackupIfNeeded('backend-became-ready');
          }
        }
        if (changes['whisperBackendLastError'] !== undefined) {
          whisperBackendLastError = typeof changes['whisperBackendLastError'].newValue === 'string'
            ? changes['whisperBackendLastError'].newValue
            : '';
          mtLog('storage.onChanged:whisperBackendLastError', { whisperBackendLastError: whisperBackendLastError });
        }
        if (changes['whisperCaptureMode'] !== undefined) {
          const nextMode = changes['whisperCaptureMode'].newValue;
          whisperCaptureMode = typeof nextMode === 'string' && ['mic', 'tab'].includes(nextMode) ? nextMode : 'tab';
          mtLog('storage.onChanged:whisperCaptureMode', { whisperCaptureMode: whisperCaptureMode });
          if (whisperBackupState.active) {
            stopWhisperBackup('capture-mode-changed');
            if (isRecording && whisperBackupEnabled) {
              startWhisperBackupIfNeeded('capture-mode-changed');
            }
          }
        }
        if (changes['whisperEndpoint'] !== undefined) {
          whisperEndpoint = typeof changes['whisperEndpoint'].newValue === 'string' && changes['whisperEndpoint'].newValue.trim()
            ? changes['whisperEndpoint'].newValue.trim()
            : 'http://127.0.0.1:8765/transcribe';
          mtLog('storage.onChanged:whisperEndpoint', { whisperEndpoint: whisperEndpoint });
        }
        if (changes['whisperLanguage'] !== undefined) {
          whisperLanguage = typeof changes['whisperLanguage'].newValue === 'string' && changes['whisperLanguage'].newValue.trim()
            ? changes['whisperLanguage'].newValue.trim()
            : 'ru';
          mtLog('storage.onChanged:whisperLanguage', { whisperLanguage: whisperLanguage });
        }
        if (changes['whisperChunkMs'] !== undefined) {
          whisperChunkMs = Math.max(2000, Math.min(20000, Number(changes['whisperChunkMs'].newValue) || 7000));
          mtLog('storage.onChanged:whisperChunkMs', { whisperChunkMs: whisperChunkMs });
          if (whisperBackupState.active) {
            stopWhisperBackup('chunk-size-changed');
            if (isRecording && whisperBackupEnabled) {
              startWhisperBackupIfNeeded('chunk-size-changed');
            }
          }
        }
        if (changes['meetCaptionOverlayHidden'] !== undefined) {
          meetCaptionOverlayHidden = !!changes['meetCaptionOverlayHidden'].newValue;
          mtLog('storage.onChanged:meetCaptionOverlayHidden', { meetCaptionOverlayHidden: meetCaptionOverlayHidden });
        }
        if (changes['meetTryEnableCaptionsOnStart'] !== undefined) {
          meetTryEnableCaptionsOnStart = !!changes['meetTryEnableCaptionsOnStart'].newValue;
          mtLog('storage.onChanged:meetTryEnableCaptionsOnStart', { meetTryEnableCaptionsOnStart: meetTryEnableCaptionsOnStart });
        }
        refreshUI();
      }
    });
  } catch (e) {
    debugDevLog('storage.onChanged', `listener registration skipped: ${e && e.message ? e.message : 'unknown error'}`);
  }
}

// ── Popup ↔ Content message bridge ─────────────────────────
if (isExtensionContextAvailable()) {
  try {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      mtLog('runtime.onMessage', { type: message && message.type ? message.type : 'unknown' });
      if (message.type === 'GET_RECORDING_STATE') {
        sendResponse({ isRecording, initialized: storageStateInitialized });
        return false;
      }
      if (message.type === 'TOGGLE_RECORDING') {
        const newState = !isRecording;
        isRecording = newState;
        if (isRecording) {
          currentSessionId = Date.now().toString();
          replaceTranscript([]);
          meetCaptionManualVisible = false;
          meetCaptionEnabledByBootstrap = false;
          meetCaptionBootstrapAttemptedForSession = false;
          clearMeetCaptionBootstrapTimer();
          ensureCaptionObserverAttached();
          setScopedRecordingState(true, []);
          mtLog('recording-start:manual-toggle', { sessionId: currentSessionId });
          tryEnableMeetCaptionsOnRecordingStart('manual-toggle');
          startWhisperBackupIfNeeded('manual-toggle');
          // Close the transcript panel if the widget is already injected
          if (typeof window.__meetTranscriberSetPanelOpen === 'function') {
            window.__meetTranscriberSetPanelOpen(false);
          }
        } else {
          mtWarn('recording-stop:manual-toggle', { transcriptLength: transcript.length });
          finalizeSession();
          replaceTranscript([]);
          meetCaptionManualVisible = false;
          meetCaptionEnabledByBootstrap = false;
          meetCaptionBootstrapAttemptedForSession = false;
          clearMeetCaptionBootstrapTimer();
          if (PLATFORM === 'meet') {
            removeMeetCaptionHideStyle();
            window.dispatchEvent(new Event('resize'));
          }
          setScopedRecordingState(false, []);
          currentSessionId = null;
          stopWhisperBackup('manual-toggle-stop');
        }
        refreshUI();
        sendResponse({ isRecording });
        return false;
      }
      if (message.type === 'START_WHISPER_BACKUP') {
        startWhisperBackupIfNeeded('popup-user-action');
        sendResponse({ ok: true });
        return false;
      }
      if (message.type === 'START_ZOOM_TRANSCRIPTION') {
        if (PLATFORM !== 'zoom') {
          sendResponse({ success: false, error: 'Not on Zoom' });
          return false;
        }
        if (!window.__meetTranscriberZoomCaptureAPI) {
          sendResponse({ success: false, error: 'Zoom capture API not ready' });
          return false;
        }
        try {
          const result = window.__meetTranscriberZoomCaptureAPI.startTranscription();
          const status = window.__meetTranscriberZoomCaptureAPI.getTranscriptionStatus();
          mtLog('start-zoom-transcription:requested', { result, status });
          sendResponse({ success: result, status });
          return false;
        } catch (e) {
          mtWarn('start-zoom-transcription:error', e && e.message);
          sendResponse({ success: false, error: e && e.message ? e.message : 'Unknown error' });
          return false;
        }
      }
      if (message.type === 'GET_ZOOM_DEBUG_INFO') {
        if (PLATFORM !== 'zoom' || !window.__meetTranscriberZoomCaptureAPI) {
          sendResponse({ info: null });
          return false;
        }
        try {
          const debugInfo = window.__meetTranscriberZoomCaptureAPI.debugInfo();
          const status = window.__meetTranscriberZoomCaptureAPI.getTranscriptionStatus();
          sendResponse({ info: { ...debugInfo, ...status } });
          return false;
        } catch (e) {
          sendResponse({ info: null, error: e && e.message });
          return false;
        }
      }
    });
  } catch (e) {
    debugDevLog('runtime.onMessage', `listener registration skipped: ${e && e.message ? e.message : 'unknown error'}`);
  }
}

let saveTimeout;
function saveTranscript() {
  storageStateTouchedLocally = true;
  clearTimeout(saveTimeout);
  mtLog('saveTranscript:scheduled', { transcriptLength: transcript.length });
  saveTimeout = setTimeout(() => {
    compactDuplicateCaptionEntries();
    mtLog('saveTranscript:flush', { transcriptLength: transcript.length });
    safeStorageSet({ [TRANSCRIPT_STORAGE_KEY]: transcript });
    refreshUI();
  }, 500);
}

async function transcribeWhisperChunk(blob, sessionToken) {
  if (!blob || !blob.size) return;
  if (!whisperEndpoint) return;
  if (sessionToken !== whisperBackupState.sessionToken) return;

  whisperBackupState.inFlight += 1;
  try {
    const fd = new FormData();
    fd.append('file', blob, 'chunk.webm');
    if (whisperLanguage) {
      fd.append('language', whisperLanguage);
    }
    fd.append('task', 'transcribe');

    const resp = await fetch(whisperEndpoint, {
      method: 'POST',
      body: fd
    });

    if (!resp.ok) {
      mtWarn('whisper-backup:transcribe-http-failed', { status: resp.status });
      return;
    }

    const payload = await resp.json().catch(() => ({}));
    const rawText = typeof payload.text === 'string'
      ? payload.text
      : (typeof payload.transcript === 'string' ? payload.transcript : '');
    const filteredText = applyLiveQualityFilters(rawText);
    if (!filteredText) return;

    const now = Date.now();
    if (
      whisperBackupState.lastText === filteredText &&
      now - whisperBackupState.lastTextAt < Math.max(1500, whisperChunkMs)
    ) {
      return;
    }
    whisperBackupState.lastText = filteredText;
    whisperBackupState.lastTextAt = now;

    const speaker = getUserRealName() || 'Whisper Backup';
    const id = `whisper-${now}-${Math.floor(Math.random() * 10000)}`;
    appendAsrBufferEvent({
      id,
      source: 'whisper-backup',
      startTs: now,
      endTs: now,
      speakerName: speaker,
      text: filteredText,
      isFinal: true
    });
    transcript.push({
      id,
      name: speaker,
      text: filteredText,
      _source: 'whisper-backup',
      _timestamp: now
    });
    mtLog('whisper-backup:new-entry', {
      textLength: filteredText.length,
      transcriptLength: transcript.length
    });
    saveTranscript();
  } catch (e) {
    mtWarn('whisper-backup:transcribe-error', e && e.message ? e.message : 'unknown');
  } finally {
    whisperBackupState.inFlight = Math.max(0, whisperBackupState.inFlight - 1);
  }
}

async function startWhisperBackupIfNeeded(trigger) {
  if (!isRecording) return;
  if (!whisperBackupEnabled) return;
  if (whisperBackendStatus !== 'ready') {
    mtWarn('whisper-backup:backend-not-ready', {
      status: whisperBackendStatus,
      error: whisperBackendLastError || 'none'
    });
    return;
  }
  if (whisperBackupState.active) return;
  if (!navigator.mediaDevices) {
    mtWarn('whisper-backup:unsupported-mediaDevices');
    return;
  }

  async function getMicStream() {
    if (!navigator.mediaDevices.getUserMedia) return null;
    return navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
  }

  async function getTabOrSystemAudioStream() {
    if (!navigator.mediaDevices.getDisplayMedia) return null;
    const display = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true
    });
    const audioTracks = display.getAudioTracks();
    if (!audioTracks || !audioTracks.length) {
      // User selected source without audio. Stop display tracks immediately.
      display.getTracks().forEach((t) => t.stop());
      return null;
    }
    return new MediaStream(audioTracks);
  }

  try {
    let stream = null;
    let sourceMode = whisperCaptureMode;

    if (whisperCaptureMode === 'tab') {
      try {
        stream = await getTabOrSystemAudioStream();
      } catch (e) {
        mtWarn('whisper-backup:tab-capture-failed', e && e.message ? e.message : 'unknown');
      }
      if (!stream) {
        mtWarn('whisper-backup:tab-capture-no-audio-fallback-mic');
        sourceMode = 'mic';
        stream = await getMicStream();
      }
    } else {
      stream = await getMicStream();
      sourceMode = 'mic';
    }

    if (!stream) {
      mtWarn('whisper-backup:start-failed-no-stream');
      return;
    }

    const preferredTypes = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus'
    ];
    const mimeType = preferredTypes.find((t) => {
      try {
        return typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t);
      } catch (e) {
        return false;
      }
    });

    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    const token = whisperBackupState.sessionToken + 1;

    whisperBackupState.sessionToken = token;
    whisperBackupState.stream = stream;
    whisperBackupState.sourceMode = sourceMode;
    whisperBackupState.recorder = recorder;
    whisperBackupState.active = true;
    whisperBackupState.lastText = '';
    whisperBackupState.lastTextAt = 0;

    recorder.addEventListener('dataavailable', (evt) => {
      if (!evt.data || !evt.data.size) return;
      transcribeWhisperChunk(evt.data, token);
    });

    recorder.addEventListener('error', (evt) => {
      mtWarn('whisper-backup:recorder-error', evt && evt.error ? evt.error.message : 'unknown');
    });

    recorder.start(Math.max(2000, Number(whisperChunkMs) || 7000));
    mtLog('whisper-backup:start', {
      trigger: trigger || 'unspecified',
      captureModeRequested: whisperCaptureMode,
      captureModeActual: sourceMode,
      endpoint: whisperEndpoint,
      chunkMs: whisperChunkMs,
      mimeType: recorder.mimeType || mimeType || 'default'
    });
  } catch (e) {
    mtWarn('whisper-backup:start-failed', e && e.message ? e.message : 'unknown');
  }
}

function stopWhisperBackup(reason) {
  if (!whisperBackupState.active) return;

  try {
    if (whisperBackupState.recorder && whisperBackupState.recorder.state !== 'inactive') {
      whisperBackupState.recorder.stop();
    }
  } catch (e) {
    mtWarn('whisper-backup:stop-recorder-failed', e && e.message ? e.message : 'unknown');
  }

  try {
    if (whisperBackupState.stream) {
      whisperBackupState.stream.getTracks().forEach((t) => t.stop());
    }
  } catch (e) {
    mtWarn('whisper-backup:stop-stream-failed', e && e.message ? e.message : 'unknown');
  }

  whisperBackupState.active = false;
  whisperBackupState.stream = null;
  whisperBackupState.sourceMode = 'unknown';
  whisperBackupState.recorder = null;
  whisperBackupState.sessionToken += 1;
  mtLog('whisper-backup:stop', { reason: reason || 'unspecified' });
}

// ── Session Auto-Save ───────────────────────────────────────
function finalizeSession() {
  mtLog('finalizeSession:start', {
    transcriptLength: transcript.length,
    currentSessionId: currentSessionId
  });
  if (transcript.length === 0) {
    mtWarn('finalizeSession:skip-empty-transcript');
    return;
  }
  
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
    transcript: merged,
    debugStats: PLATFORM === 'meet' ? getMeetSourceStatsSnapshot() : undefined
  };
  mtLog('finalizeSession:prepared', {
    sessionId: session.id,
    phraseCount: session.phraseCount,
    meetingCode: session.meetingCode,
    title: session.title,
    sourceStats: session.debugStats
  });
  
  // Send to background for persistent storage, fallback to local list if messaging fails.
  safeSendMessage({ type: 'SAVE_SESSION', session }, (ok) => {
    if (ok) {
      mtLog('finalizeSession:save-via-background-ok', { sessionId: session.id });
      return;
    }

    mtWarn('finalizeSession:save-via-background-failed:fallback-storage', { sessionId: session.id });

    safeStorageGet(['sessions'], (res) => {
      const sessions = res.sessions || [];
      const idx = sessions.findIndex(s => s.id === session.id);
      if (idx >= 0) sessions[idx] = session;
      else sessions.unshift(session);
      if (sessions.length > 50) sessions.length = 50;
      safeStorageSet({ sessions });
      mtLog('finalizeSession:fallback-saved', { totalSessions: sessions.length, sessionId: session.id });
    });
  });
}

// Auto-save when leaving the page or meeting ends
function stopAndSave(reason) {
  mtWarn('stopAndSave:called', {
    reason: reason || 'unspecified',
    isRecording: isRecording,
    transcriptLength: transcript.length,
    meetingContainerEverSeen: meetingContainerEverSeen
  });
  if (!isRecording) {
    mtWarn('stopAndSave:skip-not-recording', { reason: reason || 'unspecified' });
    return;
  }
  finalizeSession();
  stopWhisperBackup(reason || 'stopAndSave');
  isRecording = false;
  setScopedRecordingState(false, []);
  currentSessionId = null;
  clearMeetCaptionBootstrapTimer();
  if (PLATFORM === 'meet') {
    removeMeetCaptionHideStyle();
    window.dispatchEvent(new Event('resize'));
  }
  mtWarn('stopAndSave:recording-stopped', { reason: reason || 'unspecified' });
  refreshUI();
}

window.addEventListener('beforeunload', () => stopAndSave('beforeunload'));

// Monitor if the meeting is still active
setInterval(() => {
  if (isRecording) {
    // 1. Every 30s save progress to history without stopping (heartbeat)
    if (transcript.length > 0 && Date.now() % 30000 < 3000) {
       mtLog('recording-heartbeat:finalizeSession');
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
      // Google Meet: use specific selectors to avoid false-positives
      // Leave button is always visible during active call
      leaveBtn = document.querySelector(
        'button[aria-label*="Leave call" i], button[aria-label*="Leave meeting" i], ' +
        'button[aria-label*="встречу" i], button[aria-label*="Покинуть" i], ' +
        '[data-tooltip*="Leave" i], [data-idom-class*="leave" i]'
      );
      // Only [data-termination-message] is specific to Meet's "call ended" screen;
      // .V006ub / .J57M8c are too broad and match caption-close toast notifications.
      endedScreen = document.querySelector('[data-termination-message]');
      // .a4cQT is Google Meet's persistent call container; avoid generic .wrapper/.view-container
      meetingContainer = document.querySelector('.a4cQT, [data-call-ended="false"], [jsname="F80f8"], [data-meeting-code]');
    }
    
    // Track when we first see the meeting container so we don't false-fire on load
    if (meetingContainer || leaveBtn) meetingContainerEverSeen = true;

    const heartbeatState = {
      leaveBtn: !!leaveBtn,
      meetingContainer: !!meetingContainer,
      endedScreen: !!endedScreen,
      uiMissingStreak: meetingUiMissingStreak,
      meetingContainerEverSeen: meetingContainerEverSeen,
      transcriptLength: transcript.length
    };
    const nextStateKey = [
      heartbeatState.leaveBtn,
      heartbeatState.meetingContainer,
      heartbeatState.endedScreen,
      heartbeatState.meetingContainerEverSeen
    ].join('|');
    if (window.__mtLastHeartbeatStateKey !== nextStateKey) {
      window.__mtLastHeartbeatStateKey = nextStateKey;
      mtLog('meeting-monitor:state-change', heartbeatState);
    }

    if (meetingContainerEverSeen && endedScreen) {
      meetingUiMissingStreak = 0;
      const reasonEnded = 'meeting-ended-screen-detected';
      mtWarn('meeting-monitor:stop-triggered', heartbeatState);
      stopAndSave(reasonEnded);
      return;
    }

    if (PLATFORM === 'meet' && meetingContainerEverSeen && !leaveBtn && !meetingContainer) {
      // Meet can transiently remount call controls/canvas while still active.
      // Do not auto-stop recording on missing UI for Meet; rely on explicit
      // ended screen or beforeunload/manual stop instead.
      meetingUiMissingStreak += 1;
      mtLog('meeting-monitor:meet-ui-missing-ignored', {
        streak: meetingUiMissingStreak,
        leaveBtn: !!leaveBtn,
        meetingContainer: !!meetingContainer
      });
    } else if (meetingContainerEverSeen && !leaveBtn && !meetingContainer) {
      meetingUiMissingStreak += 1;
      mtWarn('meeting-monitor:ui-missing-tick', {
        streak: meetingUiMissingStreak,
        leaveBtn: !!leaveBtn,
        meetingContainer: !!meetingContainer
      });
      // Require several consecutive misses to avoid false stops caused by
      // short Meet UI rerenders / route transitions.
      if (meetingUiMissingStreak >= 4) {
        const reasonMissing = 'meeting-ui-not-found-consecutive';
        mtWarn('meeting-monitor:stop-triggered', heartbeatState);
        stopAndSave(reasonMissing);
      }
    } else {
      if (meetingUiMissingStreak > 0) {
        mtLog('meeting-monitor:ui-missing-streak-reset', { previousStreak: meetingUiMissingStreak });
      }
      meetingUiMissingStreak = 0;
    }
  }
}, 3000);

const captionObserver = new MutationObserver((mutations) => {
  if (!isRecording) return;

  // Zoom has a dedicated MAIN-world capture module (zoom-capture.js).
  // Skip generic DOM observer ingestion to avoid duplicate/conflicting updates
  // that can overwrite already captured transcript lines.
  if (PLATFORM === 'zoom' && window.__meetTranscriberZoomCaptureAPI) {
    return;
  }

  mtLog('mutation-observer:batch', { mutationCount: mutations.length });

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
      // Use textContent (not innerText) so hidden/off-screen caption elements are still read.
      let speechText = textEl ? textEl.textContent.trim() : blockContainer.textContent.trim();
      if (!speechText) {
        mtLog('mutation-observer:skip-empty-text');
        continue;
      }

      if (PLATFORM === 'zoom') {
        speechText = sanitizeZoomSpeechText(speechText);
        if (!speechText) {
          mtWarn('mutation-observer:zoom-sanitize-empty');
          continue;
        }
      }

      let speakerName = nameEl ? nameEl.textContent.trim() : "";
      
      // Resolve "You/Вы" or missing names to real name
      const isUnresolvedSelf = !speakerName || speakerName === "Вы" || speakerName === "You" || !isRealName(speakerName);
      if (isUnresolvedSelf) {
        const discoveredName = PLATFORM === 'zoom' ? getZoomActiveSpeakerName() : getUserRealName();
        if (discoveredName) {
          speakerName = discoveredName;
        } else {
          speakerName = speakerName || "Speaker";
        }
      }

      speechText = sanitizeSpeechText(speakerName, speechText);
      speechText = applyLiveQualityFilters(speechText);
      if (!speechText) {
        mtLog('mutation-observer:skip-sanitized-empty');
        continue;
      }

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
          existingEntry.name = speakerName;
          upsertCaptionBufferEvent({
            id: blockId,
            source: 'captions-dom',
            speakerName: speakerName,
            text: speechText,
            isFinal: true
          });
          mtLog('mutation-observer:update-entry', {
            blockId: blockId,
            speakerName: speakerName,
            textLength: speechText.length
          });
          saveTranscript();
        }
      } else {
        const duplicateEntry = PLATFORM === 'meet'
          ? findDuplicateCaptionEntry(speechText, speakerName, blockId)
          : null;
        if (duplicateEntry) {
          const merged = mergeDuplicateCaptionEntry(duplicateEntry, {
            name: speakerName,
            text: speechText,
            source: 'captions-dom'
          });
          mtLog('mutation-observer:dedupe-merged-entry', {
            blockId: blockId,
            existingId: duplicateEntry.id,
            merged: merged,
            speakerName: duplicateEntry.name,
            textLength: duplicateEntry.text.length
          });
          if (merged) {
            saveTranscript();
            refreshUI();
          }
          continue;
        }

        upsertCaptionBufferEvent({
          id: blockId,
          source: 'captions-dom',
          speakerName: speakerName,
          text: speechText,
          isFinal: true
        });
        transcript.push({
          id: blockId,
          name: speakerName,
          text: speechText,
          _source: 'captions-dom',
          _timestamp: Date.now(),
          _selfUnresolved: isUnresolvedSelf && !getUserRealName()
        });
        mtLog('mutation-observer:new-entry', {
          blockId: blockId,
          speakerName: speakerName,
          textLength: speechText.length,
          transcriptLength: transcript.length
        });
        saveTranscript();

        // Retry resolving "Вы"/"You" → real name if it wasn't available yet
        if (isUnresolvedSelf && speakerName !== getUserRealName()) {
          const retryDelays = [800, 2500];
          retryDelays.forEach(delay => {
            setTimeout(() => {
              const resolved = PLATFORM === 'zoom' ? getZoomActiveSpeakerName() : getUserRealName();
              if (!resolved) return;
              // Backfill ALL unresolved self-entries recorded so far
              let patched = 0;
              transcript.forEach(e => {
                if (e._selfUnresolved && e.name !== resolved) {
                  e.name = resolved;
                  e._selfUnresolved = false;
                  upsertCaptionBufferEvent({
                    id: e.id,
                    source: e._source || 'captions',
                    speakerName: resolved,
                    text: e.text,
                    isFinal: true
                  });
                  patched++;
                }
              });
              if (patched > 0) {
                mtLog('mutation-observer:retry-resolved-name-backfill', { resolved, patched });
                saveTranscript();
                refreshUI();
              }
            }, delay);
          });
        }
      }
    }
  }
});

let observedCaptionRoot = null;
function ensureCaptionObserverAttached() {
  const nextRoot = getCaptionObservationRoot();
  if (!nextRoot) {
    mtWarn('caption-observer:skip-no-root');
    return;
  }
  if (observedCaptionRoot === nextRoot) return;

  captionObserver.disconnect();
  captionObserver.observe(nextRoot, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'aria-hidden', 'data-is-muted']
  });
  observedCaptionRoot = nextRoot;
  mtLog('caption-observer:attached', {
    rootTag: nextRoot.tagName,
    rootId: nextRoot.id || '',
    rootClass: nextRoot.className || ''
  });
}

ensureCaptionObserverAttached();

// ── Zoom aria-live periodic scan (fallback) ──────────────────
// Zoom sometimes replaces entire subtitle DOM subtrees rather than mutating
// text in place, which can cause MutationObserver to fire on the wrong level.
// This scanner directly reads all aria-live regions every 600 ms as a safety net.
if (PLATFORM === 'zoom' && !window.__meetTranscriberZoomCaptureAPI) {
  const zoomAriaLiveCache = new Map(); // element → last seen text

  setInterval(() => {
    if (!isRecording) return;

    const root = getCaptionObservationRoot();
    if (!root) return;

    const regions = root.querySelectorAll('[aria-live], [aria-atomic="true"]');
    regions.forEach(el => {
      const raw = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!raw || raw.length < 3 || raw.length > 400) return;

      // Skip if unchanged since last scan
      if (zoomAriaLiveCache.get(el) === raw) return;
      zoomAriaLiveCache.set(el, raw);

      // Try to resolve a speaker name from a sibling/parent name element
      const captionConfig = getCaptionConfig();
      const nameEl = el.querySelector(captionConfig.name) ||
                     el.closest('[class*="caption-item" i], [class*="subtitle-item" i]')?.querySelector(captionConfig.name);
      let speakerName = nameEl ? (nameEl.textContent || '').trim() : '';
      if (!speakerName || !isRealName(speakerName)) {
        speakerName = getZoomActiveSpeakerName() || getUserRealName() || 'Speaker';
      }

      const text = sanitizeZoomSpeechText(raw);
      if (!text) return;

      // Stable ID based on the region's class/id
      const elId = 'zoom-live-' + (el.id || el.className || '').replace(/\s+/g, '-').slice(0, 48);

      const existing = transcript.find(e => e.id === elId);
      if (existing) {
        if (existing.text !== text) {
          existing.text = text;
          existing.name = speakerName;
          upsertCaptionBufferEvent({
            id: elId,
            source: 'zoom-aria-live',
            speakerName: speakerName,
            text: text,
            isFinal: true
          });
          mtLog('zoom-aria-live:update-entry', { id: elId, speakerName: speakerName, textLength: text.length });
          saveTranscript();
        }
      } else {
        upsertCaptionBufferEvent({
          id: elId,
          source: 'zoom-aria-live',
          speakerName: speakerName,
          text: text,
          isFinal: true
        });
        transcript.push({ id: elId, name: speakerName, text });
        mtLog('zoom-aria-live:new-entry', { id: elId, speakerName: speakerName, textLength: text.length });
        saveTranscript();
      }
    });
  }, 600);
}

// ── Google Meet RTC Caption Capture ────────────────────────
// googlemeet-capture.js (MAIN world) intercepts the WebRTC 'captions'
// data channel and dispatches __mt_meet_caption events.
// It also fills meetDeviceMap via __mt_meet_device events from the
// 'collections' channel and the SyncMeetingSpaceCollections HTTP call.
const meetDeviceMap = {}; // '@deviceId' → displayName
let lastMeetCaptionActivityAt = Date.now();
const meetSourceStats = {
  window: [],
  totals: {
    captions: 0,
    meet_messages: 0,
    create_meeting_message: 0,
    unknown: 0
  },
  lastSource: null,
  lastSwitchAt: 0,
  lastMetricsLogAt: 0
};

function normalizeMeetSource(source) {
  if (source === 'captions') return 'captions';
  if (source === 'meet_messages') return 'meet_messages';
  if (source === 'create_meeting_message') return 'create_meeting_message';
  return 'unknown';
}

function getMeetSourceStatsSnapshot() {
  const now = Date.now();
  const minAt = now - 60000;
  meetSourceStats.window = meetSourceStats.window.filter(item => item.at >= minAt);

  const epm = {
    captions: 0,
    meet_messages: 0,
    create_meeting_message: 0,
    unknown: 0
  };

  meetSourceStats.window.forEach(item => {
    if (!epm[item.source] && item.source !== 'unknown') return;
    epm[item.source] += 1;
  });

  return {
    epm: epm,
    totals: { ...meetSourceStats.totals },
    lastSource: meetSourceStats.lastSource,
    lastSwitchAgoMs: meetSourceStats.lastSwitchAt ? (now - meetSourceStats.lastSwitchAt) : null
  };
}

function trackMeetSourceActivity(sourceRaw) {
  const now = Date.now();
  const source = normalizeMeetSource(sourceRaw);
  const prev = meetSourceStats.lastSource;

  meetSourceStats.window.push({ at: now, source: source });
  if (meetSourceStats.totals[source] === undefined) meetSourceStats.totals[source] = 0;
  meetSourceStats.totals[source] += 1;

  if (prev && prev !== source) {
    meetSourceStats.lastSwitchAt = now;
    mtWarn('meet-source:switch', { from: prev, to: source });
  }
  meetSourceStats.lastSource = source;

  if (now - meetSourceStats.lastMetricsLogAt > 10000) {
    const snapshot = getMeetSourceStatsSnapshot();
    mtLog('meet-source:metrics', {
      epm: snapshot.epm,
      totals: snapshot.totals,
      lastSource: snapshot.lastSource,
      lastSwitchAgoMs: snapshot.lastSwitchAgoMs
    });
    meetSourceStats.lastMetricsLogAt = now;
  }
}

function markMeetCaptionActivity(source) {
  lastMeetCaptionActivityAt = Date.now();
  mtLog('meet-capture:activity', { source: source, at: lastMeetCaptionActivityAt });
}

if (PLATFORM === 'meet') {
  document.addEventListener('__mt_meet_device', (evt) => {
    const { deviceId, deviceName } = evt.detail || {};
    if (deviceId && deviceName) {
      meetDeviceMap[deviceId] = deviceName;
      mtLog('meet-device-map:update', {
        deviceId: deviceId,
        deviceName: deviceName,
        totalKnownDevices: Object.keys(meetDeviceMap).length
      });
      debugDevLog('meet-device', `${deviceId} → ${deviceName}`);
    } else {
      mtWarn('meet-device-map:skip-invalid-event', evt.detail || {});
    }
  });

  document.addEventListener('__mt_meet_caption', (evt) => {
    if (!isRecording) return;
    const { deviceId, messageId, messageVersion, text, _source } = evt.detail || {};
    trackMeetSourceActivity(_source || 'unknown');
    if (!text || !messageId) {
      mtWarn('meet-caption:skip-missing-required', {
        hasText: !!text,
        hasMessageId: !!messageId,
        deviceId: deviceId
      });
      return;
    }

    // Resolve display name from the device map (populated before first caption arrives)
    let speakerName = meetDeviceMap[deviceId] || '';
    if (!speakerName || !isRealName(speakerName)) {
      speakerName = getUserRealName() || 'Speaker';
    }

    let cleanText = sanitizeSpeechText(speakerName, text.trim());
    cleanText = applyLiveQualityFilters(cleanText);
    if (!cleanText) return;

    const existing = transcript.find(e => e.id === messageId);
    if (existing) {
      // Update if this version has newer/longer text
      const existingVer = existing._rtcVersion || 0;
      if (messageVersion > existingVer && existing.text !== cleanText) {
        existing.text = cleanText;
        existing.name = speakerName;
        existing._rtcVersion = messageVersion;
        upsertCaptionBufferEvent({
          id: messageId,
          source: _source || 'captions',
          speakerName: speakerName,
          text: cleanText,
          isFinal: true
        });
        markMeetCaptionActivity(_source || 'rtc-update');
        mtLog('meet-caption:update-entry', {
          messageId: messageId,
          messageVersion: messageVersion,
          speakerName: speakerName,
          textLength: cleanText.length
        });
        saveTranscript();
      }
    } else {
      const duplicateEntry = findDuplicateCaptionEntry(cleanText, speakerName, messageId);
      if (duplicateEntry) {
        const merged = mergeDuplicateCaptionEntry(duplicateEntry, {
          name: speakerName,
          text: cleanText,
          source: _source || 'captions',
          rtcVersion: messageVersion
        });
        markMeetCaptionActivity(_source || 'rtc-dedupe');
        mtLog('meet-caption:dedupe-merged-entry', {
          messageId: messageId,
          existingId: duplicateEntry.id,
          merged: merged,
          messageVersion: messageVersion,
          speakerName: duplicateEntry.name,
          textLength: duplicateEntry.text.length
        });
        if (merged) {
          saveTranscript();
          refreshUI();
        }
        return;
      }

      upsertCaptionBufferEvent({
        id: messageId,
        source: _source || 'captions',
        speakerName: speakerName,
        text: cleanText,
        isFinal: true
      });
      transcript.push({
        id: messageId,
        name: speakerName,
        text: cleanText,
        _source: _source || 'captions',
        _timestamp: Date.now(),
        _rtcVersion: messageVersion
      });
      markMeetCaptionActivity(_source || 'rtc-new');
      mtLog('meet-caption:new-entry', {
        messageId: messageId,
        messageVersion: messageVersion,
        speakerName: speakerName,
        textLength: cleanText.length,
        transcriptLength: transcript.length
      });
      saveTranscript();
    }
  });
}

// ── Zoom: Caption capture from DOM monitoring ──────────────────
//
// Zoom captions are parsed from DOM mutations rather than WebRTC channels.
// The zoom-capture.js (MAIN world) monitors #live-transcription-subtitle
// and dispatches __mt_zoom_caption events with deduplication.
//
if (PLATFORM === 'zoom') {
  var zoomSeenCaptions = {}; // Track seen captions by normalized speaker+text to prevent duplicates

  document.addEventListener('__mt_zoom_caption', (evt) => {
    if (!isRecording) return;
    const { speaker, text, timestamp } = evt.detail || {};

    if (!text || !speaker) {
      mtWarn('zoom-caption:skip-missing-required', {
        hasText: !!text,
        hasSpeaker: !!speaker
      });
      return;
    }

    let cleanText = sanitizeSpeechText(speaker, text.trim());
    cleanText = applyLiveQualityFilters(cleanText);
    if (!cleanText) return;

    // Create normalized key for deduplication
    const normalizedKey = (speaker + '|' + cleanText).toLowerCase();
    const lastSeenTime = zoomSeenCaptions[normalizedKey];
    const now = Date.now();

    // Skip if we've seen this exact speaker+text within the last 3 seconds
    if (lastSeenTime && now - lastSeenTime < 3000) {
      mtLog('zoom-caption:skip-recent-duplicate', {
        speaker: speaker,
        textPreview: cleanText.substring(0, 40),
        msSinceLastSeen: now - lastSeenTime
      });
      return;
    }

    // Update last seen time for this caption
    zoomSeenCaptions[normalizedKey] = now;

    // Buzz-like "append and correct":
    // 1) if new text is an extension of the latest speaker line, update last line
    // 2) if new text is shorter regression, ignore it to avoid overwrite flicker
    const lastEntry = transcript[transcript.length - 1];
    if (
      lastEntry &&
      lastEntry._source === 'zoom-dom' &&
      lastEntry.name === speaker &&
      typeof lastEntry.text === 'string'
    ) {
      const ageMs = now - (lastEntry._timestamp || 0);
      const correctionWindowMs = 8000;

      if (ageMs <= correctionWindowMs) {
        // New hypothesis extends previous one: keep a single clean line.
        if (cleanText.length > lastEntry.text.length && cleanText.startsWith(lastEntry.text)) {
          const oldLength = lastEntry.text.length;
          lastEntry.text = cleanText;
          lastEntry._timestamp = timestamp;
          mtLog('zoom-caption:append-and-correct:update-last', {
            speaker: speaker,
            oldLength: oldLength,
            newLength: cleanText.length
          });
          saveTranscript();
          return;
        }

        // Transient shorter hypothesis: ignore to avoid replacing a better line.
        if (lastEntry.text.length > cleanText.length && lastEntry.text.startsWith(cleanText)) {
          mtLog('zoom-caption:append-and-correct:ignore-regression', {
            speaker: speaker,
            previousLength: lastEntry.text.length,
            incomingLength: cleanText.length
          });
          return;
        }
      }
    }

    // Use speaker + normalized text as ID (stable dedupe for finalized lines)
    const textHash = Math.abs(normalizedKey.split('').reduce((a, c) => a * 31 + c.charCodeAt(0), 0)).toString(36);
    const entryId = `zoom-${textHash}`;
    const existing = transcript.find(e => e.id === entryId);

    if (!existing) {
      transcript.push({
        id: entryId,
        name: speaker,
        text: cleanText,
        _source: 'zoom-dom',
        _timestamp: timestamp
      });
      mtLog('zoom-caption:new-entry', {
        speaker: speaker,
        textLength: cleanText.length,
        transcriptLength: transcript.length
      });
      saveTranscript();
    } else {
      mtLog('zoom-caption:duplicate-entry-ignored', {
        speaker: speaker,
        textPreview: cleanText.substring(0, 40),
        entryId: entryId
      });
    }
  });

  document.addEventListener('__mt_zoom_transcription_status', (evt) => {
    const { isActive, menuVisible, timestamp } = evt.detail || {};
    mtLog('zoom-transcription-status:changed', {
      isActive: isActive,
      menuVisible: menuVisible,
      timestamp: timestamp
    });
    // Could trigger auto-start if transcription not active and recording started
    // (conditional on user preference in future)
  });
}

// ── Google Meet: Visual Hide + Recovery ───────────────────────
//
// IMPORTANT:
//   Do not auto-click Meet's captions toggle. Users can close captions
//   manually and the extension should respect that choice.
//
//   Capture reliability is handled by RTC/DataChannel interception and
//   recovery events below, not by forcing the captions UI state.
//
const MEET_CAPTION_HIDE_STYLE_ID = '__mt-caption-hide';
const MEET_CAPTION_LABEL_HINTS = [
  'caption', 'subtit', 'субтит', 'титр', 'napis', 'legenda', 'untertitel', 'sous-titre', '字幕'
];

function injectMeetCaptionHideStyle() {
  // Do not style Meet's native caption bar. On current Meet builds compacting
  // .a4cQT can leave a persistent black overlay and break normal CC toggling.
  // Capture is kept alive by the MAIN-world RTC captions channel instead.
  removeMeetCaptionHideStyle();
}

function removeMeetCaptionHideStyle() {
  const style = document.getElementById(MEET_CAPTION_HIDE_STYLE_ID);
  if (style) {
    style.remove();
    mtLog('caption-keeper:hide-style-removed');
  }
}

function normalizeMeetLabel(value) {
  return String(value || '').trim().toLowerCase();
}

function getMeetControlLabel(el) {
  if (!el) return '';
  return normalizeMeetLabel(
    el.getAttribute('aria-label') ||
    el.getAttribute('data-tooltip') ||
    el.getAttribute('title') ||
    el.textContent ||
    ''
  );
}

function isMeetCaptionsToggleCandidate(el) {
  const label = getMeetControlLabel(el);
  if (!label) return false;
  return MEET_CAPTION_LABEL_HINTS.some(token => label.includes(token));
}

function getMeetCaptionsToggleButton() {
  const controls = document.querySelectorAll('button, [role="button"]');
  for (const el of controls) {
    if (isMeetCaptionsToggleCandidate(el)) return el;
  }
  return null;
}

function isMeetCaptionsEnabled(btn) {
  if (!btn) return null;
  const ariaPressed = btn.getAttribute('aria-pressed');
  if (ariaPressed === 'true') return true;
  if (ariaPressed === 'false') return false;

  const label = getMeetControlLabel(btn);
  if (!label) return null;

  // When captions bar is extension-styled, Meet's label can become unreliable.
  // Avoid false toggles from label-only state.
  if (document.getElementById(MEET_CAPTION_HIDE_STYLE_ID)) return null;

  // "turn on/show" => currently off, "turn off/hide" => currently on.
  if (/turn on captions|enable captions|show captions|включить .*субтитр|показать .*субтитр|włącz napisy|字幕をオン/.test(label)) return false;
  if (/turn off captions|disable captions|hide captions|выключить .*субтитр|скрыть .*субтитр|wyłącz napisy|字幕をオフ/.test(label)) return true;

  return null;
}

function clearMeetCaptionBootstrapTimer() {
  if (!meetCaptionBootstrapTimer) return;
  clearInterval(meetCaptionBootstrapTimer);
  meetCaptionBootstrapTimer = null;
}

// Re-enable server-side captions (e.g. after showing the bar, or after a drop).
// Uses suppressNextMeetCaptionToggleClick so our click interceptor ignores it.
function ensureMeetCaptionsEnabled(options = {}) {
  const btn = getMeetCaptionsToggleButton();
  if (!btn) return false;
  const enabled = isMeetCaptionsEnabled(btn);
  if (enabled !== false && !options.forceClick) return false;
  suppressNextMeetCaptionToggleClick = true;
  meetCaptionEnabledByBootstrap = true;
  try {
    // button.click() dispatches synchronously; release guard immediately after.
    btn.click();
  } finally {
    suppressNextMeetCaptionToggleClick = false;
  }
  mtLog('caption-keeper:ensure-enabled:clicked', {
    forced: !!options.forceClick,
    detectedEnabled: enabled
  });
  return true;
}

function tryEnableMeetCaptionsOnRecordingStart(trigger) {
  if (PLATFORM !== 'meet') return;
  if (!isRecording) return;
  // Always bootstrap when overlay-hidden mode is on (capture depends on captions being enabled).
  // Also bootstrap if the user explicitly requested it via the toggle.
  if (!meetTryEnableCaptionsOnStart && !meetCaptionOverlayHidden) return;
  if (meetCaptionBootstrapAttemptedForSession) return;

  meetCaptionBootstrapAttemptedForSession = true;
  clearMeetCaptionBootstrapTimer();

  let attempts = 0;
  const maxAttempts = 8;

  function finish(status, detail) {
    clearMeetCaptionBootstrapTimer();
    if ((status === 'already-enabled' || status === 'clicked-enable') && meetCaptionOverlayHidden && !meetCaptionManualVisible) {
      injectMeetCaptionHideStyle();
      window.dispatchEvent(new Event('resize'));
    }
    mtLog('caption-bootstrap:' + status, {
      trigger: trigger,
      attempts: attempts,
      ...(detail || {})
    });
  }

  meetCaptionBootstrapTimer = setInterval(() => {
    attempts += 1;

    if (!isRecording) {
      finish('stopped');
      return;
    }

    const inMeeting = !!document.querySelector(
      'button[aria-label*="Leave call" i], button[aria-label*="Leave meeting" i], ' +
      'button[aria-label*="встречу" i], button[aria-label*="Покинуть" i], ' +
      '[data-idom-class*="leave" i]'
    );

    if (!inMeeting) {
      if (attempts >= maxAttempts) finish('meeting-ui-not-ready');
      return;
    }

    const ccBtn = getMeetCaptionsToggleButton();
    if (!ccBtn) {
      if (attempts >= maxAttempts) finish('button-not-found');
      return;
    }

    const captionsEnabled = isMeetCaptionsEnabled(ccBtn);
    if (captionsEnabled === true) {
      meetCaptionEnabledByBootstrap = false;
      finish('already-enabled');
      return;
    }

    if (captionsEnabled === false) {
      meetCaptionEnabledByBootstrap = true;
      suppressNextMeetCaptionToggleClick = true;
      try {
        // Same as above: keep the bypass window only for this sync click.
        ccBtn.click();
      } finally {
        suppressNextMeetCaptionToggleClick = false;
      }
      finish('clicked-enable', {
        btnLabel: ccBtn.getAttribute('aria-label') || '',
        btnJsname: ccBtn.getAttribute('jsname') || '',
        ariaPressed: ccBtn.getAttribute('aria-pressed')
      });
      return;
    }

    if (attempts >= maxAttempts) {
      finish('state-ambiguous-skip', {
        btnLabel: ccBtn.getAttribute('aria-label') || '',
        btnJsname: ccBtn.getAttribute('jsname') || '',
        ariaPressed: ccBtn.getAttribute('aria-pressed')
      });
    }
  }, 1000);
}

if (PLATFORM === 'meet') {
  let lastMeetRecoveryAt = 0;
  let meetSoftRecoverCount = 0;
  let lastMeetForcedRecoveryAt = 0;

  document.addEventListener('click', (evt) => {
    if (!isRecording) return;

    const target = evt.target;
    if (!(target instanceof Element)) return;

    const ccBtn = target.closest('button, [role="button"]');
    if (!ccBtn || !isMeetCaptionsToggleCandidate(ccBtn)) return;
    if (suppressNextMeetCaptionToggleClick) return;

    if (meetCaptionOverlayHidden) {
      // Let the native Meet CC button work normally. RTC capture is independent
      // from the visual overlay, and blocking this click traps users with an
      // unclosable caption bar on current Meet builds.
      setTimeout(() => {
        const enabled = isMeetCaptionsEnabled(ccBtn);
        meetCaptionEnabledByBootstrap = false;
        meetCaptionManualVisible = enabled !== false;
        mtLog('caption-keeper:native-toggle-tracked', { enabled });
      }, 120);
      return;
    }

    // meetCaptionOverlayHidden is false — user sees native captions, allow the
    // click through and just track the resulting state.
    setTimeout(() => {
      const enabled = isMeetCaptionsEnabled(ccBtn);
      if (enabled === true) {
        meetCaptionEnabledByBootstrap = false;
        meetCaptionManualVisible = true;
        mtLog('caption-keeper:manual-visible-on');
      } else if (enabled === false) {
        meetCaptionEnabledByBootstrap = false;
        meetCaptionManualVisible = false;
        mtLog('caption-keeper:manual-visible-off');
      } else {
        // aria-pressed/label ambiguous — use DOM presence as tiebreaker.
        const captionDomOpen = !!document.querySelector(
          'div[jsname="W297wb"], .iY996, .V006ub, .nMcdL, [jsname="YSZ4cc"], [jsname="Vpvi7b"]'
        );
        meetCaptionEnabledByBootstrap = false;
        meetCaptionManualVisible = captionDomOpen;
        mtLog('caption-keeper:manual-visible-dom-fallback', { captionDomOpen });
      }
    }, 120);
  }, true);

  document.addEventListener('__mt_meet_caption', () => {
    meetSoftRecoverCount = 0;
  });

  document.addEventListener('__mt_meet_channel_state', (evt) => {
    if (!isRecording) return;

    const detail = (evt && evt.detail) || {};
    if (detail.label !== 'captions') return;

    mtLog('meet-capture:channel-state', detail);

    if (detail.state !== 'close') return;

    const now = Date.now();
    if (now - lastMeetRecoveryAt < 3000) return;
    lastMeetRecoveryAt = now;

    setTimeout(() => {
      if (!isRecording) return;

      // Reattach the RTC channel. Do not force-click Meet's CC button while the
      // user is allowed to close native captions; that would reopen the visual
      // overlay immediately after they close it.
      const clicked = meetCaptionOverlayHidden
        ? false
        : ensureMeetCaptionsEnabled({ forceClick: false });
      mtWarn('caption-keeper:on-channel-close', {
        clicked: clicked,
        overlayHidden: meetCaptionOverlayHidden,
        channel: detail
      });

      document.dispatchEvent(new CustomEvent('__mt_meet_recover_capture', {
        detail: {
          reason: 'caption-channel-close',
          channel: detail,
          transcriptLength: transcript.length
        }
      }));
    }, 800);
  });

  setInterval(() => {
    if (!isRecording) {
      // Remove the hide overlay when not recording so the user can use
      // native captions independently.
      removeMeetCaptionHideStyle();
      return;
    }

    // Only act while we're confirmed to be inside an active call.
    const inMeeting = !!document.querySelector(
      'button[aria-label*="Leave call" i], button[aria-label*="Leave meeting" i], ' +
      'button[aria-label*="встречу" i], button[aria-label*="Покинуть" i], ' +
      '[data-idom-class*="leave" i]'
    );
    if (!inMeeting) {
      removeMeetCaptionHideStyle();
      return;
    }

    // Avoid race: while startup bootstrap is still deciding captions state,
    // do not force CSS visibility changes from the periodic loop.
    if (meetCaptionBootstrapTimer) return;

    // meetCaptionManualVisible is managed exclusively by the click interceptor.
    // Do NOT re-derive it from button state here: while the extension styles the
    // overlay, Meet can report a misleading captions label and override the
    // user's explicit toggle choice.
    if (meetCaptionOverlayHidden && !meetCaptionManualVisible) {
      injectMeetCaptionHideStyle();
    } else {
      removeMeetCaptionHideStyle();
    }
  }, 1500);

  setInterval(() => {
    if (!isRecording) return;

    const inMeeting = !!document.querySelector(
      'button[aria-label*="Leave call" i], button[aria-label*="Leave meeting" i], ' +
      'button[aria-label*="встречу" i], button[aria-label*="Покинуть" i], ' +
      '[data-idom-class*="leave" i]'
    );
    if (!inMeeting) return;

    // While bootstrap is in progress, let it own captions state.
    if (meetCaptionBootstrapTimer) return;

    const now = Date.now();
    const inactivityMs = now - lastMeetCaptionActivityAt;
    if (inactivityMs < 12000) return;
    if (now - lastMeetRecoveryAt < 12000) return;

    lastMeetRecoveryAt = now;
    meetSoftRecoverCount += 1;

    mtWarn('meet-capture:inactivity-watchdog-recover', {
      inactivityMs: inactivityMs,
      transcriptLength: transcript.length
    });

    document.dispatchEvent(new CustomEvent('__mt_meet_recover_capture', {
      detail: {
        reason: 'caption-inactivity',
        inactivityMs: inactivityMs,
        transcriptLength: transcript.length
      }
    }));

    // Escalation path (Tactiq-like): if soft recovery repeats and stream is
    // still stalled, request forced RTC rotation in MAIN world.
    if (meetSoftRecoverCount >= 2 && inactivityMs >= 30000 && now - lastMeetForcedRecoveryAt > 30000) {
      lastMeetForcedRecoveryAt = now;
      mtWarn('meet-capture:forced-rtc-recovery', {
        inactivityMs: inactivityMs,
        softRecoverCount: meetSoftRecoverCount,
        transcriptLength: transcript.length
      });

      document.dispatchEvent(new CustomEvent('__mt_meet_force_rtc_reconnect', {
        detail: {
          reason: 'caption-inactivity-escalation',
          inactivityMs: inactivityMs,
          softRecoverCount: meetSoftRecoverCount,
          transcriptLength: transcript.length
        }
      }));
    }
  }, 3000);
}

// ── Teams WebRTC Caption Fallback ───────────────────────────
// When the Teams caption panel is closed the DOM emits no mutations.
// teams-capture.js (MAIN world) intercepts the WebRTC main-channel and
// dispatches __mt_teams_caption events so we can still capture speech.
if (PLATFORM === 'teams') {
  document.addEventListener('__mt_teams_caption', (evt) => {
    if (!isRecording) return;

    // Only use this path when the DOM caption panel is absent.
    // When the panel is open, our MutationObserver already handles it.
    const domPanelActive = !!document.querySelector(
      '[data-tid="closed-captions-v2-items-renderer"], [data-tid="closed-caption-renderer-wrapper"]'
    );
    if (domPanelActive) {
      mtLog('teams-caption:fallback-skip-dom-panel-active');
      return;
    }

    const { userId, text, messageId } = evt.detail || {};
    if (!text || !messageId) {
      mtWarn('teams-caption:skip-missing-required', {
        hasText: !!text,
        hasMessageId: !!messageId,
        userId: userId
      });
      return;
    }

    // Deduplicate by messageId
    if (transcript.find(e => e.id === messageId)) {
      mtLog('teams-caption:skip-duplicate', { messageId: messageId });
      return;
    }

    // Try to resolve speaker name from Teams participant tiles.
    // Teams often stores the MRI in data-mri / data-user-id on roster elements.
    let speakerName = resolveTeamsSpeakerFromDom(userId);

    transcript.push({ id: messageId, name: speakerName, text });
    mtLog('teams-caption:new-entry', {
      messageId: messageId,
      userId: userId,
      speakerName: speakerName,
      textLength: text.length,
      transcriptLength: transcript.length
    });
    saveTranscript();
  });
}

/**
 * Attempt to map a Teams userId (MRI like "8:orgid:...") to a display name
 * by scanning participant/roster DOM elements that Teams renders.
 * Falls back to "Speaker" when no match is found.
 */
function resolveTeamsSpeakerFromDom(userId) {
  if (!userId) return 'Speaker';

  // Teams video gallery tiles and roster entries sometimes carry data-mri
  const candidates = document.querySelectorAll('[data-mri], [data-user-id]');
  mtLog('resolveTeamsSpeakerFromDom:start', { userId: userId, candidates: candidates.length });
  for (const el of candidates) {
    const mri = el.getAttribute('data-mri') || el.getAttribute('data-user-id') || '';
    if (mri && userId.includes(mri) || mri.includes(userId)) {
      const nameEl = el.querySelector('[class*="name" i], [data-tid*="name" i]') || el;
      const name = (nameEl.textContent || '').trim();
      if (name && name.length > 1 && name.length < 80) {
        mtLog('resolveTeamsSpeakerFromDom:resolved', { userId: userId, mri: mri, speakerName: name });
        return name;
      }
    }
  }

  // Last-resort: show a shortened form of the userId so the user can tell
  // speakers apart even without resolved names.
  const shortId = userId.split(':').pop() || userId;
  const fallbackName = 'Speaker (' + shortId.slice(-6) + ')';
  mtWarn('resolveTeamsSpeakerFromDom:fallback', { userId: userId, fallbackName: fallbackName });
  return fallbackName;
}

// ── Floating Widget (Shadow DOM) ────────────────────────────

function injectWidget() {
  if (widgetHost && document.body.contains(widgetHost)) {
    mtLog('widget-inject:skip-already-present');
    return;
  }

  mtLog('widget-inject:start');

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
      bottom: 48px;
      z-index: 999999;
      width: 18px;
      height: 42px;
      border: none;
      border-radius: 6px 0 0 6px;
      cursor: pointer;
      display: none; /* hidden by default — shown only when sidebarEnabled */
      align-items: center;
      justify-content: center;
      background: rgba(71, 85, 105, 0.50);
      color: rgba(203, 213, 225, 0.70);
      font-size: 10px;
      box-shadow: -1px 1px 6px rgba(0,0,0,.30);
      transition: all .2s ease;
      outline: none;
    }
    .toggle-btn:hover {
      width: 22px;
      background: rgba(100, 116, 139, 0.75);
      color: #e2e8f0;
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
    .source-stats {
      margin-top: 6px;
      font-size: 11px;
      color: #7dd3fc;
      opacity: .95;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
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
        <div class="source-stats" id="sourceStats">src/min: -</div>
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
  const sourceStatsEl = shadow.getElementById('sourceStats');
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

  // Expose to message bridge so popup-triggered start can close the panel
  window.__meetTranscriberSetPanelOpen = (v) => setPanelOpen(v);

  togglePanelBtn.addEventListener('click', () => {
    setPanelOpen(!panelOpen);
  });

  toggleRecordBtn.addEventListener('click', () => {
    debugDevLog('record-button-click', `storageStateInitialized=${storageStateInitialized}, isRecording=${isRecording}`);
    
    const newState = !isRecording;
    isRecording = newState;
    
    if (isRecording) {
      // Start of a new session
      currentSessionId = Date.now().toString();
      // Clear transcript for a fresh start if it wasn't already cleared
      transcript = [];
      meetCaptionManualVisible = false;
      meetCaptionEnabledByBootstrap = false;
      meetCaptionBootstrapAttemptedForSession = false;
      clearMeetCaptionBootstrapTimer();
      ensureCaptionObserverAttached();
      setScopedRecordingState(true, []);
      tryEnableMeetCaptionsOnRecordingStart('widget-toggle');
      setPanelOpen(false);
      debugDevLog('record-start', `sessionId=${currentSessionId}`);
    } else {
      // End of session - finalize and save to history
      finalizeSession();
      // We clear the active transcript after saving to history
      transcript = [];
      meetCaptionManualVisible = false;
      meetCaptionEnabledByBootstrap = false;
      meetCaptionBootstrapAttemptedForSession = false;
      clearMeetCaptionBootstrapTimer();
      if (PLATFORM === 'meet') {
        removeMeetCaptionHideStyle();
        window.dispatchEvent(new Event('resize'));
      }
      setScopedRecordingState(false, []);
      currentSessionId = null;
      debugDevLog('record-stop', 'recording stopped');
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
    // Sidebar button visibility (driven by sidebarEnabled setting)
    togglePanelBtn.style.display = sidebarEnabled ? 'flex' : 'none';
    if (!sidebarEnabled && panelOpen) setPanelOpen(false);

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

    if (PLATFORM === 'meet') {
      const stats = getMeetSourceStatsSnapshot();
      const lastSwitchSec = stats.lastSwitchAgoMs == null ? '-' : Math.floor(stats.lastSwitchAgoMs / 1000) + 's';
      sourceStatsEl.textContent =
        `src/min c:${stats.epm.captions} m:${stats.epm.meet_messages} f:${stats.epm.create_meeting_message} | last:${stats.lastSource || '-'} (${lastSwitchSec})`;
      sourceStatsEl.style.display = 'block';
    } else {
      sourceStatsEl.style.display = 'none';
    }

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

    // Transcript preview (show last 50 entries, group consecutive same-speaker phrases)
    if (transcript.length === 0) {
      transcriptPreview.innerHTML = '<div class="transcript-empty">Нет записей</div>';
    } else {
      const last = transcript.slice(-50);
      // Merge consecutive entries from the same speaker into one block
      const grouped = [];
      last.forEach(e => {
        const prev = grouped[grouped.length - 1];
        if (prev && prev.name === e.name) {
          prev.texts.push(e.text);
        } else {
          grouped.push({ name: e.name, texts: [e.text] });
        }
      });
      transcriptPreview.innerHTML = grouped.map(g =>
        `<div class="transcript-entry">
          <div class="speaker">${escapeHTML(g.name)}</div>
          ${g.texts.map(t => `<div class="text">${escapeHTML(t)}</div>`).join('')}
        </div>`
      ).join('');
      // Auto-scroll to bottom
      transcriptPreview.scrollTop = transcriptPreview.scrollHeight;
    }
  };

  // Sync UI immediately with current in-memory state (handles late injection).
  refreshUI();
  mtLog('widget-inject:complete');
}

function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function refreshUI() {
  if (typeof window.__meetTranscriberRefreshUI === 'function') {
    mtLog('refreshUI:invoke');
    window.__meetTranscriberRefreshUI();
  } else {
    mtWarn('refreshUI:skip-no-widget-hook');
  }
}

// Inject the widget once the page is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    mtLog('dom-ready:DOMContentLoaded');
    ensureWidgetState();
    ensureCaptionObserverAttached();
  });
} else {
  mtLog('dom-ready:already-ready', { readyState: document.readyState });
  ensureWidgetState();
  ensureCaptionObserverAttached();
}

window.addEventListener('popstate', ensureWidgetState);
window.addEventListener('hashchange', ensureWidgetState);
setInterval(() => {
  mtLog('periodic-ui-check');
  ensureWidgetState();
  ensureCaptionObserverAttached();
}, 2000);
