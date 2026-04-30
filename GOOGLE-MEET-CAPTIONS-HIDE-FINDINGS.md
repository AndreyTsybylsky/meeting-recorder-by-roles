# Google Meet — Silent Caption Recording: Findings & Implementation

**Date:** 2026-04-25  
**Goal:** Record meeting transcript while the native captions bar is hidden from the user.  
**Result:** Captions hidden by default, user can toggle them on/off without stopping the recording.

---

## 1. Architecture Overview

Google Meet captions are captured by two parallel mechanisms:

| Mechanism | World | How |
|-----------|-------|-----|
| DOM MutationObserver | ISOLATED (content script) | Watches `div[jsname='dsyhDe']` and `div[jsname='dqMPrb']` for text mutations |
| RTC DataChannel | MAIN (injected script) | Hooks `RTCPeerConnection.prototype.createDataChannel`, watches the `captions` channel for binary protobuf payloads |

Both must be kept alive. Closing the native captions panel kills the RTC DataChannel **and** removes the DOM nodes.

---

## 2. Key DOM Selectors

### Caption text regions (MutationObserver targets)
```
div[jsname='dsyhDe']   — primary caption text container
div[jsname='dqMPrb']   — secondary / alternative caption container
[aria-live='polite']   — accessibility live region (fallback)
[aria-live='assertive']
```

### Outer captions bar container (the entire bottom panel)
```
.a4cQT                 — outermost bar, wraps everything including speaker label
                         and the close button. Hiding this collapses the full bar.
```
Source: found by cross-referencing Tactiq's `content.js` where they use:
```js
document.querySelector(".a4cQT")?.style.display !== "none"
```
to detect whether captions are visually on.

### Captions toggle button
Meet does not use a stable `id` or `data-*` attribute on the toggle button.  
Detection relies on `aria-label` / `data-tooltip` / `title` text matching:

```js
const CAPTIONS_LABEL_HINTS = [
  "caption", "subtit", "субтит", "титр",
  "legenda", "untertitel", "sous-titre", "字幕"
];
// Button state detection:
const CAPTIONS_ON_PHRASES  = ["turn off captions","hide captions","выключить субтитры","скрыть субтитры"];
const CAPTIONS_OFF_PHRASES = ["turn on captions","show captions","включить субтитры","показать субтитры"];
```

**Critical insight:** When `.a4cQT` is hidden via `display:none`, Meet reads the element's
computed visibility to decide its button label. With `.a4cQT` hidden, the button reads
"Show captions" (`state = 'off'`). Do **not** use `getCaptionsToggleState()` to decide
whether to intercept — use your own CSS presence flag instead.

---

## 3. Why Closing the Panel Stops Recording

When the user clicks "Turn off captions":
1. Meet fires a server-side RPC to disable captions
2. The RTC `captions` DataChannel closes (`readyState → "closed"`)
3. Meet removes the `.a4cQT` DOM element
4. MutationObserver loses its target nodes

Simply re-creating the DataChannel from the MAIN world does **not** work — Meet only
sends caption data when the server considers captions logically ON. The only reliable
fix is to intercept the button click and prevent Meet from ever receiving it.

---

## 4. CSS-Based Visual Hide

### The rule
```js
function injectCaptionHideCSS() {
  if (document.getElementById('mr-captions-css')) return;
  const style = document.createElement('style');
  style.id = 'mr-captions-css';
  style.textContent =
    ".a4cQT," +
    "div[jsname='dsyhDe'],div[jsname='dqMPrb']," +
    "div:has(>div[jsname='dsyhDe']),div:has(>div[jsname='dqMPrb'])" +
    "{display:none!important}";
  (document.head || document.documentElement).appendChild(style);
}

function removeCaptionHideCSS() {
  document.getElementById('mr-captions-css')?.remove();
}
```

### Why `display:none` is safe for MutationObserver
Chrome's MutationObserver fires on DOM tree mutations regardless of CSS display state.
Nodes hidden with `display:none` are still in the document — JavaScript writes to them,
Meet updates them, and the observer callbacks fire normally.

### Why `.a4cQT` is needed
Without `.a4cQT`, the inner text nodes are hidden but the outer container still occupies
space — leaving an empty black bar at the bottom. Adding `.a4cQT` collapses everything.

---

## 5. Click Interception (Monkey-Patching the Toggle)

Instead of monkey-patching the function, we use a **capturing-phase DOM event listener**:

```js
function installCaptionsClickInterceptor() {
  document.addEventListener('click', handleCaptionsButtonClick, true); // true = capture phase
}
function removeCaptionsClickInterceptor() {
  document.removeEventListener('click', handleCaptionsButtonClick, true);
}
```

The capture phase fires **before** the target element's own listeners, so `stopImmediatePropagation()` + `preventDefault()` fully prevents Meet from handling it.

