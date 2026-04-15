// ============================================================
// Meet Transcriber — Content Script
// Captures Google Meet captions + provides a floating in-page UI
// ============================================================

let isRecording = false;
let transcript = []; // Array of { id: string, name: string, text: string }
let currentSessionId = null;

// Extract meeting code from URL
function getMeetingCode() {
  const match = window.location.pathname.match(/\/([a-z]{3}-[a-z]{4}-[a-z]{3})/);
  return match ? match[1] : 'unknown';
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

// ── Persistence ─────────────────────────────────────────────
chrome.storage.local.get(['isRecording', 'transcript'], (res) => {
  if (res.isRecording !== undefined) isRecording = res.isRecording;
  if (res.transcript) transcript = res.transcript;
  refreshUI();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') {
    if (changes.isRecording !== undefined) {
      isRecording = changes.isRecording.newValue;
    }
    if (changes.transcript !== undefined) {
      transcript = changes.transcript.newValue;
    }
    refreshUI();
  }
});

let saveTimeout;
function saveTranscript() {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    chrome.storage.local.set({ transcript });
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
  
  // Send to background for persistent storage
  try {
    chrome.runtime.sendMessage({ type: 'SAVE_SESSION', session });
  } catch (e) {
    // Extension context may be invalidated, save directly
    chrome.storage.local.get(['sessions'], (res) => {
      const sessions = res.sessions || [];
      const idx = sessions.findIndex(s => s.id === session.id);
      if (idx >= 0) sessions[idx] = session;
      else sessions.unshift(session);
      if (sessions.length > 50) sessions.length = 50;
      chrome.storage.local.set({ sessions });
    });
  }
}

// Auto-save when leaving the page or meeting ends
function stopAndSave() {
  if (!isRecording) return;
  finalizeSession();
  isRecording = false;
  chrome.storage.local.set({ isRecording: false, transcript: [] });
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

    // 2. Check if meeting ended (Leave button gone or "You left" screen appears)
    const leaveBtn = document.querySelector('[aria-label*="Leave"], [aria-label*="встречу"], [aria-label*="Покинуть"]');
    const endedScreen = document.querySelector('[data-termination-message], .V006ub, .J57M8c'); 
    
    // If the meeting UI is gone but we are still "recording", stop it.
    // We check if either the leave button is gone OR the end screen is visible.
    // Note: We check for leaveBtn ONLY if some other meeting elements are also missing to avoid false positives during loading.
    const meetingContainer = document.querySelector('.view-container, .wrapper, .a4cQT');
    
    if ((!leaveBtn && !meetingContainer) || endedScreen) {
      console.log('Meet Transcriber: Meeting end detected. Saving and stopping.');
      stopAndSave();
    }
  }
}, 3000);

const captionObserver = new MutationObserver((mutations) => {
  if (!isRecording) return;

  const processedContainers = new Set();

  for (const mutation of mutations) {
    let target = mutation.target;
    let element = target.nodeType === Node.ELEMENT_NODE ? target : target.parentElement;
    if (!element) continue;

    // Search for the wrapper that contains speech (and hopefully speaker)
    // We look for common Meet caption segment containers
    const container = element.closest('div[jsname="W297wb"], .iY996, .V006ub, .nS7Zeb, .nMcdL, [jsname="YSZ4cc"]');
    if (!container) continue;
    
    // We want the HIGHEST level container that still represents this specific speaker block
    const blockContainer = container.closest('div[jsname="W297wb"], .iY996, .V006ub, .nS7Zeb') || container;
    
    if (processedContainers.has(blockContainer)) continue;
    processedContainers.add(blockContainer);

    // Find speaker and text elements
    const nameEl = blockContainer.querySelector('.KcIKyf, .adE6rb, .NWpY1d, [jsname="IT69ne"]');
    const textEl = blockContainer.querySelector('.nMcdL, .ygicle, [jsname="YSZ4cc"], [jsname="Vpvi7b"]');

    if (textEl) {
      let speechText = textEl.textContent.trim();
      if (!speechText) continue;

      let speakerName = nameEl ? nameEl.textContent.trim() : "";
      
      // Resolve "You/Вы" or missing names to real name
      if (!speakerName || speakerName === "Вы" || speakerName === "You" || !isRealName(speakerName)) {
        const discoveredName = getUserRealName();
        if (discoveredName) {
          speakerName = discoveredName;
        } else {
          speakerName = speakerName || "Speaker";
        }
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
          saveTranscript();
        }
      } else {
        transcript.push({ id: blockId, name: speakerName, text: speechText });
        saveTranscript();
      }
    }
  }
});

captionObserver.observe(document.body, { childList: true, subtree: true, characterData: true });

// ── Floating Widget (Shadow DOM) ────────────────────────────

function injectWidget() {
  const host = document.createElement('div');
  host.id = 'meet-transcriber-host';
  document.body.appendChild(host);

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
        <h2>📝 Meet Transcriber</h2>
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

  let panelOpen = false;

  togglePanelBtn.addEventListener('click', () => {
    panelOpen = !panelOpen;
    panel.classList.toggle('open', panelOpen);
    togglePanelBtn.classList.toggle('open', panelOpen);
    if (panelOpen) refreshUI();
  });

  toggleRecordBtn.addEventListener('click', () => {
    const newState = !isRecording;
    isRecording = newState;
    
    if (isRecording) {
      // Start of a new session
      currentSessionId = Date.now().toString();
      // Clear transcript for a fresh start if it wasn't already cleared
      transcript = []; 
      chrome.storage.local.set({ isRecording: true, transcript: [] });
    } else {
      // End of session - finalize and save to history
      finalizeSession();
      // We clear the active transcript after saving to history
      transcript = [];
      chrome.storage.local.set({ isRecording: false, transcript: [] });
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
      chrome.storage.local.set({ transcript: [] });
      refreshUI();
    }
  });

  // ── Expose refreshUI globally within this script ──
  window.__meetTranscriberRefreshUI = function () {
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
  document.addEventListener('DOMContentLoaded', injectWidget);
} else {
  injectWidget();
}
