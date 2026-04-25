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

  var lastCaptionText = '';
  var captionMonitorActive = false;

  function startCaptionMonitor() {
    if (captionMonitorActive) return;
    captionMonitorActive = true;
    log('caption-monitor:start');

    // Zoom caption selectors (most reliable: #live-transcription-subtitle or aria-live)
    var captionSelectors = [
      '#live-transcription-subtitle',
      '.live-transcription-subtitle__box',
      '[aria-live="assertive"]',
      '[aria-live="polite"]',
      '[data-testid*="caption" i]',
      '.rcvideo-box .caption',
      '[class*="subtitle-item"]'
    ];

    function findCaptionElement() {
      for (var i = 0; i < captionSelectors.length; i++) {
        var el = document.querySelector(captionSelectors[i]);
        if (el && el.textContent && el.textContent.trim().length > 0) {
          return el;
        }
      }
      return null;
    }

    // Simple polling approach (Zoom doesn't use MutationObserver well for captions)
    var checkInterval = setInterval(function () {
      try {
        var captionEl = findCaptionElement();
        if (captionEl) {
          var text = captionEl.textContent.trim();
          var speaker = extractSpeaker(captionEl);

          if (text && text !== lastCaptionText) {
            lastCaptionText = text;
            dbg('caption:new-text', { speaker: speaker, text: text.substring(0, 50) + (text.length > 50 ? '...' : '') });

            document.dispatchEvent(new CustomEvent('__mt_zoom_caption', {
              detail: {
                speaker: speaker || 'Unknown Speaker',
                text: text,
                timestamp: Date.now()
              }
            }));
          }
        }
      } catch (e) {
        err('caption-monitor:error', e && e.message);
      }
    }, 500); // Check every 500ms

    function cleanup() {
      clearInterval(checkInterval);
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
    var buttonSelectors = [
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
      '.zm-btn-captioning',
      // More/options menu (usually has caption option)
      'button[aria-label*="More" i]:not([aria-label*="Search"])',
      'button[aria-label*="Options" i]',
      '[data-testid*="more-actions"]'
    ];

    for (var i = 0; i < buttonSelectors.length; i++) {
      var btns = document.querySelectorAll(buttonSelectors[i]);
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
    for (var i = 0; i < menuItemSelectors.length; i++) {
      var items = document.querySelectorAll(menuItemSelectors[i]);
      for (var j = 0; j < items.length; j++) {
        allMenuItems.push(items[j]);
      }
    }

    var keywords = ['start transcription', 'enable transcription', 'show captions', 'enable captions', 'turn on caption'];
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
    var statusIndicators = document.querySelectorAll('[aria-label*="transcription" i], [class*="transcription-on"], [aria-pressed="true"]');
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
      log('start-transcription:attempt');
      var captionBtn = findCaptionsButton();

      if (!captionBtn) {
        err('start-transcription:button-not-found');
        return false;
      }

      dbg('start-transcription:button-found', { buttonText: captionBtn.textContent.substring(0, 30) });

      // Click the button
      try {
        captionBtn.click();
        log('start-transcription:button-clicked');

        // Wait for menu to appear (100-500ms) then click "Start transcription"
        setTimeout(function () {
          var menuItem = findStartTranscriptionMenuItem();
          if (menuItem) {
            dbg('start-transcription:menu-item-found', { text: menuItem.textContent.substring(0, 50) });
            menuItem.click();
            log('start-transcription:menu-item-clicked');
            return true;
          } else {
            warn('start-transcription:menu-item-not-found');
            return false;
          }
        }, 300);

        return true;
      } catch (e) {
        err('start-transcription:click-error', e && e.message);
        return false;
      }
    },

    getTranscriptionStatus: function () {
      checkTranscriptionStatus();
      return transcriptionState;
    },

    debugInfo: function () {
      return {
        platform: 'zoom',
        captionButtonFound: !!findCaptionsButton(),
        captionElementFound: !!document.querySelector('#live-transcription-subtitle, .live-transcription-subtitle__box'),
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
  setInterval(checkTranscriptionStatus, transcriptionState.checkInterval);

  // Log available Zoom handlers
  dbg('zoom-apis-discovered', {
    hasZoomIntentAPI: typeof window.ZoomIntentAPI !== 'undefined',
    hasZoomAV: typeof window.ZoomAV !== 'undefined'
  });

  log('init-complete');

})();
