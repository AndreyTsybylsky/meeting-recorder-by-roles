# Local Whisper Backend

Minimal localhost Whisper backend for Meet Transcriber Phase 5.

## What It Does
- Exposes `GET /health`
- Exposes `POST /transcribe`
- Loads one Whisper model in the background on startup
- Returns `installing`, `ready`, or `error` on `/health`

This backend is intentionally narrow. It is for extension integration and end-to-end testing, not for production packaging yet.

## Runtime Choice
- Engine: `faster-whisper`
- Default model: `small`
- Default device: `cpu`
- Default compute type: `int8`
- Default bind address: `127.0.0.1:8765`

These defaults are meant to be conservative for Windows laptops while keeping Russian and English support.

## Quick Start

### 1. Create a virtual environment
```powershell
cd local-whisper-backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
```

### 2. Install dependencies
```powershell
pip install -r requirements.txt
```

### 3. Run the server
```powershell
python server.py
```

The extension default endpoint should now work:
- `http://127.0.0.1:8765/health`
- `http://127.0.0.1:8765/transcribe`

### 4. Run the smoke check
Health only:
```powershell
python smoke_test.py
```

Health plus transcription:
```powershell
python smoke_test.py --audio path\to\sample.webm --language ru
```

## Configuration

Environment variables:
- `WHISPER_MODEL`: default `small`
- `WHISPER_DEVICE`: default `cpu`
- `WHISPER_COMPUTE_TYPE`: default `int8`
- `WHISPER_HOST`: default `127.0.0.1`
- `WHISPER_PORT`: default `8765`
- `WHISPER_LOG_LEVEL`: default `INFO`

Example:
```powershell
$env:WHISPER_MODEL = "small"
$env:WHISPER_DEVICE = "cpu"
$env:WHISPER_COMPUTE_TYPE = "int8"
python server.py
```

## Health Response Example
```json
{
  "status": "ready",
  "engine": "faster-whisper",
  "version": "0.1.0",
  "model": "small",
  "device": "cpu",
  "compute_type": "int8",
  "language": "multilingual"
}
```

## Notes
- The model loads asynchronously on startup, so `/health` may briefly return `installing`.
- If model loading fails, `/health` returns `error` and includes the failure message.
- `POST /transcribe` returns non-200 while the backend is not ready, which matches the extension's current error handling.
- `smoke_test.py` polls `/health` until the backend becomes `ready`, then optionally validates `/transcribe` with a sample audio file.