```js
function handleCaptionsButtonClick(event) {
  if (!STATE.recording) return;
  if (STATE.programmaticCaptionClick) return; // allow our own button.click() through

  const el = event.target.closest('button, [role="button"]');
  if (!el || !isCaptionsToggleCandidate(el)) return;

  event.stopImmediatePropagation();
  event.preventDefault();

  // Use CSS presence — NOT button label — as the toggle state.
  if (document.getElementById('mr-captions-css')) {
    removeCaptionHideCSS();
    window.dispatchEvent(new Event('resize')); // trigger Meet tile layout recalc
    ensureCaptionsEnabled();                   // re-confirm server-side ON
  } else {
    injectCaptionHideCSS();
    window.dispatchEvent(new Event('resize'));
  }
}
```

### The `programmaticCaptionClick` guard
`ensureCaptionsEnabled()` calls `button.click()` to turn captions on when they have dropped.
Without a guard, our interceptor catches its own click → toggles CSS → loops.

```js
function ensureCaptionsEnabled() {
  const button = findCaptionsToggleButton();
  if (getCaptionsToggleState(button) === "off" && button) {
    STATE.programmaticCaptionClick = true;
    button.click();
    STATE.programmaticCaptionClick = false; // synchronous, clears before any async work
  }
}
```

---

## 6. Video Tile Layout Shift

When `.a4cQT` is hidden/shown, Meet does not automatically recalculate tile sizes.
Dispatching a synthetic `resize` event fixes this:

```js
window.dispatchEvent(new Event('resize'));
```

Call this **after** both `injectCaptionHideCSS()` and `removeCaptionHideCSS()`,
and also in `stopCapture()` when the bar is permanently restored.

---

## 7. Caption-Keeper (Watchdog)

Even with interception, the server-side captions state can drop (network hiccup, Meet
reconnect, etc.). A periodic watchdog re-enables them:

```js
// In the 1500ms interval:
function maybeKeepCaptionsEnabled() {
  if (!STATE.recording) return;
  const silentFor = Date.now() - STATE.lastEventAt;
  if (silentFor < 8000) return;                       // captions are flowing
  if (Date.now() - STATE.lastCaptionKeeperAttemptAt < 5000) return; // rate-limit
  const button = findCaptionsToggleButton();
  if (getCaptionsToggleState(button) === 'off') {
    STATE.lastCaptionKeeperAttemptAt = Date.now();
    button.click(); // guarded by programmaticCaptionClick flag
  }
}
```

Also triggered on RTC channel close event (DataChannel `close` event → 800ms delay → re-enable).

---

## 8. Full `startCapture` / `stopCapture` Flow

```js
function startCapture() {
  // ... reset state counters ...
  postRecoveryCommand("RECORDING_STARTED");     // tell MAIN world to watch RTC channel
  installCaptionsClickInterceptor();            // intercept button before anything
  ensureCaptionsEnabled();                      // turn on server-side if off
  injectCaptionHideCSS();                       // hide immediately (CSS selector waits for .a4cQT)
  window.dispatchEvent(new Event('resize'));    // expand video tile
  startObserver();                              // attach MutationObserver to caption regions
  startWatchdog();                              // periodic recovery
}

function stopCapture() {
  STATE.recording = false;
  removeCaptionHideCSS();                       // restore bar
  window.dispatchEvent(new Event('resize'));    // shrink video tile back
  removeCaptionsClickInterceptor();             // stop intercepting
  postRecoveryCommand("RECORDING_STOPPED");    // tell MAIN world to stop
  stopObserver();
  stopWatchdog();
}
```

---

## 9. Pitfalls & Lessons Learned

| Problem | Root Cause | Fix |
|---------|-----------|-----|
| Re-creating DataChannel didn't resume captions | Meet only sends data when server-side captions are ON | Intercept the button click instead |
| Button label was always "Show captions" | Meet reads `.a4cQT` DOM visibility for label — hidden = shows "off" state | Use `document.getElementById('mr-captions-css')` as truth, not button label |
| Interceptor caught its own `ensureCaptionsEnabled()` click | `button.click()` is a real DOM event, capture phase catches it too | `programmaticCaptionClick` flag: set to `true` before `.click()`, reset after |
| Empty black bar remained after hiding text | `.a4cQT` outer container still visible | Add `.a4cQT` to the CSS rule |
| Video tile didn't expand/contract | Meet only updates layout on `resize` | `window.dispatchEvent(new Event('resize'))` after every CSS toggle |
| Watchdog triggered infinite loop | Watchdog called `ensureCaptionsEnabled()` → click → interceptor removed CSS → CSS gone → watchdog fires again | Same `programmaticCaptionClick` guard |

---

## 10. Tested Use Cases

**UC1** — Captions open before recording starts:
- Press Start → bar hidden instantly → video expands → recording ✓
- Click captions button → bar reappears with frame → video shifts down ✓
- Click again → bar hides → video shifts up ✓

**UC2** — Captions closed before recording starts:
- Press Start → `ensureCaptionsEnabled()` triggers Meet to create `.a4cQT` → CSS selector is already waiting → element hidden the instant it's inserted → video stays full ✓
- Toggle works same as UC1 ✓

**Both UCs**: Stopping recording removes CSS → bar restored → recording stops cleanly ✓
