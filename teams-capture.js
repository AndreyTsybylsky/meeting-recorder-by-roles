// ============================================================
// Teams Caption Capture — Runs in PAGE context (MAIN world)
// Intercepts WebRTC main-channel data to read recognitionResults
// regardless of whether the caption panel is open or closed.
// ============================================================

(function () {
  if (window.__meetTranscriberTeamsCapture) return;
  window.__meetTranscriberTeamsCapture = true;

  var RTC = window.RTCPeerConnection;
  if (!RTC) return;

  var origCreateDataChannel = RTC.prototype.createDataChannel;

  RTC.prototype.createDataChannel = function (label, options) {
    var channel = origCreateDataChannel.apply(this, arguments);

    if (label === 'main-channel') {
      channel.addEventListener('message', function (evt) {
        try {
          var raw = evt.data;
          var str;
          if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) {
            str = new TextDecoder().decode(raw);
          } else {
            str = String(raw);
          }

          // Find start of first JSON object or array in the binary frame
          var iArr = str.indexOf('[');
          var iObj = str.indexOf('{');
          var start;
          if (iArr === -1 && iObj === -1) return;
          if (iArr === -1) start = iObj;
          else if (iObj === -1) start = iArr;
          else start = Math.min(iArr, iObj);

          var obj = JSON.parse(str.slice(start));
          if (!obj || !Array.isArray(obj.recognitionResults)) return;

          for (var i = 0; i < obj.recognitionResults.length; i++) {
            var r = obj.recognitionResults[i];
            if (!('timestampAudioSent' in r) || !r.text) continue;

            document.dispatchEvent(new CustomEvent('__mt_teams_caption', {
              detail: {
                userId: r.userId || '',
                text: r.text,
                messageId: String(r.timestampAudioSent) + '/' + (r.userId || '')
              }
            }));
          }
        } catch (_) {
          // Silently ignore parse errors (non-caption frames)
        }
      });
    }

    return channel;
  };
})();
