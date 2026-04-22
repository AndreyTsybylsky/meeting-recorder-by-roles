// ============================================================
// Meet Transcriber — Popup (Session History)
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
  const contentEl = document.getElementById('content');
  const previewOverlay = document.getElementById('previewOverlay');
  const previewTitle = document.getElementById('previewTitle');
  const previewBody = document.getElementById('previewBody');
  const previewClose = document.getElementById('previewClose');

  // Record strip elements
  const recordStrip = document.getElementById('recordStrip');
  const recordBtn = document.getElementById('recordBtn');
  const recordDot = document.getElementById('recordDot');

  // Sidebar toggle
  const sidebarToggle = document.getElementById('sidebarToggle');

  chrome.storage.local.get(['sidebarEnabled'], (res) => {
    sidebarToggle.checked = !!res.sidebarEnabled;
  });

  sidebarToggle.addEventListener('change', () => {
    chrome.storage.local.set({ sidebarEnabled: sidebarToggle.checked });
  });

  // Auto-record toggle (default ON — value is true when key absent)
  const autoRecordToggle = document.getElementById('autoRecordToggle');

  chrome.storage.local.get(['autoRecordEnabled'], (res) => {
    autoRecordToggle.checked = res.autoRecordEnabled !== undefined ? !!res.autoRecordEnabled : true;
  });

  autoRecordToggle.addEventListener('change', () => {
    chrome.storage.local.set({ autoRecordEnabled: autoRecordToggle.checked });
  });

  // ── Quick-record logic ──────────────────────────────────
  const MEETING_PATTERNS = [/meet\.google\.com/i, /teams\.microsoft\.com/i, /teams\.live\.com/i, /zoom\.us\/wc\//i];

  function isMeetingUrl(url) {
    return url ? MEETING_PATTERNS.some(p => p.test(url)) : false;
  }

  let activeMeetingTabId = null;

  function updateRecordStrip(isRecording, disabled) {
    if (activeMeetingTabId === null) {
      recordStrip.classList.remove('visible');
      return;
    }
    recordStrip.classList.add('visible');
    recordBtn.disabled = !!disabled;
    if (isRecording) {
      recordBtn.textContent = '⏹ Остановить запись';
      recordBtn.classList.add('recording');
      recordDot.classList.add('recording');
    } else {
      recordBtn.textContent = '⏺ Начать запись';
      recordBtn.classList.remove('recording');
      recordDot.classList.remove('recording');
    }
  }

  function queryRecordingState(tabId) {
    chrome.tabs.sendMessage(tabId, { type: 'GET_RECORDING_STATE' }, (response) => {
      if (chrome.runtime.lastError || !response) {
        // Content script not injected yet or tab doesn't support it
        activeMeetingTabId = null;
        updateRecordStrip(false, false);
        return;
      }
      activeMeetingTabId = tabId;
      updateRecordStrip(response.isRecording, !response.initialized);
    });
  }

  // Find active meeting tab
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    if (tab && isMeetingUrl(tab.url)) {
      queryRecordingState(tab.id);
    }
  });

  recordBtn.addEventListener('click', () => {
    if (activeMeetingTabId === null) return;
    recordBtn.disabled = true;
    chrome.tabs.sendMessage(activeMeetingTabId, { type: 'TOGGLE_RECORDING' }, (response) => {
      if (chrome.runtime.lastError || !response) {
        recordBtn.disabled = false;
        return;
      }
      updateRecordStrip(response.isRecording, false);
      // Reload session list after stopping
      if (!response.isRecording) setTimeout(loadSessions, 600);
    });
  });
  // ────────────────────────────────────────────────────────

  // Email modal elements
  const emailOverlay = document.getElementById('emailOverlay');
  const emailToInput = document.getElementById('emailTo');
  const emailCommentInput = document.getElementById('emailComment');
  const emailCancel = document.getElementById('emailCancel');
  const emailOpenDownloads = document.getElementById('emailOpenDownloads');
  const emailCopyPath = document.getElementById('emailCopyPath');
  const emailPathHint = document.getElementById('emailPathHint');
  const emailAttachHint = document.getElementById('emailAttachHint');
  const emailToast = document.getElementById('emailToast');
  const emailSendBtn = document.getElementById('emailSend');
  const MAIL_SYNC_TAG = '[[MR_SYNC_V1]]';
  let pendingEmailSession = null;
  let lastDownloadedPath = '';
  let copyStateResetTimer = null;
  let toastResetTimer = null;
  let pasteShortcut = 'Ctrl+V';
  let platformOs = 'win';

  chrome.runtime.getPlatformInfo((info) => {
    if (!info || !info.os) return;
    platformOs = info.os;
    if (info.os === 'mac') {
      pasteShortcut = 'Cmd+V';
    }
    updateAttachHintText();
  });

  updateAttachHintText();

  emailCancel.addEventListener('click', () => {
    emailOverlay.classList.remove('show');
    pendingEmailSession = null;
    resetCopyButtonState();
    hideToast();
  });

  emailOpenDownloads.addEventListener('click', () => {
    chrome.downloads.showDefaultFolder();
  });

  emailCopyPath.addEventListener('click', async () => {
    if (!lastDownloadedPath) {
      if (!pendingEmailSession) {
        emailPathHint.textContent = 'Откройте модалку для нужной сессии';
        showToast('Нет активной сессии для скачивания', true);
        return;
      }

      emailPathHint.textContent = 'Скачиваю файл и получаю путь...';
      const fullPath = await downloadTranscriptAndGetPath(pendingEmailSession, false);
      if (!fullPath) {
        showToast('Не удалось скачать файл или получить путь', true);
        return;
      }
      lastDownloadedPath = fullPath;
    }

    const copied = await copyToClipboard(lastDownloadedPath);
    emailPathHint.textContent = copied
      ? `Путь скопирован: ${lastDownloadedPath}`
      : 'Не удалось скопировать путь автоматически';
    if (copied) {
      setCopyButtonCopiedState();
      showToast(`Путь к файлу скопирован. В Gmail нажмите ${pasteShortcut}`);
    } else {
      showToast('Не удалось скопировать путь автоматически', true);
    }
  });

  emailSendBtn.addEventListener('click', () => {
    if (!pendingEmailSession) return;
    const to = emailToInput.value.trim();
    const comment = emailCommentInput.value.trim();
    sendSessionByEmail(pendingEmailSession, to, comment);
    emailOverlay.classList.remove('show');
    pendingEmailSession = null;
  });

  previewClose.addEventListener('click', () => {
    previewOverlay.classList.remove('show');
  });

  loadSessions();

  function loadSessions() {
    chrome.storage.local.get(['sessions'], (res) => {
      const sessions = res.sessions || [];
      render(sessions);
    });
  }

  function render(sessions) {
    if (sessions.length === 0) {
      contentEl.innerHTML = `
        <div class="empty">
          <div class="icon">📭</div>
          <div>Пока нет записанных сессий</div>
          <div style="margin-top:6px; font-size:11px; color:#475569;">
            Откройте Google Meet, включите субтитры и начните запись
          </div>
        </div>
      `;
      return;
    }

    const html = `<div class="session-list">${sessions.map(s => sessionCard(s)).join('')}</div>`;
    contentEl.innerHTML = html;

    // Bind events
    sessions.forEach(s => {
      const card = document.getElementById(`card-${s.id}`);
      if (!card) return;

      card.querySelector('.btn-download').addEventListener('click', () => downloadSession(s));
      card.querySelector('.btn-preview').addEventListener('click', () => previewSession(s));
      card.querySelector('.btn-email').addEventListener('click', () => openEmailModal(s));
      card.querySelector('.btn-delete').addEventListener('click', () => deleteSession(s.id));
    });
  }

  function sessionCard(s) {
    const date = new Date(s.date);
    const dateStr = date.toLocaleDateString('ru-RU', {
      day: '2-digit', month: '2-digit', year: 'numeric'
    });
    const timeStr = date.toLocaleTimeString('ru-RU', {
      hour: '2-digit', minute: '2-digit'
    });
    const speakerCount = new Set(s.transcript.map(t => t.name)).size;

    return `
      <div class="session-card" id="card-${s.id}">
        <div class="session-meta">
          <div>
            <div class="session-title">${escapeHTML(s.title || s.meetingCode)}</div>
            <div class="session-date">${dateStr} · ${timeStr}</div>
          </div>
        </div>
        <div class="session-stats">
          ${s.transcript.length} фраз · ${speakerCount} участник${speakerCount > 1 ? (speakerCount < 5 ? 'а' : 'ов') : ''}
        </div>
        <div class="session-actions">
          <button class="btn btn-download">⬇ Скачать</button>
          <button class="btn btn-preview">👁 Просмотр</button>
          <button class="btn btn-email">✉ Email</button>
          <button class="btn btn-delete">🗑</button>
        </div>
      </div>
    `;
  }

  function downloadSession(s) {
    const textContent = s.transcript.map(item => `${item.name}: ${item.text}`).join('\n\n');
    const blob = new Blob([textContent], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);

    const date = new Date(s.date);
    const ds = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

    const fileName = (s.title || `MR-Meet-${s.meetingCode}`).replace(/[<>:"/\\|?*]/g, '_') + '.txt';

    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function previewSession(s) {
    const date = new Date(s.date);
    const dateStr = date.toLocaleDateString('ru-RU', {
      day: '2-digit', month: '2-digit', year: 'numeric'
    });
    previewTitle.textContent = `${s.title || s.meetingCode} — ${dateStr}`;

    previewBody.innerHTML = s.transcript.map(item => `
      <div class="preview-speaker">${escapeHTML(item.name)}</div>
      <div class="preview-text">${escapeHTML(item.text)}</div>
    `).join('');

    previewOverlay.classList.add('show');
  }

  function openEmailModal(s) {
    pendingEmailSession = s;
    emailToInput.value = 'andrey.tsybulski@innowise.com';
    emailCommentInput.value = '';
    resetCopyButtonState();
    hideToast();
    emailPathHint.textContent = lastDownloadedPath
      ? `Последний файл: ${lastDownloadedPath}`
      : 'Путь к файлу будет скопирован автоматически после отправки';
    emailOverlay.classList.add('show');
    emailCommentInput.focus();
  }

  async function sendSessionByEmail(s, to, comment) {
    const date = new Date(s.date);
    const dateStr = date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const timeStr = date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    const title = s.title || s.meetingCode;
    const speakerCount = new Set(s.transcript.map(t => t.name)).size;
    const fileName = title.replace(/[<>:"/\\|?*]/g, '_') + '.txt';

    // Best-effort immediate copy while click gesture is still active.
    const likelyPath = buildLikelyDownloadPath(fileName);
    if (likelyPath && copyToClipboardSyncBestEffort(likelyPath)) {
      lastDownloadedPath = likelyPath;
      setCopyButtonCopiedState();
      showToast(`Путь скопирован. В Gmail нажмите ${pasteShortcut}`);
    }

    // 1. Open Gmail compose immediately to avoid popup lifecycle issues on macOS.
    const subject = `${MAIL_SYNC_TAG} Запись Meet: ${title} (${dateStr})`;
    let body = '';
    body += `${MAIL_SYNC_TAG}\n`;
    body += `MR_SESSION_ID: ${s.id || 'unknown'}\n\n`;
    if (comment) body += `${comment}\n\n`;
    body += `Встреча: ${title}\nДата: ${dateStr} в ${timeStr}\nУчастников: ${speakerCount} · Реплик: ${s.transcript.length}\n\nТранскрипт во вложении: ${fileName}`;

    const gmailUrl = `https://mail.google.com/mail/?view=cm&to=${encodeURIComponent(to)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    requestOpenUrlViaBackground(gmailUrl);

    // 2. Auto-download transcript as .txt and copy the full path when completed
    const fullPath = await downloadTranscriptAndGetPath(s, false);
    if (!fullPath) {
      emailPathHint.textContent = 'Ошибка скачивания файла';
    } else {
      lastDownloadedPath = fullPath;
      const copied = await copyToClipboard(fullPath);
      emailPathHint.textContent = copied
        ? `Путь скопирован: ${fullPath}`
        : `Файл скачан: ${fullPath}`;
      if (copied) {
        setCopyButtonCopiedState();
        showToast(`Путь к файлу скопирован. В Gmail нажмите ${pasteShortcut}`);
      } else {
        showToast('Файл скачан, но путь не удалось скопировать', true);
      }
    }

  }

  function deleteSession(sessionId) {
    chrome.runtime.sendMessage({ type: 'DELETE_SESSION', sessionId }, () => {
      loadSessions();
    });
  }

  function requestOpenUrlViaBackground(url) {
    chrome.runtime.sendMessage({ type: 'OPEN_URL', url }, (response) => {
      if (chrome.runtime.lastError || !response || !response.ok) {
        // Fallback for cases when service worker is temporarily unavailable.
        chrome.tabs.create({ url });
      }
    });
  }

  function escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  async function copyToClipboard(value) {
    if (!value) return false;

    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch (_) {
      const temp = document.createElement('textarea');
      temp.value = value;
      temp.setAttribute('readonly', '');
      temp.style.position = 'fixed';
      temp.style.left = '-9999px';
      document.body.appendChild(temp);
      temp.select();
      const copied = document.execCommand('copy');
      document.body.removeChild(temp);
      return copied;
    }
  }

  function copyToClipboardSyncBestEffort(value) {
    if (!value) return false;
    const temp = document.createElement('textarea');
    temp.value = value;
    temp.setAttribute('readonly', '');
    temp.style.position = 'fixed';
    temp.style.left = '-9999px';
    document.body.appendChild(temp);
    temp.select();
    const copied = document.execCommand('copy');
    document.body.removeChild(temp);
    return copied;
  }

  function buildLikelyDownloadPath(fileName) {
    if (!fileName) return '';
    if (platformOs === 'mac') return `~/Downloads/${fileName}`;
    return fileName;
  }

  function updateAttachHintText() {
    if (platformOs === 'mac') {
      emailAttachHint.innerHTML = '<strong>Mac:</strong> В Gmail: Cmd+Shift+G -> Cmd+V -> Enter';
      return;
    }

    emailAttachHint.innerHTML = '<strong>Windows:</strong> В окне выбора файла: Ctrl+L -> Ctrl+V -> Enter';
  }

  function downloadTranscriptAndGetPath(session, revealInFolder) {
    return new Promise((resolve) => {
      const title = session.title || session.meetingCode;
      const transcriptText = session.transcript.map(item => `${item.name}: ${item.text}`).join('\n\n');
      const blob = new Blob([transcriptText], { type: 'text/plain;charset=utf-8' });
      const fileUrl = URL.createObjectURL(blob);
      const fileName = title.replace(/[<>:"/\\|?*]/g, '_') + '.txt';

      chrome.downloads.download({
        url: fileUrl,
        filename: fileName,
        saveAs: false,
        conflictAction: 'uniquify'
      }, async (downloadId) => {
        URL.revokeObjectURL(fileUrl);
        if (chrome.runtime.lastError || !downloadId) {
          resolve('');
          return;
        }

        const completed = await waitForDownloadCompletion(downloadId, 45000);
        if (!completed) {
          resolve('');
          return;
        }

        if (revealInFolder) {
          chrome.downloads.show(downloadId);
        }

        chrome.downloads.search({ id: downloadId }, (items) => {
          const fullPath = items && items[0] && items[0].filename ? items[0].filename : '';
          resolve(fullPath || '');
        });
      });
    });
  }

  function waitForDownloadCompletion(downloadId, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;

      const finish = (ok) => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        chrome.downloads.onChanged.removeListener(onChanged);
        resolve(ok);
      };

      const onChanged = (delta) => {
        if (delta.id !== downloadId || !delta.state) return;
        if (delta.state.current === 'complete') finish(true);
        if (delta.state.current === 'interrupted') finish(false);
      };

      const timeout = setTimeout(() => finish(false), timeoutMs);
      chrome.downloads.onChanged.addListener(onChanged);

      // Fast path in case the download already completed before listener setup.
      chrome.downloads.search({ id: downloadId }, (items) => {
        const item = items && items[0];
        if (!item || !item.state) return;
        if (item.state === 'complete') finish(true);
        if (item.state === 'interrupted') finish(false);
      });
    });
  }

  function setCopyButtonCopiedState() {
    emailCopyPath.textContent = 'Скопировано';
    emailCopyPath.classList.add('copied');

    if (copyStateResetTimer) clearTimeout(copyStateResetTimer);
    copyStateResetTimer = setTimeout(() => {
      resetCopyButtonState();
    }, 2500);
  }

  function resetCopyButtonState() {
    emailCopyPath.textContent = 'Скопировать путь';
    emailCopyPath.classList.remove('copied');
  }

  function showToast(message, isError = false) {
    emailToast.textContent = message;
    emailToast.classList.add('show');
    emailToast.classList.toggle('error', isError);

    if (toastResetTimer) clearTimeout(toastResetTimer);
    toastResetTimer = setTimeout(() => {
      hideToast();
    }, 2800);
  }

  function hideToast() {
    emailToast.classList.remove('show', 'error');
    emailToast.textContent = '';
  }
});
