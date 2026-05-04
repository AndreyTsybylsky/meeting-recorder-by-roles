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
//   CustomEvent('__mt_meet_channel_state', { detail: { label, state, readyState, pcState } })
//
// The content script (ISOLATED world) listens for these events and
// updates the transcript — even when the caption panel is closed.
// ============================================================

(function () {
  if (window.__meetTranscriberGMeetCapture) return;
  window.__meetTranscriberGMeetCapture = true;

  function log(step, details) {
    if (details === undefined) {
      console.log('[MeetTranscriber][meet-capture] ' + step);
      return;
    }
    console.log('[MeetTranscriber][meet-capture] ' + step, details);
  }

  function warn(step, details) {
    if (details === undefined) {
      console.warn('[MeetTranscriber][meet-capture] ' + step);
      return;
    }
    console.warn('[MeetTranscriber][meet-capture] ' + step, details);
  }

  function dbg(step, details) {
    if (details === undefined) {
      console.debug('[MeetTranscriber][meet-capture] ' + step);
      return;
    }
    console.debug('[MeetTranscriber][meet-capture] ' + step, details);
  }

  function err(step, error) {
    console.error('[MeetTranscriber][meet-capture] ' + step, error);
  }

  log('init', {
    url: window.location.href,
    hasRTC: !!window.RTCPeerConnection,
    hasDecompressionStream: typeof DecompressionStream !== 'undefined'
  });

  var SYNC_URL = 'https://meet.google.com/$rpc/google.rtc.meetings.v1.MeetingSpaceService/SyncMeetingSpaceCollections';
  var CREATE_MESSAGE_URL = 'https://meet.google.com/$rpc/google.rtc.meetings.v1.MeetingMessageService/CreateMeetingMessage';

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
    if (typeof DecompressionStream === 'undefined') {
      warn('decompress-skipped:no-DecompressionStream');
      return Promise.resolve(data);
    }
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
      return pump().catch(function (e) {
        warn('decompress-failed:reader', e && e.message ? e.message : e);
        return u8;
      });
    } catch (e) {
      warn('decompress-failed:exception', e && e.message ? e.message : e);
      return Promise.resolve(u8);
    }
  }

  function toU8(raw) {
    if (raw instanceof Uint8Array) return raw;
    if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
    if (ArrayBuffer.isView(raw)) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    return null;
  }

  function indexOfBytes(haystack, needle, from, wildcardAt) {
    var start = from || 0;
    var wildcard = (wildcardAt === undefined) ? -1 : wildcardAt;
    if (!haystack || !needle || !needle.length) return -1;
    for (var i = start; i <= haystack.length - needle.length; i++) {
      var ok = true;
      for (var j = 0; j < needle.length; j++) {
        if (j !== wildcard && haystack[i + j] !== needle[j]) {
          ok = false;
          break;
        }
      }
      if (ok) return i;
    }
    return -1;
  }

  function decodeCaptionFrameFallback(u8) {
    try {
      // This branch is intentionally heuristic. Meet occasionally changes
      // the envelope and strict protobuf parsing starts returning null.
      // We recover by looking for stable byte boundaries around message
      // id/version/text used by recent Meet builds.
      var iMsgIdTag = u8.indexOf(16);
      if (iMsgIdTag < 0) return null;

      var boundaryCandidates = [
        indexOfBytes(u8, [24, 0, 32, 1, 45, 0], iMsgIdTag + 1, 1),
        indexOfBytes(u8, [24, 0, 1, 32, 1, 45, 0], iMsgIdTag + 1, 1),
        indexOfBytes(u8, [24, 0, 45, 0], iMsgIdTag + 1, 1),
        indexOfBytes(u8, [24, 0, 1, 45, 0], iMsgIdTag + 1, 1)
      ];

      var boundary = -1;
      for (var k = 0; k < boundaryCandidates.length; k++) {
        if (boundaryCandidates[k] > -1) {
          boundary = boundaryCandidates[k];
          break;
        }
      }

      var textPrefixCandidates = [
        indexOfBytes(u8, [24, 0, 32, 1, 50], iMsgIdTag + 1, 1),
        indexOfBytes(u8, [24, 0, 1, 32, 1, 50], iMsgIdTag + 1, 1),
        indexOfBytes(u8, [24, 0, 50], iMsgIdTag + 1, 1),
        indexOfBytes(u8, [24, 0, 1, 50], iMsgIdTag + 1, 1)
      ];

      var textPrefix = -1;
      for (var m = 0; m < textPrefixCandidates.length; m++) {
        if (textPrefixCandidates[m] > -1) {
          textPrefix = textPrefixCandidates[m];
          break;
        }
      }

      if (boundary < 0 && textPrefix < 0) return null;
      var boundaryPos = boundary > -1 ? boundary : textPrefix;

      var msgIdBytes = u8.slice(iMsgIdTag + 1, boundaryPos);
      if (!msgIdBytes.length) return null;
      var msgId = 0;
      for (var n = 0; n < msgIdBytes.length; n++) {
        msgId += msgIdBytes[n] * Math.pow(256, n);
      }

      var iLangPrefixA = indexOfBytes(u8, [64, 0, 72], 0, 1);
      var iLangPrefixB = indexOfBytes(u8, [64, 0, 80], 0, 1);
      var iLang = iLangPrefixA > -1 ? iLangPrefixA : iLangPrefixB;
      if (iLang < 0) return null;

      var textStart = textPrefix > -1 ? (textPrefix + 5) : (indexOfBytes(u8, [128, 63], 0, -1) + 4);
      if (textStart < 0 || textStart >= iLang) return null;

      var rawDevice = '';
      var iDeviceStop = u8.indexOf(16, 4);
      if (iDeviceStop > 4) {
        rawDevice = str(u8.slice(3, iDeviceStop)).trim();
      }
      if (!rawDevice) return null;

      var text = str(u8.slice(textStart, iLang)).trim();
      if (!text) return null;

      var messageVersion = (boundaryPos >= 0 && (boundaryPos + 1) < u8.length) ? u8[boundaryPos + 1] : 1;

      return {
        deviceId: '@' + rawDevice,
        messageId: msgId + '/@' + rawDevice,
        messageVersion: messageVersion || 1,
        text: text
      };
    } catch (e) {
      return null;
    }
  }

  function toAsciiCodes(s) {
    var out = [];
    for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
    return out;
  }

  // Parse speech payload from Meet "message" stream (Tactiq-style fallback).
  // This is separate from BTranscriptMessage captions and helps when Meet ships
  // a changed frame layout that breaks strict caption decoding.
  function decodeSpeechFromMessageStream(u8) {
    try {
      var msgMarker = toAsciiCodes('/messages/');
      var devMarker = toAsciiCodes('spaces/');

      var iMsg = indexOfBytes(u8, msgMarker, 0, -1);
      if (iMsg < 0) return null;

      var iMsgStop = indexOfBytes(u8, [18], iMsg, -1);
      if (iMsgStop < 0) return null;
      var messageIdBase = str(u8.slice(iMsg + msgMarker.length, iMsgStop));
      if (!messageIdBase) return null;

      var iDev = indexOfBytes(u8, devMarker, iMsgStop, -1);
      var iDevStop = iDev >= 0 ? indexOfBytes(u8, [24], iDev, -1) : -1;
      if (iDev < 0 || iDevStop < 0) return null;
      var deviceIdRaw = str(u8.slice(iDev, iDevStop));
      if (!deviceIdRaw) return null;

      var iTextLenStart = indexOfBytes(u8, [10], iDev, -1) + 1;
      if (iTextLenStart <= 0) return null;
      if (u8[iTextLenStart - 1] === 10 && u8[iTextLenStart + 1] === 8) iTextLenStart++;

      var iVarEnd = (u8[iTextLenStart + 1] < 4) ? (iTextLenStart + 2) : (iTextLenStart + 1);
      var lenBytes = u8.slice(iTextLenStart, iVarEnd);
      if (!lenBytes.length) return null;

      var textLen = 0;
      for (var iLen = 0; iLen < lenBytes.length; iLen++) {
        // Keep parity with Tactiq varint fallback logic.
        textLen += Math.pow(128, iLen) * (iLen ? (lenBytes[iLen] - 1) : lenBytes[iLen]);
      }
      if (textLen <= 0) return null;

      var iTextStart = iVarEnd;
      var iTextEnd = iTextStart + textLen;
      if (iTextEnd > u8.length) return null;

      var text = str(u8.slice(iTextStart, iTextEnd)).trim();
      if (!text) return null;

      return {
        deviceId: '@' + deviceIdRaw,
        messageId: messageIdBase + '/@' + deviceIdRaw,
        messageVersion: 1,
        text: text
      };
    } catch (e) {
      return null;
    }
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
      // Require all semantic fields to be present and non-zero.
      // If strict protobuf parse fails, fall back to heuristic decoding.
      if (!deviceId || !messageId || !messageVer || !text) {
        var fallbackMsg = decodeCaptionFrameFallback(u8);
        if (fallbackMsg) {
          log('caption-decode:fallback-ok', {
            deviceId: fallbackMsg.deviceId,
            messageId: fallbackMsg.messageId,
            messageVersion: fallbackMsg.messageVersion,
            textLength: fallbackMsg.text.length
          });
          return fallbackMsg;
        }
        dbg('caption-decode-skip:missing-required', {
          hasDeviceId: !!deviceId,
          messageId: messageId,
          messageVersion: messageVer,
          textLength: text ? text.length : 0,
          langId: langId
        });
        return null;
      }
      return {
        deviceId:       '@' + deviceId,
        messageId:      messageId + '/@' + deviceId,
        messageVersion: messageVer,
        text:           text
      };
    } catch (e) {
      var fallbackFromError = decodeCaptionFrameFallback(u8);
      if (fallbackFromError) {
        log('caption-decode:fallback-after-error', {
          deviceId: fallbackFromError.deviceId,
          messageId: fallbackFromError.messageId,
          messageVersion: fallbackFromError.messageVersion,
          textLength: fallbackFromError.text.length
        });
        return fallbackFromError;
      }
      warn('caption-decode-error', e && e.message ? e.message : e);
      return null;
    }
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
      if (!deviceId || !deviceName) {
        dbg('device-decode-skip:missing-required', {
          hasDeviceId: !!deviceId,
          hasDeviceName: !!deviceName
        });
        return null;
      }
      return { deviceId: '@' + deviceId, deviceName: deviceName };
    } catch (e) {
      warn('device-decode-error', e && e.message ? e.message : e);
      return null;
    }
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
    } catch (e) {
      warn('participant-list-decode-error', e && e.message ? e.message : e);
      return [];
    }
  }

  function dispatchDevice(info) {
    log('dispatch-device', info);
    document.dispatchEvent(new CustomEvent('__mt_meet_device', { detail: info }));
  }

  function dispatchChannelState(label, state, channel, pc) {
    document.dispatchEvent(new CustomEvent('__mt_meet_channel_state', {
      detail: {
        label: label,
        state: state,
        readyState: channel && channel.readyState ? channel.readyState : 'unknown',
        pcState: pc && pc.connectionState ? pc.connectionState : 'unknown',
        timestamp: Date.now()
      }
    }));
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
  if (!OrigRTC) {
    warn('init-abort:no-RTCPeerConnection');
    return;
  }

  var origCreateDC = OrigRTC.prototype.createDataChannel;
  var activePeerConnection = null;
  var activeCaptionsChannel = null;
  var captionsMonitorStarted = false;
  var knownPeerConnections = [];

  function rememberPeerConnection(pc) {
    if (!pc) return;
    for (var i = 0; i < knownPeerConnections.length; i++) {
      if (knownPeerConnections[i].pc === pc) return;
    }
    knownPeerConnections.push({ pc: pc, seenAt: Date.now() });
    if (knownPeerConnections.length > 8) knownPeerConnections.shift();
  }

  function getBestPeerConnection() {
    for (var i = knownPeerConnections.length - 1; i >= 0; i--) {
      var candidate = knownPeerConnections[i] && knownPeerConnections[i].pc;
      if (!candidate) continue;
      var st = candidate.connectionState;
      if (st !== 'closed' && st !== 'failed') return candidate;
    }
    return null;
  }

  function dispatchCaption(msg, source) {
    if (!msg) return;
    if (source) msg._source = source;
    document.dispatchEvent(new CustomEvent('__mt_meet_caption', { detail: msg }));
  }

  function startCaptionsMonitor() {
    if (captionsMonitorStarted) return;
    captionsMonitorStarted = true;

    setInterval(function () {
      if (!activePeerConnection) return;
      if (activePeerConnection.connectionState === 'closed' || activePeerConnection.connectionState === 'failed') return;

      var channelMissing = !activeCaptionsChannel;
      var state = channelMissing ? 'missing' : activeCaptionsChannel.readyState;
      if (state === 'open' || state === 'connecting') return;

      warn('captions-monitor:channel-unhealthy', {
        channelState: state,
        pcState: activePeerConnection.connectionState
      });
      var bestPc = getBestPeerConnection() || activePeerConnection;
      if (bestPc !== activePeerConnection) {
        warn('captions-monitor:switch-active-peer-connection', {
          fromState: activePeerConnection && activePeerConnection.connectionState,
          toState: bestPc.connectionState
        });
        activePeerConnection = bestPc;
      }
      attachCaptionsChannel(bestPc);
    }, 5000);
  }

  function attachCaptionsChannel(pc) {
    try {
      log('captions-create:start');
      var ch = origCreateDC.call(pc, 'captions', { ordered: true, maxRetransmits: 10 });
      activeCaptionsChannel = ch;
      log('captions-create:ok', { readyState: ch.readyState });

      ch.addEventListener('open', function () {
        log('captions-channel-open', { readyState: ch.readyState });
        dispatchChannelState('captions', 'open', ch, pc);
      });

      ch.addEventListener('close', function () {
        warn('captions-channel-close', { readyState: ch.readyState });
        dispatchChannelState('captions', 'close', ch, pc);
        if (activeCaptionsChannel === ch) activeCaptionsChannel = null;
      });

      ch.addEventListener('error', function (evt) {
        err('captions-channel-error', evt && evt.error ? evt.error : evt);
        dispatchChannelState('captions', 'error', ch, pc);
      });

      // Listen for caption messages on this channel
      ch.addEventListener('message', function (evt) {
        var u8 = toU8(evt.data);
        if (!u8 || typeof evt.data === 'string') {
          warn('captions-message-skip:non-binary', {
            type: typeof evt.data
          });
          return;
        }
        decompress(u8).then(function (data) {
          var msg = decodeCaptionFrame(data);
          if (msg) {
            log('captions-message:decoded', {
              deviceId: msg.deviceId,
              messageId: msg.messageId,
              version: msg.messageVersion,
              textLength: msg.text.length
            });
            dispatchCaption(msg, 'captions');
          } else {
            warn('captions-message-skip:decode-null', { bytes: data.length });
          }
        }).catch(function (e) {
          err('captions-message:decompress-promise-error', e);
        });
      });
    } catch (e) {
      err('captions-create-failed', e);
    }
  }

  // Wrapper constructor — replaces window.RTCPeerConnection
  function WrapRTC(config, constraints) {
    log('rtc-wrap:new-connection');
    var pc = new OrigRTC(config, constraints);
    rememberPeerConnection(pc);
    activePeerConnection = pc;
    startCaptionsMonitor();

    pc.addEventListener('connectionstatechange', function () {
      var state = pc.connectionState || 'unknown';
      log('rtc-connectionstatechange', { state: state });
      if (state === 'connected' || state === 'connecting') {
        activePeerConnection = pc;
      }
    });

    // Server-created channels arrive here
    pc.addEventListener('datachannel', function (evt) {
      var ch = evt.channel;
      log('rtc-datachannel', { label: ch && ch.label, readyState: ch && ch.readyState });

      if (ch.label === 'collections') {
        log('collections-channel-detected');
        // 'collections' channel carries participant deviceId → name maps
        ch.addEventListener('message', function (evt2) {
          var u8 = toU8(evt2.data);
          if (!u8 || typeof evt2.data === 'string') {
            warn('collections-message-skip:non-binary', {
              type: typeof evt2.data
            });
            return;
          }
          decompress(u8).then(function (data) {
            var info = decodeDeviceFrame(data);
            if (info) dispatchDevice(info);
            else dbg('collections-message-skip:decode-null', { bytes: data.length });
          }).catch(function (e) {
            err('collections-message:decompress-promise-error', e);
          });
        });

        ch.addEventListener('close', function () {
          warn('collections-channel-close', { readyState: ch.readyState });
        });

        ch.addEventListener('error', function (evt2) {
          err('collections-channel-error', evt2 && evt2.error ? evt2.error : evt2);
        });

        // SCTP transport is up — create the captions channel now
        attachCaptionsChannel(pc);
      }

      // Also handle 'meet_messages' (alternative caption channel on some versions)
      if (ch.label === 'meet_messages') {
        log('meet_messages-channel-detected');
        ch.addEventListener('message', function (evt2) {
          var u8 = toU8(evt2.data);
          if (!u8 || typeof evt2.data === 'string') {
            warn('meet_messages-skip:non-binary', {
              type: typeof evt2.data
            });
            return;
          }
          decompress(u8).then(function (data) {
            var msg = decodeCaptionFrame(data);
            if (!msg) msg = decodeSpeechFromMessageStream(data);
            if (msg) {
              log('meet_messages:decoded', {
                deviceId: msg.deviceId,
                messageId: msg.messageId,
                version: msg.messageVersion,
                textLength: msg.text.length
              });
              dispatchCaption(msg, 'meet_messages');
            } else {
              dbg('meet_messages-skip:decode-null', { bytes: data.length });
            }
          }).catch(function (e) {
            err('meet_messages:decompress-promise-error', e);
          });
        });

        ch.addEventListener('close', function () {
          warn('meet_messages-channel-close', { readyState: ch.readyState });
        });

        ch.addEventListener('error', function (evt2) {
          err('meet_messages-channel-error', evt2 && evt2.error ? evt2.error : evt2);
        });
      }
    });

    // Return pc — constructor returning an object overrides 'this'
    return pc;
  }

  // Keep prototype chain intact so instanceof checks still work
  WrapRTC.prototype = OrigRTC.prototype;
  window.RTCPeerConnection = WrapRTC;
  log('rtc-wrap:installed');

  // ── Fetch intercept for initial participant list ──────────────
  var origFetch = window.fetch;
  window.fetch = function () {
    var args = arguments;
    var req  = args[0];
    var urlStr = typeof req === 'string' ? req : (req instanceof Request ? req.url : String(req));
    var p = origFetch.apply(this, args);
    if (urlStr === SYNC_URL) {
      log('fetch-sync-collections:hit');
      p.then(function (resp) {
        resp.clone().text().then(function (b64) {
          try {
            var u8 = Uint8Array.from(atob(b64), function (c) { return c.charCodeAt(0); });
            var participants = decodeParticipantList(u8);
            log('fetch-sync-collections:decoded', { count: participants.length });
            participants.forEach(dispatchDevice);
          } catch (e) {
            warn('fetch-sync-collections:parse-failed', e && e.message ? e.message : e);
          }
        }).catch(function () {});
      }).catch(function (e) {
        warn('fetch-sync-collections:request-failed', e && e.message ? e.message : e);
      });
    }

    if (urlStr === CREATE_MESSAGE_URL) {
      log('fetch-create-meeting-message:hit');
      p.then(function (resp) {
        resp.clone().text().then(function (b64) {
          try {
            var u8 = Uint8Array.from(atob(b64), function (c) { return c.charCodeAt(0); });
            var msg = decodeSpeechFromMessageStream(u8);
            if (!msg) msg = decodeCaptionFrame(u8);
            if (msg) {
              log('fetch-create-meeting-message:decoded', {
                deviceId: msg.deviceId,
                messageId: msg.messageId,
                version: msg.messageVersion,
                textLength: msg.text.length
              });
              dispatchCaption(msg, 'create_meeting_message');
            } else {
              dbg('fetch-create-meeting-message:decode-null', { bytes: u8.length });
            }
          } catch (e) {
            warn('fetch-create-meeting-message:parse-failed', e && e.message ? e.message : e);
          }
        }).catch(function () {});
      }).catch(function (e) {
        warn('fetch-create-meeting-message:request-failed', e && e.message ? e.message : e);
      });
    }

    return p;
  };

  document.addEventListener('__mt_meet_recover_capture', function (evt) {
    var detail = (evt && evt.detail) ? evt.detail : {};
    if (!activePeerConnection) {
      activePeerConnection = getBestPeerConnection();
      if (!activePeerConnection) {
        warn('recover-capture:skip-no-active-peer-connection', detail);
        return;
      }
    }

    if (activePeerConnection.connectionState === 'closed' || activePeerConnection.connectionState === 'failed') {
      warn('recover-capture:skip-peer-connection-not-usable', {
        pcState: activePeerConnection.connectionState,
        reason: detail.reason || 'unknown'
      });
      activePeerConnection = getBestPeerConnection();
      if (!activePeerConnection) return;
    }

    warn('recover-capture:reattach-captions-channel', {
      reason: detail.reason || 'unknown',
      inactivityMs: detail.inactivityMs || 0,
      pcState: activePeerConnection.connectionState,
      hadActiveChannel: !!activeCaptionsChannel,
      activeChannelState: activeCaptionsChannel ? activeCaptionsChannel.readyState : 'none'
    });

    // Drop stale reference so monitor/recovery can promote a fresh channel.
    activeCaptionsChannel = null;
    attachCaptionsChannel(activePeerConnection);
  });

  document.addEventListener('__mt_meet_force_rtc_reconnect', function (evt) {
    var detail = (evt && evt.detail) ? evt.detail : {};
    var nextPc = getBestPeerConnection();
    if (!nextPc) {
      warn('force-rtc-reconnect:skip-no-peer-connection', detail);
      return;
    }

    activePeerConnection = nextPc;
    activeCaptionsChannel = null;
    warn('force-rtc-reconnect:rotate-active-peer-connection', {
      reason: detail.reason || 'unknown',
      inactivityMs: detail.inactivityMs || 0,
      pcState: nextPc.connectionState
    });
    attachCaptionsChannel(nextPc);
  });

  log('init-complete');

})();
