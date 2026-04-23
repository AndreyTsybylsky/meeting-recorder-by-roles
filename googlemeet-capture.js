// ============================================================
// Google Meet Caption Capture — Runs in PAGE context (MAIN world)
//
// Intercepts two WebRTC data channels:
//   "captions"    — binary protobuf BTranscriptMessage frames
//   "collections" — binary protobuf BDevice frames (deviceId → name)
//
// Also intercepts fetch for SyncMeetingSpaceCollections to get the
// initial participant list before anyone has spoken.
//
// Dispatches to document:
//   CustomEvent('__mt_meet_caption', { detail: { deviceId, messageId, messageVersion, text } })
//   CustomEvent('__mt_meet_device',  { detail: { deviceId, deviceName } })
//
// The content script (ISOLATED world) listens for these events and
// updates the transcript — even when the caption panel is closed.
// ============================================================

(function () {
  if (window.__meetTranscriberGMeetCapture) return;
  window.__meetTranscriberGMeetCapture = true;

  var SYNC_URL = 'https://meet.google.com/$rpc/google.rtc.meetings.v1.MeetingSpaceService/SyncMeetingSpaceCollections';

  // ── Minimal length-safe protobuf parser ──────────────────────
  // Returns { v: value, p: nextPosition }
  function readVarint(buf, pos) {
    var n = 0, shift = 0, b;
    if (pos >= buf.length) return { v: 0, p: pos };
    do {
      b = buf[pos++];
      n |= (b & 0x7F) << shift;
      shift += 7;
    } while ((b & 0x80) && pos < buf.length);
    return { v: n >>> 0, p: pos };
  }

  // Parse all protobuf fields from buf[start..end].
  // Returns map { fieldNumber: [ { t: wireType, v: value|Uint8Array } ] }
  function parseFields(buf, start, end) {
    var fields = {};
    var pos = (start || 0);
    end = (end !== undefined) ? end : buf.length;
    while (pos < end) {
      try {
        var r = readVarint(buf, pos);
        pos = r.p;
        if (pos > end) break;
        var fieldNum = r.v >>> 3;
        var wireType = r.v & 7;
        if (fieldNum === 0) break;
        if (wireType === 0) {           // varint
          var vr = readVarint(buf, pos); pos = vr.p;
          if (!fields[fieldNum]) fields[fieldNum] = [];
          fields[fieldNum].push({ t: 0, v: vr.v });
        } else if (wireType === 2) {   // length-delimited
          var lr = readVarint(buf, pos); pos = lr.p;
          if (pos + lr.v > end) break;
          var bytes = buf.slice(pos, pos + lr.v); pos += lr.v;
          if (!fields[fieldNum]) fields[fieldNum] = [];
          fields[fieldNum].push({ t: 2, v: bytes });
        } else if (wireType === 1) {   // 64-bit fixed
          pos += 8;
        } else if (wireType === 5) {   // 32-bit fixed
          pos += 4;
        } else {
          break; // unknown wire type — stop
        }
      } catch (e) { break; }
    }
    return fields;
  }

  function str(bytes) {
    if (!bytes || !bytes.length) return '';
    try { return new TextDecoder().decode(bytes); } catch (e) { return ''; }
  }

  // ── Gzip decompression (handles optional 3-byte stream prefix) ─
  function isGzip(u8) {
    return u8.length >= 3 && u8[0] === 31 && u8[1] === 139 && u8[2] === 8;
  }

  function decompress(u8) {
    // Tactiq pattern: some frames have a 3-byte prefix before the gzip magic
    var data = u8;
    if (!isGzip(data) && data.length > 3 && isGzip(data.slice(3))) {
      data = data.slice(3);
    }
    if (!isGzip(data)) return Promise.resolve(data);
    if (typeof DecompressionStream === 'undefined') return Promise.resolve(data);
    try {
      var ds = new DecompressionStream('gzip');
      var w = ds.writable.getWriter();
      var r = ds.readable.getReader();
      w.write(data);
      w.close();
      var chunks = [];
      function pump() {
        return r.read().then(function (res) {
          if (res.done) {
            var total = chunks.reduce(function (a, c) { return a + c.length; }, 0);
            var out = new Uint8Array(total), off = 0;
            chunks.forEach(function (c) { out.set(c, off); off += c.length; });
            return out;
          }
          chunks.push(res.value);
          return pump();
        });
      }
      return pump().catch(function () { return u8; });
    } catch (e) { return Promise.resolve(u8); }
  }

  function toU8(raw) {
    if (raw instanceof Uint8Array) return raw;
    if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
    if (ArrayBuffer.isView(raw)) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    return null;
  }

  // ── BTranscriptMessageWrapper decoder ────────────────────────
  // Protobuf schema (as reverse-engineered by Tactiq):
  //   BTranscriptMessageWrapper { field1: BTranscriptMessage, field2: string (unknown2) }
  //   BTranscriptMessage { field1: deviceId(str), field2: messageId(int64),
  //                        field3: messageVersion(int64), field6: text(str), field8: langId(int64) }
  //
  // If unknown2 (field2) is non-empty the frame is a loopback echo → skip.
  // All of deviceId, messageId, messageVersion, langId must be present.
  function decodeCaptionFrame(u8) {
    try {
      var wrap = parseFields(u8);
      // Skip loopback echo frames
      if (wrap[2] && wrap[2][0] && wrap[2][0].v && wrap[2][0].v.length > 0 && str(wrap[2][0].v)) {
        return null;
      }
      if (!wrap[1] || !wrap[1][0]) return null;
      var msg = parseFields(wrap[1][0].v);
      var deviceId      = msg[1] && msg[1][0] ? str(msg[1][0].v) : '';
      var messageId     = msg[2] && msg[2][0] ? msg[2][0].v : 0;
      var messageVer    = msg[3] && msg[3][0] ? msg[3][0].v : 0;
      var text          = msg[6] && msg[6][0] ? str(msg[6][0].v) : '';
      var langId        = msg[8] && msg[8][0] ? msg[8][0].v : 0;
      // Require all semantic fields to be present and non-zero
      if (!deviceId || !messageId || !messageVer || !text) return null;
      return {
        deviceId:       '@' + deviceId,
        messageId:      messageId + '/@' + deviceId,
        messageVersion: messageVer,
        text:           text
      };
    } catch (e) { return null; }
  }

  // ── BDevice decoder (from collections data channel) ──────────
  // Hierarchy: BDevice.f1 → BDeviceSub1.f2 → BDeviceSub2.f13 →
  //            BDeviceSub3.f1 → BDeviceSub4.f2 → BDeviceSub5 { f1: deviceId, f2: deviceName }
  function decodeDeviceFrame(u8) {
    try {
      var d = parseFields(u8);
      if (!d[1] || !d[1][0]) return null;
      d = parseFields(d[1][0].v);
      if (!d[2] || !d[2][0]) return null;
      d = parseFields(d[2][0].v);
      if (!d[13] || !d[13][0]) return null;
      d = parseFields(d[13][0].v);
      if (!d[1] || !d[1][0]) return null;
      d = parseFields(d[1][0].v);
      if (!d[2] || !d[2][0]) return null;
      d = parseFields(d[2][0].v);
      var deviceId   = d[1] && d[1][0] ? str(d[1][0].v) : '';
      var deviceName = d[2] && d[2][0] ? str(d[2][0].v) : '';
      if (!deviceId || !deviceName) return null;
      return { deviceId: '@' + deviceId, deviceName: deviceName };
    } catch (e) { return null; }
  }

  // ── BMeetingCollection decoder (from SyncMeetingSpaceCollections HTTP) ─
  // Hierarchy: BMeetingCollection.f2 → BMeetingCollectionSub1.f2 →
  //            BMeetingCollectionSub2.f2(repeated) → BDeviceSub5 { f1: deviceId, f2: deviceName }
  function decodeParticipantList(u8) {
    try {
      var d = parseFields(u8);
      if (!d[2] || !d[2][0]) return [];
      d = parseFields(d[2][0].v);
      if (!d[2] || !d[2][0]) return [];
      d = parseFields(d[2][0].v);
      if (!d[2]) return [];
      return d[2].map(function (item) {
        var sub = parseFields(item.v);
        return {
          deviceId:   '@' + str(sub[1] && sub[1][0] ? sub[1][0].v : new Uint8Array()),
          deviceName: str(sub[2] && sub[2][0] ? sub[2][0].v : new Uint8Array())
        };
      }).filter(function (p) { return p.deviceId !== '@' && p.deviceName; });
    } catch (e) { return []; }
  }

  function dispatchDevice(info) {
    document.dispatchEvent(new CustomEvent('__mt_meet_device', { detail: info }));
  }

  // ── RTCPeerConnection intercept (Tactiq pattern) ─────────────
  // KEY INSIGHT (from Tactiq source):
  //   Meet's 'captions' DataChannel is CLIENT-created, not server-created.
  //   The extension must call pc.createDataChannel('captions') itself once
  //   the peer connection is established (signalled by the server-created
  //   'collections' channel arriving via ondatachannel).
  //   'collections' IS server-created (arrives via ondatachannel).
  //
  // Approach: replace window.RTCPeerConnection with a wrapper constructor
  // (exactly like Tactiq), attach ondatachannel listener to every instance,
  // and when 'collections' arrives create 'captions' ourselves.
  var OrigRTC = window.RTCPeerConnection;
  if (!OrigRTC) return;

  var origCreateDC = OrigRTC.prototype.createDataChannel;

  function attachCaptionsChannel(pc) {
    try {
      var ch = origCreateDC.call(pc, 'captions', { ordered: true, maxRetransmits: 10 });
      // Listen for caption messages on this channel
      ch.addEventListener('message', function (evt) {
        var u8 = toU8(evt.data);
        if (!u8 || typeof evt.data === 'string') return;
        decompress(u8).then(function (data) {
          var msg = decodeCaptionFrame(data);
          if (msg) {
            document.dispatchEvent(new CustomEvent('__mt_meet_caption', { detail: msg }));
          }
        });
      });
    } catch (e) { /* pc may already be closed */ }
  }

  // Wrapper constructor — replaces window.RTCPeerConnection
  function WrapRTC(config, constraints) {
    var pc = new OrigRTC(config, constraints);

    // Server-created channels arrive here
    pc.addEventListener('datachannel', function (evt) {
      var ch = evt.channel;

      if (ch.label === 'collections') {
        // 'collections' channel carries participant deviceId → name maps
        ch.addEventListener('message', function (evt2) {
          var u8 = toU8(evt2.data);
          if (!u8 || typeof evt2.data === 'string') return;
          decompress(u8).then(function (data) {
            var info = decodeDeviceFrame(data);
            if (info) dispatchDevice(info);
          });
        });
        // SCTP transport is up — create the captions channel now
        attachCaptionsChannel(pc);
      }

      // Also handle 'meet_messages' (alternative caption channel on some versions)
      if (ch.label === 'meet_messages') {
        ch.addEventListener('message', function (evt2) {
          var u8 = toU8(evt2.data);
          if (!u8 || typeof evt2.data === 'string') return;
          decompress(u8).then(function (data) {
            var msg = decodeCaptionFrame(data);
            if (msg) {
              document.dispatchEvent(new CustomEvent('__mt_meet_caption', { detail: msg }));
            }
          });
        });
      }
    });

    // Return pc — constructor returning an object overrides 'this'
    return pc;
  }

  // Keep prototype chain intact so instanceof checks still work
  WrapRTC.prototype = OrigRTC.prototype;
  window.RTCPeerConnection = WrapRTC;

  // ── Fetch intercept for initial participant list ──────────────
  var origFetch = window.fetch;
  window.fetch = function () {
    var args = arguments;
    var req  = args[0];
    var urlStr = typeof req === 'string' ? req : (req instanceof Request ? req.url : String(req));
    var p = origFetch.apply(this, args);
    if (urlStr === SYNC_URL) {
      p.then(function (resp) {
        resp.clone().text().then(function (b64) {
          try {
            var u8 = Uint8Array.from(atob(b64), function (c) { return c.charCodeAt(0); });
            decodeParticipantList(u8).forEach(dispatchDevice);
          } catch (e) { /* not base64 or not a collection response */ }
        }).catch(function () {});
      }).catch(function () {});
    }
    return p;
  };

})();
