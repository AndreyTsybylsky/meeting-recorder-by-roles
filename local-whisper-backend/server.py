import logging
import os
import tempfile
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from faster_whisper import WhisperModel


APP_VERSION = "0.1.0"
DEFAULT_MODEL = os.getenv("WHISPER_MODEL", "small")
DEFAULT_DEVICE = os.getenv("WHISPER_DEVICE", "cpu")
DEFAULT_COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE_TYPE", "int8")
DEFAULT_HOST = os.getenv("WHISPER_HOST", "127.0.0.1")
DEFAULT_PORT = int(os.getenv("WHISPER_PORT", "8765"))


logging.basicConfig(
    level=os.getenv("WHISPER_LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s [local-whisper-backend] %(message)s",
)
logger = logging.getLogger("local-whisper-backend")


class BackendRuntime:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._model: WhisperModel | None = None
        self._status = "installing"
        self._error = ""
        self._loaded_at = 0.0

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "status": self._status,
                "error": self._error,
                "loaded_at": self._loaded_at,
                "ready": self._model is not None,
            }

    def model(self) -> WhisperModel:
        with self._lock:
            if self._model is None:
                raise RuntimeError("model_not_ready")
            return self._model

    def set_installing(self) -> None:
        with self._lock:
            self._status = "installing"
            self._error = ""

    def set_ready(self, model: WhisperModel) -> None:
        with self._lock:
            self._model = model
            self._status = "ready"
            self._error = ""
            self._loaded_at = time.time()

    def set_error(self, error: str) -> None:
        with self._lock:
            self._model = None
            self._status = "error"
            self._error = error


runtime = BackendRuntime()


def load_model_background() -> None:
    runtime.set_installing()
    logger.info(
        "Loading Whisper model model=%s device=%s compute_type=%s",
        DEFAULT_MODEL,
        DEFAULT_DEVICE,
        DEFAULT_COMPUTE_TYPE,
    )
    try:
        model = WhisperModel(
            DEFAULT_MODEL,
            device=DEFAULT_DEVICE,
            compute_type=DEFAULT_COMPUTE_TYPE,
        )
    except Exception as exc:
        message = str(exc) or exc.__class__.__name__
        runtime.set_error(message)
        logger.exception("Failed to load Whisper model: %s", message)
        return

    runtime.set_ready(model)
    logger.info("Whisper model ready model=%s", DEFAULT_MODEL)


def start_model_loader() -> None:
    worker = threading.Thread(target=load_model_background, name="whisper-model-loader", daemon=True)
    worker.start()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    start_model_loader()
    yield


app = FastAPI(title="Local Whisper Backend", version=APP_VERSION, lifespan=lifespan)


@app.get("/health")
async def health() -> dict[str, Any]:
    snapshot = runtime.snapshot()
    response: dict[str, Any] = {
        "status": snapshot["status"],
        "engine": "faster-whisper",
        "version": APP_VERSION,
        "model": DEFAULT_MODEL,
        "device": DEFAULT_DEVICE,
        "compute_type": DEFAULT_COMPUTE_TYPE,
        "language": "multilingual",
    }
    if snapshot["error"]:
        response["error"] = snapshot["error"]
    if snapshot["loaded_at"]:
        response["loaded_at"] = snapshot["loaded_at"]
    return response


@app.post("/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    language: str | None = Form(default=None),
    task: str = Form(default="transcribe"),
) -> dict[str, Any]:
    snapshot = runtime.snapshot()
    if snapshot["status"] == "installing":
        raise HTTPException(status_code=503, detail="model_installing")
    if snapshot["status"] == "error":
        raise HTTPException(status_code=500, detail=snapshot["error"] or "model_error")

    model = runtime.model()
    filename = file.filename or "chunk.webm"
    suffix = Path(filename).suffix or ".webm"
    started_at = time.perf_counter()

    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temp_file:
        temp_path = Path(temp_file.name)
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            temp_file.write(chunk)

    try:
        segments_iter, info = model.transcribe(
            str(temp_path),
            language=language or None,
            task=task or "transcribe",
            vad_filter=True,
            beam_size=1,
        )
        segments = []
        text_parts = []
        for segment in segments_iter:
            segment_text = (segment.text or "").strip()
            if not segment_text:
                continue
            segments.append(
                {
                    "start": round(float(segment.start), 3),
                    "end": round(float(segment.end), 3),
                    "text": segment_text,
                }
            )
            text_parts.append(segment_text)
    except Exception as exc:
        message = str(exc) or exc.__class__.__name__
        logger.exception("Transcription failed file=%s error=%s", filename, message)
        raise HTTPException(status_code=500, detail=message) from exc
    finally:
        try:
            temp_path.unlink(missing_ok=True)
        except Exception:
            logger.warning("Failed to remove temp file path=%s", temp_path)

    elapsed_ms = round((time.perf_counter() - started_at) * 1000)
    transcript_text = " ".join(text_parts).strip()
    duration = round(float(segments[-1]["end"]), 3) if segments else 0.0
    logger.info(
        "Transcription complete file=%s duration=%.3f segments=%d latency_ms=%d",
        filename,
        duration,
        len(segments),
        elapsed_ms,
    )

    return {
        "text": transcript_text,
        "segments": segments,
        "language": getattr(info, "language", language or None),
        "duration": duration,
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=DEFAULT_HOST, port=DEFAULT_PORT)
