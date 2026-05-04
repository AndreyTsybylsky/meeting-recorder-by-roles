// ============================================================
// Zoom Transcription Capture — Runs in PAGE context (MAIN world)
//
// Objectives:
// 1. Detect and dispatch Zoom captions/transcription DOM mutations
// 2. Helper to locate and activate "Start transcription" menu
// 3. Debug telemetry for troubleshooting host permission issues
//
// Dispatches to document:
//   CustomEvent('__mt_zoom_caption', { detail: { speaker, text, timestamp } })
//   CustomEvent('__mt_zoom_transcription_status', { detail: { isActive, menuVisible } })
// ============================================================

(function () {
  if (window.__meetTranscriberZoomCapture) return;
  window.__meetTranscriberZoomCapture = true;

  function log(step, details) {
    if (details === undefined) {
      console.log('[MeetTranscriber][zoom-capture] ' + step);
      return;
    }
    console.log('[MeetTranscriber][zoom-capture] ' + step, details);
  }

  function warn(step, details) {
    if (details === undefined) {
      console.warn('[MeetTranscriber][zoom-capture] ' + step);
      return;
    }
    console.warn('[MeetTranscriber][zoom-capture] ' + step, details);
  }

  function dbg(step, details) {
    if (details === undefined) {
      console.debug('[MeetTranscriber][zoom-capture] ' + step);
      return;
    }
    console.debug('[MeetTranscriber][zoom-capture] ' + step, details);
  }

  function err(step, error) {
    console.error('[MeetTranscriber][zoom-capture] ' + step, error);
  }

  log('init', {
    url: window.location.href,
    hasZoomAPI: !!window.ZoomIntentAPI || !!window.ZoomAV,
    userAgent: navigator.userAgent.substring(0, 50)
  });

  // ═════════════════════════════════════════════════════════════════
  // 1. CAPTION CONTAINER MONITORING (DOM-based)
  // ═════════════════════════════════════════════════════════════════

  var lastCaptionTexts = {}; // Track multiple caption versions to avoid duplicates
  var captionMonitorActive = false;
  var systemMessagePatterns = [
    /turned on live transcription/i,
    /turned off live transcription/i,
    /started recording/i,
    /stopped recording/i,
    /has joined/i,
    /has left/i,
    /is now/i,
    /changed.*name/i,
    /new update available/i,
    /local data storage/i,
    /improve app performance/i,
    /not recommended on public/i,
    /clear data on logout/i,
    /disableenable/i,
    /weeklyupdate/i,
    /zoom workplace/i,
    /host tools/i,
    /ai companion/i,
    /participants/i,
    /mute\s*video/i
  ];

  function isSystemMessage(text) {
    if (!text) return false;
    for (var i = 0; i < systemMessagePatterns.length; i++) {
      if (systemMessagePatterns[i].test(text)) {
        return true;
      }
    }
    return false;
  }

  function normalizeText(text) {
    // Normalize for comparison: lowercase, collapse whitespace
    return (text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  function getZoomDocument() {
    var iframe = document.querySelector('#webclient') || document.querySelector('iframe');
    return iframe && iframe.contentDocument ? iframe.contentDocument : document;
  }

  function getVisibleRect(el) {
    if (!el || !el.getBoundingClientRect) return null;
    var rect = el.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    return rect;
  }

  function isUiContainer(el) {
    if (!el || !el.closest) return false;
    return !!el.closest([
      '[role="dialog"]',
      '[role="menu"]',
      '[role="navigation"]',
      '[class*="setting" i]',
      '[class*="chat" i]',
      '[class*="sidebar" i]',
      '[class*="notification" i]',
      '[class*="toast" i]',
      '[class*="popover" i]',
      '[class*="modal" i]',
      '[class*="menu" i]',
      '[class*="toolbar" i]'
    ].join(','));
  }

  function isLikelyCaptionElement(el) {
    var text = normalizeText(el && el.textContent);
    if (!text || text.length < 3 || text.length > 260) return false;
    if (isSystemMessage(text)) return false;
    if (isUiContainer(el)) return false;

    var rect = getVisibleRect(el);
    if (!rect) return false;

    var ownerDocument = el.ownerDocument || document;
    var ownerWindow = ownerDocument.defaultView || window;
    var viewportHeight = ownerWindow.innerHeight || ownerDocument.documentElement.clientHeight || 0;
    var viewportWidth = ownerWindow.innerWidth || ownerDocument.documentElement.clientWidth || 0;
    if (!viewportHeight || !viewportWidth) return false;

    // Zoom web captions render as a compact bubble in the lower half of the
    // meeting stage. This rejects settings panels and app-wide live regions.
    if (rect.top < viewportHeight * 0.50) return false;
    if (rect.bottom > viewportHeight - 24) return false;
    if (rect.width > viewportWidth * 0.86 || rect.height > viewportHeight * 0.30) return false;
    if (rect.left < 40 || rect.right > viewportWidth - 40) return false;

    return true;
  }

  function keepLeafCaptionElements(elements) {
    return elements.filter(function (el, idx) {
      for (var k = 0; k < elements.length; k++) {
        if (k === idx) continue;
        if (el.contains(elements[k]) && normalizeText(elements[k].textContent)) {
          return false;
        }
      }
      return true;
    });
  }

  function textSimilarity(a, b) {
    // Simple similarity check: if normalized texts match, they're similar
    return normalizeText(a) === normalizeText(b);
  }

  function startCaptionMonitor() {
    if (captionMonitorActive) return;
    captionMonitorActive = true;
    log('caption-monitor:start');

    // Zoom caption selectors (most reliable: #live-transcription-subtitle).
    // Keep this stricter than the content-script fallback: broad aria-live regions
    // can contain unrelated app notifications and cause transcript overwrites.
    var primaryCaptionSelectors = [
      '#live-transcription-subtitle',
      '.live-transcription-subtitle__box',
      '.live-transcription-subtitle__item',
      '[class*="live-transcription-subtitle" i]',
      '[class*="closed-caption" i]',
      '[class*="caption-subtitle" i]'
    ];
    var fallbackCaptionSelectors = [
      '[data-testid*="caption" i]',
      '.rcvideo-box .caption',
      '[class*="subtitle-item"]',
      '[class*="caption" i]',
      '[class*="subtitle" i]',
      '[id*="caption" i]',
      '[id*="subtitle" i]'
    ];

    function findCaptionElements() {
      var targetDocument = getZoomDocument();

      var transcriptonicTarget = targetDocument.querySelector('.live-transcription-subtitle__box');
      if (transcriptonicTarget && transcriptonicTarget.lastChild) {
        var lastText = normalizeText(transcriptonicTarget.lastChild.textContent);
        if (lastText && lastText.length >= 3 && lastText.length <= 260 && !isSystemMessage(lastText)) {
          return [transcriptonicTarget.lastChild];
        }
      }

      function collectFromSelectors(selectors) {
        var found = [];
        for (var i = 0; i < selectors.length; i++) {
          var selector = selectors[i];
          var nodeList = targetDocument.querySelectorAll(selector);
          for (var j = 0; j < nodeList.length; j++) {
            var el = nodeList[j];
            if (el && el.textContent && el.textContent.trim().length > 0 && isLikelyCaptionElement(el)) {
              found.push(el);
            }
          }
        }
        return keepLeafCaptionElements(found);
      }

      var elements = collectFromSelectors(primaryCaptionSelectors);
      if (elements.length > 0) return elements;

      elements = collectFromSelectors(fallbackCaptionSelectors);
      if (elements.length > 0) return elements;

      // Last resort: Tactiq-style DOM read of the visible caption bubble.
      // Zoom builds change class names often, so scan visible text nodes in
      // the lower meeting stage instead of trusting class names only.
      var all = targetDocument.body ? targetDocument.body.querySelectorAll('*') : [];
      var geometricMatches = [];
      for (var a = 0; a < all.length; a++) {
        var candidate = all[a];
        if (candidate && candidate.children && candidate.children.length > 8) continue;
        if (candidate && candidate.textContent && candidate.textContent.trim().length > 0 && isLikelyCaptionElement(candidate)) {
          geometricMatches.push(candidate);
        }
      }
      return keepLeafCaptionElements(geometricMatches);
    }

    // Polling approach with deduplication
    var checkInterval = setInterval(function () {
      try {
        var captionElements = findCaptionElements();
        var seenTexts = {};

        for (var i = 0; i < captionElements.length; i++) {
          var captionEl = captionElements[i];
          var text = captionEl.textContent.trim();
          var speaker = extractSpeaker(captionEl);

          if (!text) continue;

          // Filter out system messages
          if (isSystemMessage(text)) {
            dbg('caption:skip-system-message', { text: text.substring(0, 50) });
            continue;
          }

          var normalizedText = normalizeText(text);
          var compositeKey = speaker + '|' + normalizedText;

          // Skip if we've already seen this exact speaker+text combo in this check cycle
          if (seenTexts[compositeKey]) {
            dbg('caption:skip-duplicate-in-cycle', { speaker: speaker, text: text.substring(0, 50) });
            continue;
          }
          seenTexts[compositeKey] = true;

          // Skip if we've recently seen this text (within last 2 seconds)
          var lastSeen = lastCaptionTexts[compositeKey];
          var timeSinceLastSeen = lastSeen ? Date.now() - lastSeen : Infinity;
          if (timeSinceLastSeen < 2000) {
            dbg('caption:skip-too-recent', { speaker: speaker, text: text.substring(0, 50), msSinceLastSeen: timeSinceLastSeen });
            continue;
          }

          // This is a new/updated caption
          lastCaptionTexts[compositeKey] = Date.now();
          dbg('caption:new-text', { speaker: speaker, text: text.substring(0, 50) + (text.length > 50 ? '...' : '') });

          document.dispatchEvent(new CustomEvent('__mt_zoom_caption', {
            detail: {
              speaker: speaker || 'Unknown Speaker',
              text: text,
              timestamp: Date.now()
            }
          }));
        }
      } catch (e) {
        err('caption-monitor:error', e && e.message);
      }
    }, 800); // Check every 800ms (reduced frequency to catch fewer duplicates)

    // Cleanup old entries from lastCaptionTexts periodically
    var cleanupInterval = setInterval(function () {
      var now = Date.now();
      var keysToDelete = [];
      for (var key in lastCaptionTexts) {
        if (now - lastCaptionTexts[key] > 30000) { // Keep 30s history
          keysToDelete.push(key);
        }
      }
      keysToDelete.forEach(function (key) { delete lastCaptionTexts[key]; });
    }, 10000);

    function cleanup() {
      clearInterval(checkInterval);
      clearInterval(cleanupInterval);
      captionMonitorActive = false;
    }

    return { cleanup: cleanup };
  }

  function extractSpeaker(captionEl) {
    // Try to find speaker name nearby
    var speakerSelectors = [
      '[data-testid*="speaker" i]',
      '[class*="speaker-name"]',
      '[class*="display-name"]',
      '.participant-name',
      '[data-testid*="participant"]'
    ];

    var parent = captionEl.closest('[data-testid*="caption-item" i], [class*="caption-item"], [class*="subtitle-message"]');
    if (!parent) parent = captionEl.parentElement;

    if (parent) {
      for (var i = 0; i < speakerSelectors.length; i++) {
        var speakerEl = parent.querySelector(speakerSelectors[i]);
        if (speakerEl && speakerEl.textContent) {
          return speakerEl.textContent.trim();
        }
      }
    }

    return null;
  }

  // ═════════════════════════════════════════════════════════════════
  // 2. START TRANSCRIPTION BUTTON DETECTION & ACTIVATION
  // ═════════════════════════════════════════════════════════════════

  var transcriptionState = {
    isActive: false,
    menuVisible: false,
    lastCheck: 0,
    checkInterval: 2000 // Check every 2 seconds
  };

  function findCaptionsButton() {
    // Look for the captions/transcription toggle button
    var directButtonSelectors = [
      // Common Zoom button patterns
      'button[aria-label*="Caption" i]',
      'button[aria-label*="Subtitle" i]',
      'button[aria-label*="Close caption" i]',
      'button[aria-label*="Closed caption" i]',
      'button[aria-label*="Turnon caption" i]',
      'button[aria-label*="Live transcription" i]',
      'button[title*="Caption" i]',
      'button[title*="Transcription" i]',
      '[data-testid*="caption-button"]',
      '[data-testid*="transcription-button"]',
      '.btn-text-popup-caption',
      '.zm-btn-captioning'
    ];
    var menuButtonSelectors = [
      // More/options menu (usually has caption option)
      'button[aria-label*="More" i]:not([aria-label*="Search"])',
      'button[aria-label*="Options" i]',
      '[data-testid*="more-actions"]'
    ];

    for (var i = 0; i < directButtonSelectors.length; i++) {
      var btns = getZoomDocument().querySelectorAll(directButtonSelectors[i]);
      for (var j = 0; j < btns.length; j++) {
        var btn = btns[j];
        if (btn && btn.offsetParent !== null) { // Visible check
          var label = btn.getAttribute('aria-label') || btn.getAttribute('title') || btn.textContent.trim();
          if (label && (label.match(/caption/i) || label.match(/subtitle/i) || label.match(/transcription/i))) {
            return btn;
          }
        }
      }
    }

    for (var m = 0; m < menuButtonSelectors.length; m++) {
      var menuBtns = getZoomDocument().querySelectorAll(menuButtonSelectors[m]);
      for (var n = 0; n < menuBtns.length; n++) {
        if (menuBtns[n] && menuBtns[n].offsetParent !== null) return menuBtns[n];
      }
    }

    return null;
  }

  function findStartTranscriptionMenuItem() {
    // After opening captions menu, look for "Start transcription" option
    var menuItemSelectors = [
      '[role="menuitem"]',
      '[role="option"]',
      'li[data-testid*="menu"]',
      '.zm-dropdown-item',
      '.rc-menu-item',
      '[class*="menu-item"]'
    ];

    var allMenuItems = [];
    var targetDocument = getZoomDocument();
    for (var i = 0; i < menuItemSelectors.length; i++) {
      var items = targetDocument.querySelectorAll(menuItemSelectors[i]);
      for (var j = 0; j < items.length; j++) {
        allMenuItems.push(items[j]);
      }
    }

    var keywords = [
      'start transcription',
      'enable transcription',
      'show captions',
      'show caption',
      'show subtitle',
      'enable captions',
      'enable caption',
      'turn on caption',
      'closed caption'
    ];
    for (var k = 0; k < allMenuItems.length; k++) {
      var item = allMenuItems[k];
      if (item && item.offsetParent !== null) { // Visible check
        var text = item.textContent.trim().toLowerCase();
        for (var m = 0; m < keywords.length; m++) {
          if (text.includes(keywords[m])) {
            return item;
          }
        }
      }
    }
    return null;
  }

  function isTranscriptionActive() {
    // Check if transcription is currently running
    var statusIndicators = getZoomDocument().querySelectorAll('[aria-label*="transcription" i], [class*="transcription-on"], [aria-pressed="true"]');
    for (var i = 0; i < statusIndicators.length; i++) {
      if (statusIndicators[i].textContent.toLowerCase().includes('stop')) {
        return true;
      }
    }
    return false;
  }

  function checkTranscriptionStatus() {
    var now = Date.now();
    if (now - transcriptionState.lastCheck < transcriptionState.checkInterval) {
      return;
    }
    transcriptionState.lastCheck = now;

    var isActive = isTranscriptionActive();
    var button = findCaptionsButton();
    var menuVisible = findStartTranscriptionMenuItem() !== null;

    if (isActive !== transcriptionState.isActive || menuVisible !== transcriptionState.menuVisible) {
      transcriptionState.isActive = isActive;
      transcriptionState.menuVisible = menuVisible;

      dbg('transcription-status:changed', {
        isActive: isActive,
        menuVisible: menuVisible,
        buttonFound: !!button
      });

      document.dispatchEvent(new CustomEvent('__mt_zoom_transcription_status', {
        detail: {
          isActive: isActive,
          menuVisible: menuVisible,
          timestamp: Date.now()
        }
      }));
    }
  }

  function requestStartTranscription(reason) {
    log('start-transcription:attempt', { reason: reason || 'manual' });
    var captionBtn = findCaptionsButton();

    if (!captionBtn) {
      err('start-transcription:button-not-found');
      return false;
    }

    dbg('start-transcription:button-found', { buttonText: captionBtn.textContent.substring(0, 30) });

    try {
      var label = captionBtn.getAttribute('aria-label') || captionBtn.getAttribute('title') || captionBtn.textContent || '';
      if (/hide captions?|stop transcription|disable captions?|turn off captions?/i.test(label)) {
        dbg('start-transcription:already-active-skip-toggle', { label: label.substring(0, 60) });
        return true;
      }

      captionBtn.click();
      log('start-transcription:button-clicked');

      setTimeout(function () {
        var menuItem = findStartTranscriptionMenuItem();
        if (menuItem) {
          dbg('start-transcription:menu-item-found', { text: menuItem.textContent.substring(0, 50) });
          menuItem.click();
          log('start-transcription:menu-item-clicked');
        } else {
          warn('start-transcription:menu-item-not-found');
        }
      }, 300);

      return true;
    } catch (e) {
      err('start-transcription:click-error', e && e.message);
      return false;
    }
  }

  // ═════════════════════════════════════════════════════════════════
  // 3. PUBLIC API FOR CONTENT SCRIPT
  // ═════════════════════════════════════════════════════════════════

  window.__meetTranscriberZoomCaptureAPI = {
    startCaptionMonitoring: function () {
      var monitor = startCaptionMonitor();
      log('caption-monitor-started');
      return monitor;
    },

    startTranscription: function () {
      return requestStartTranscription('api');
    },

    getTranscriptionStatus: function () {
      checkTranscriptionStatus();
      return transcriptionState;
    },

    debugInfo: function () {
      return {
        platform: 'zoom',
        captionButtonFound: !!findCaptionsButton(),
        captionElementFound: !!getZoomDocument().querySelector('#live-transcription-subtitle, .live-transcription-subtitle__box'),
        transcriptionActive: isTranscriptionActive(),
        menuItemVisible: !!findStartTranscriptionMenuItem(),
        timestamp: Date.now()
      };
    }
  };

  // ═════════════════════════════════════════════════════════════════
  // 4. INITIALIZATION
  // ═════════════════════════════════════════════════════════════════

  // Start periodic status checks
  startCaptionMonitor();
  setInterval(checkTranscriptionStatus, transcriptionState.checkInterval);

  document.addEventListener('__mt_zoom_command', function (evt) {
    var detail = evt.detail || {};
    if (detail.command === 'startCaptionMonitoring') {
      startCaptionMonitor();
      return;
    }
    if (detail.command === 'ensureTranscription') {
      requestStartTranscription(detail.reason || 'content-command');
    }
  });

  // Log available Zoom handlers
  dbg('zoom-apis-discovered', {
    hasZoomIntentAPI: typeof window.ZoomIntentAPI !== 'undefined',
    hasZoomAV: typeof window.ZoomAV !== 'undefined'
  });

  log('init-complete');

})();
