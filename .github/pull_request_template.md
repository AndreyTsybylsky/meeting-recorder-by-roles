## Summary

- What changed?
- Why was it needed?
- Any user-visible impact?

## Scope

- [ ] Meet
- [ ] Teams
- [ ] Zoom
- [ ] Popup / Email flow
- [ ] Storage / session persistence
- [ ] UI / styling

## Manual Test Checklist

### Core Flow
- [ ] Start recording works
- [ ] Stop recording works
- [ ] Transcript lines appear in sidebar
- [ ] Download `.txt` works and file is not empty
- [ ] Clear current transcript works

### Platform Smoke Tests
- [ ] Google Meet: caption capture works
- [ ] Microsoft Teams: widget appears only in active call
- [ ] Microsoft Teams: caption capture works
- [ ] Zoom: widget appears in active call
- [ ] Zoom: caption capture works

### Multi-Tab / Multi-Meeting Safety
- [ ] Two different meetings in parallel do not mix transcript state
- [ ] Stopping recording in one tab does not stop another active tab
- [ ] No runtime errors when multiple meeting tabs are open

### Cross-Platform Shortcuts / UX
- [ ] Windows: Ctrl+C copies selected sidebar transcript text
- [ ] macOS: Cmd+C copies selected sidebar transcript text
- [ ] Platform-specific hints (if touched) are correct

### Session History / Data Integrity
- [ ] Session is saved in history after stop/end-call
- [ ] No duplicate phrase spam in saved transcript
- [ ] Speaker names are parsed correctly (no obvious prefix duplication)

## Regression Check

- [ ] Existing Meet behavior not degraded
- [ ] Existing Teams behavior not degraded
- [ ] Existing Zoom behavior not degraded
- [ ] Existing popup/session history behavior not degraded

## Risks and Rollback

- Risk level: [ ] Low [ ] Medium [ ] High
- Main risk areas:
  - 
- Rollback plan:
  - 

## Release Notes (Optional)

- 