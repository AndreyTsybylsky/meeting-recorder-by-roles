// ============================================================
// Meet Transcriber — Popup (Session History)
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
  const contentEl = document.getElementById('content');
  const previewOverlay = document.getElementById('previewOverlay');
  const previewTitle = document.getElementById('previewTitle');
  const previewBody = document.getElementById('previewBody');
  const previewClose = document.getElementById('previewClose');

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

  function deleteSession(sessionId) {
    chrome.runtime.sendMessage({ type: 'DELETE_SESSION', sessionId }, () => {
      loadSessions();
    });
  }

  function escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }
});
