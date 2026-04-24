// ============================================================
// Teams Caption Capture — Runs in PAGE context (MAIN world)
// Intercepts WebRTC main-channel data to read recognitionResults
// regardless of whether the caption panel is open or closed.
// ============================================================

(function () {
  if (window.__meetTranscriberTeamsCapture) return;
  window.__meetTranscriberTeamsCapture = true;

  function log(step, details) {
    if (details === undefined) {
      console.log('[MeetTranscriber][teams-capture] ' + step);
      return;
    }
    console.log('[MeetTranscriber][teams-capture] ' + step, details);
  }

  function warn(step, details) {
    if (details === undefined) {
      console.warn('[MeetTranscriber][teams-capture] ' + step);
      return;
    }
    console.warn('[MeetTranscriber][teams-capture] ' + step, details);
  }

  function err(step, error) {
    console.error('[MeetTranscriber][teams-capture] ' + step, error);
  }

  log('init', { url: window.location.href });

  var RTC = window.RTCPeerConnection;
  if (!RTC) {
    warn('init-abort:no-RTCPeerConnection');
    return;
  }

  var origCreateDataChannel = RTC.prototype.createDataChannel;

  RTC.prototype.createDataChannel = function (label, options) {
    log('createDataChannel', { label: label, hasOptions: !!options });
    var channel = origCreateDataChannel.apply(this, arguments);

    if (label === 'main-channel') {
      log('main-channel-hooked', { readyState: channel.readyState });

      channel.addEventListener('open', function () {
        log('main-channel-open', { readyState: channel.readyState });
      });

      channel.addEventListener('close', function () {
        warn('main-channel-close', { readyState: channel.readyState });
      });

      channel.addEventListener('error', function (evt) {
        err('main-channel-error', evt && evt.error ? evt.error : evt);
      });

      channel.addEventListener('message', function (evt) {
        try {
          var raw = evt.data;
          var str;
          if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) {
            str = new TextDecoder().decode(raw);
          } else {
            str = String(raw);
          }

          log('main-channel-message', {
            rawType: raw && raw.constructor ? raw.constructor.name : typeof raw,
            textLength: str.length
          });

          // Find start of first JSON object or array in the binary frame
          var iArr = str.indexOf('[');
          var iObj = str.indexOf('{');
          var start;
          if (iArr === -1 && iObj === -1) {
            warn('main-channel-skip:no-json-start');
            return;
          }
          if (iArr === -1) start = iObj;
          else if (iObj === -1) start = iArr;
          else start = Math.min(iArr, iObj);

          var obj = JSON.parse(str.slice(start));
          if (!obj || !Array.isArray(obj.recognitionResults)) {
            warn('main-channel-skip:no-recognitionResults');
            return;
          }

          log('main-channel-recognitionResults', { count: obj.recognitionResults.length });

          for (var i = 0; i < obj.recognitionResults.length; i++) {
            var r = obj.recognitionResults[i];
            if (!('timestampAudioSent' in r) || !r.text) {
              warn('recognition-skip:missing-required', {
                hasTimestamp: 'timestampAudioSent' in r,
                hasText: !!r.text
              });
              continue;
            }

            log('recognition-dispatch', {
              userId: r.userId || '',
              timestampAudioSent: r.timestampAudioSent,
              textLength: r.text.length
            });

            document.dispatchEvent(new CustomEvent('__mt_teams_caption', {
              detail: {
                userId: r.userId || '',
                text: r.text,
                messageId: String(r.timestampAudioSent) + '/' + (r.userId || '')
              }
            }));
          }
        } catch (e) {
          err('main-channel-parse-error', e);
        }
      });
    }

    return channel;
  };

  log('init-complete');
})();
