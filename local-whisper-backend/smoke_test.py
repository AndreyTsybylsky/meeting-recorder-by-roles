import argparse
import json
import mimetypes
import sys
import time
import uuid
from pathlib import Path
from urllib import error, request


def get_json(url: str) -> tuple[int, dict]:
    with request.urlopen(url, timeout=10) as response:
        payload = response.read().decode("utf-8")
        return response.status, json.loads(payload or "{}")


def encode_multipart(fields: dict[str, str], file_field: str, file_path: Path) -> tuple[bytes, str]:
    boundary = f"----MeetTranscriber{uuid.uuid4().hex}"
    content_type = f"multipart/form-data; boundary={boundary}"
    lines: list[bytes] = []

    for key, value in fields.items():
        lines.extend([
            f"--{boundary}".encode("utf-8"),
            f'Content-Disposition: form-data; name="{key}"'.encode("utf-8"),
            b"",
            str(value).encode("utf-8"),
        ])

    filename = file_path.name
    mime_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    file_bytes = file_path.read_bytes()
    lines.extend([
        f"--{boundary}".encode("utf-8"),
        f'Content-Disposition: form-data; name="{file_field}"; filename="{filename}"'.encode("utf-8"),
        f"Content-Type: {mime_type}".encode("utf-8"),
        b"",
        file_bytes,
    ])
    lines.append(f"--{boundary}--".encode("utf-8"))
    lines.append(b"")
    return b"\r\n".join(lines), content_type


def post_transcribe(url: str, audio_path: Path, language: str) -> tuple[int, dict]:
    body, content_type = encode_multipart(
        {
            "language": language,
            "task": "transcribe",
        },
        "file",
        audio_path,
    )
    req = request.Request(
        url,
        data=body,
        headers={
            "Content-Type": content_type,
            "Content-Length": str(len(body)),
        },
        method="POST",
    )
    with request.urlopen(req, timeout=120) as response:
        payload = response.read().decode("utf-8")
        return response.status, json.loads(payload or "{}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Smoke test for the local Whisper backend")
    parser.add_argument("--base-url", default="http://127.0.0.1:8765", help="Backend base URL")
    parser.add_argument("--audio", help="Optional path to an audio sample for POST /transcribe")
    parser.add_argument("--language", default="ru", help="Language hint to send with /transcribe")
    parser.add_argument("--wait-ready", type=int, default=60, help="Seconds to wait for /health status=ready")
    args = parser.parse_args()

    health_url = args.base_url.rstrip("/") + "/health"
    transcribe_url = args.base_url.rstrip("/") + "/transcribe"

    deadline = time.time() + max(1, args.wait_ready)
    health_payload = {}
    while True:
        try:
            status_code, health_payload = get_json(health_url)
        except error.URLError as exc:
            print(f"HEALTH request failed: {exc}", file=sys.stderr)
            return 1
        except Exception as exc:
            print(f"HEALTH parse failed: {exc}", file=sys.stderr)
            return 1

        print(json.dumps({"endpoint": health_url, "status_code": status_code, "payload": health_payload}, ensure_ascii=False, indent=2))

        if status_code == 200 and health_payload.get("status") == "ready":
            break
        if time.time() >= deadline:
            print("Backend did not become ready before timeout", file=sys.stderr)
            return 2
        time.sleep(2)

    if not args.audio:
        return 0

    audio_path = Path(args.audio)
    if not audio_path.exists():
      print(f"Audio file not found: {audio_path}", file=sys.stderr)
      return 3

    try:
        status_code, payload = post_transcribe(transcribe_url, audio_path, args.language)
    except error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        print(f"TRANSCRIBE http error: {exc.code} {detail}", file=sys.stderr)
        return 4
    except Exception as exc:
        print(f"TRANSCRIBE failed: {exc}", file=sys.stderr)
        return 4

    print(json.dumps({"endpoint": transcribe_url, "status_code": status_code, "payload": payload}, ensure_ascii=False, indent=2))
    has_text = isinstance(payload.get("text"), str) and payload.get("text", "").strip() != ""
    has_transcript = isinstance(payload.get("transcript"), str) and payload.get("transcript", "").strip() != ""
    if not (has_text or has_transcript):
        print("TRANSCRIBE response missing text/transcript", file=sys.stderr)
        return 5
    return 0


if __name__ == "__main__":
    raise SystemExit(main())