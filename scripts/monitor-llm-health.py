#!/usr/bin/env python3
"""One-shot, content-free health evidence for the model host.

Designed for launchd StartInterval. It logs only model presence, response shape,
latency and error class; prompts and generated text are never written.
"""

import argparse
import json
import re
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone


def request_json(request: urllib.request.Request, timeout: int) -> tuple[int, object]:
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.status, json.load(response)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--timeout", type=int, default=60)
    args = parser.parse_args()

    started = time.monotonic()
    result: dict[str, object] = {
        "observedAt": datetime.now(timezone.utc).isoformat(),
        "model": args.model,
        "modelPresent": False,
        "generationHttpStatus": None,
        "contentLength": 0,
        "reasoningLength": 0,
        "finishReason": None,
        "ok": False,
    }
    headers = {
        "content-type": "application/json",
        "x-nexa-client": "su-llm-monitor",
        "x-nexa-request-id": f"health-{uuid.uuid4()}",
    }

    try:
        models_request = urllib.request.Request(
            f"{args.base_url.rstrip('/')}/v1/models", headers=headers
        )
        models_status, models_body = request_json(models_request, args.timeout)
        model_ids = [
            item.get("id")
            for item in models_body.get("data", [])
            if isinstance(item, dict) and isinstance(item.get("id"), str)
        ] if isinstance(models_body, dict) else []
        result["modelsHttpStatus"] = models_status
        result["availableModelCount"] = len(model_ids)
        result["modelPresent"] = args.model in model_ids

        payload = json.dumps({
            "model": args.model,
            "messages": [
                {"role": "system", "content": "Return only the requested final answer."},
                {"role": "user", "content": "Answer with the single word OK."},
            ],
            "temperature": 0,
            "max_tokens": 512,
        }).encode()
        generation_request = urllib.request.Request(
            f"{args.base_url.rstrip('/')}/v1/chat/completions",
            data=payload,
            headers=headers,
            method="POST",
        )
        generation_status, generation_body = request_json(generation_request, args.timeout)
        choice = (generation_body.get("choices") or [{}])[0] if isinstance(generation_body, dict) else {}
        message = choice.get("message") or {} if isinstance(choice, dict) else {}
        raw_content = message.get("content") if isinstance(message.get("content"), str) else ""
        final_content = re.sub(r"<think>[\s\S]*?</think>|</?think>", "", raw_content).strip()
        reasoning = message.get("reasoning_content") if isinstance(message.get("reasoning_content"), str) else ""
        result.update({
            "generationHttpStatus": generation_status,
            "contentLength": len(final_content),
            "reasoningLength": len(reasoning),
            "finishReason": choice.get("finish_reason") if isinstance(choice, dict) else None,
            "ok": bool(result["modelPresent"] and generation_status == 200 and final_content),
        })
    except urllib.error.HTTPError as error:
        result.update({"errorType": "HTTPError", "errorStatus": error.code})
    except Exception as error:  # exception text can contain a URL or response detail; log only its class
        result.update({"errorType": type(error).__name__})

    result["latencyMs"] = round((time.monotonic() - started) * 1000)
    print(json.dumps(result, separators=(",", ":")), flush=True)
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
