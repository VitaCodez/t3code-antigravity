"""
Antigravity Python SDK bridge daemon for T3 Code.

Runs as a long-lived child process and speaks the same newline-delimited
JSON protocol over stdin/stdout as the `agy --input-format stream-json
--output-format stream-json` CLI, so T3 Code can drive either backend
without knowing the difference.

Inbound (one JSON object per line on stdin):
  {"event": "user", "message": {"content": "..."}}
  {"event": "interrupt"}
  {"event": "permission_response", "request_id": "...", "decision": "accept"}
  {"event": "user_input_response", "request_id": "...", "answers": {...}}

Outbound (one JSON object per line on stdout):
  {"event": "init", "conversation_id": "..."}
  {"event": "step_update", "step_update": {...}}
  {"event": "result", "result": {...}}

Limitations: the google-antigravity SDK surface is probed defensively via
getattr; tool approval/questionnaire round-trips are emitted when the SDK
surfaces them, but this bridge does not synthesize them.
"""
import argparse
import asyncio
import json
import os
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


def emit_event(event_type: str, data: dict) -> None:
    payload = {"type": event_type, **data}
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


async def read_stdin_line() -> str:
    """Read one line of stdin without blocking the event loop."""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, sys.stdin.readline)


class BridgeState:
    def __init__(self) -> None:
        self.turn_task: asyncio.Task | None = None
        self.pending_requests: dict[str, asyncio.Future] = {}

    def resolve_request(self, request_id: str, payload: dict) -> bool:
        future = self.pending_requests.pop(str(request_id), None)
        if future is not None and not future.done():
            future.set_result(payload)
            return True
        return False


def build_prompt(content: str, cwd: str, images: list[str]) -> tuple[str, list[str]]:
    """Compose the user prompt with workspace/attachment context lines."""
    prompt = content
    if cwd and "[Active Workspace Folder:" not in prompt:
        prompt = f"[Active Workspace Folder: {cwd}]\n\n{prompt}"
    if images:
        image_refs = "\n".join(f"[Attached Image Path: {img}]" for img in images)
        prompt = f"{prompt}\n\n{image_refs}"
    return prompt, images


async def run_turn(agent, state: BridgeState, content: str, images: list[str], cwd: str) -> dict:
    """Execute one user turn against the SDK agent and stream NDJSON events.

    Returns the result payload that is also emitted as the terminal event.
    """
    conversation_id = (
        getattr(agent, "conversation_id", None)
        or getattr(getattr(agent, "session", None), "id", None)
        or ""
    )

    prompt, image_paths = build_prompt(content, cwd, images)

    try:
        import inspect

        chat = agent.chat
        kwargs = {}
        params = inspect.signature(chat).parameters if hasattr(chat, "__call__") else {}
        if image_paths and "images" in params:
            kwargs["images"] = image_paths
        response = await chat(prompt, **kwargs) if kwargs else await chat(prompt)
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        result = {
            "status": "ERROR",
            "error": f"Antigravity execution error: {exc}",
        }
        if conversation_id:
            result["conversation_id"] = str(conversation_id)
        return result

    async def stream_thoughts() -> None:
        thoughts = getattr(response, "thoughts", None)
        if thoughts is None:
            return
        try:
            async for thought in thoughts:
                emit_event(
                    "step_update",
                    {
                        "step_update": {
                            "step_type": "thought",
                            "thought_delta": str(thought),
                            "conversation_id": str(conversation_id) if conversation_id else None,
                        }
                    },
                )
        except Exception:
            pass

    async def stream_tokens() -> None:
        async for token in response:
            text = token if isinstance(token, str) else str(token)
            emit_event(
                "step_update",
                {
                    "step_update": {
                        "step_type": "agent_response",
                        "text_delta": text,
                        "conversation_id": str(conversation_id) if conversation_id else None,
                    }
                },
            )

    try:
        tasks = [asyncio.create_task(stream_tokens())]
        # Thoughts are streamed concurrently so tokens are not buffered behind
        # a fully-buffered thought iterator.
        thought_task = asyncio.create_task(stream_thoughts())
        tasks.append(thought_task)

        # Surface tool activity/approvals if the SDK exposes them live.
        tool_calls = getattr(response, "tool_calls", None)
        if tool_calls is not None:
            async def stream_tools() -> None:
                try:
                    async for call in tool_calls:
                        emit_event(
                            "step_update",
                            {
                                "step_update": {
                                    "step_type": "tool",
                                    "tool_name": getattr(call, "name", "action"),
                                    "state": "ACTIVE",
                                    "tool_info": {
                                        "parameters": getattr(call, "args", {})
                                        if isinstance(getattr(call, "args", {}), dict)
                                        else {},
                                    },
                                    "conversation_id": str(conversation_id)
                                    if conversation_id
                                    else None,
                                }
                            },
                        )
                        request_id = getattr(call, "approval_request_id", None)
                        if request_id:
                            future: asyncio.Future = asyncio.get_running_loop().create_future()
                            state.pending_requests[str(request_id)] = future
                            emit_event(
                                "step_update",
                                {
                                    "step_update": {
                                        "step_type": "tool",
                                        "tool_name": getattr(call, "name", "action"),
                                        "state": "PENDING_APPROVAL",
                                        "tool_info": {
                                            "parameters": getattr(call, "args", {})
                                            if isinstance(getattr(call, "args", {}), dict)
                                            else {}
                                        },
                                    }
                                },
                            )
                            decision = await future
                            emit_event(
                                "step_update",
                                {
                                    "step_update": {
                                        "step_type": "tool",
                                        "tool_name": getattr(call, "name", "action"),
                                        "state": "DONE"
                                        if decision.get("decision") == "accept"
                                        else "ERROR",
                                        "tool_info": {
                                            "parameters": getattr(call, "args", {})
                                            if isinstance(getattr(call, "args", {}), dict)
                                            else {}
                                        },
                                    }
                                },
                            )
                except Exception:
                    pass

            tasks.append(asyncio.create_task(stream_tools()))

        full_text_parts: list[str] = []
        try:
            async for token in response:
                text = token if isinstance(token, str) else str(token)
                full_text_parts.append(text)
        except Exception:
            pass

        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

        usage = getattr(response, "usage", None)
        usage_payload = None
        if isinstance(usage, dict):
            usage_payload = usage
        elif usage is not None:
            try:
                usage_payload = dict(usage)
            except Exception:
                usage_payload = None

        new_conversation_id = (
            getattr(agent, "conversation_id", None) or conversation_id or ""
        )
        result = {
            "status": "DONE",
            "response": "".join(full_text_parts),
        }
        if new_conversation_id:
            result["conversation_id"] = str(new_conversation_id)
        if usage_payload:
            result["usage"] = usage_payload
        return result
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        result = {
            "status": "ERROR",
            "error": f"Antigravity execution error: {exc}",
        }
        if conversation_id:
            result["conversation_id"] = str(conversation_id)
        return result


async def run_bridge(args: argparse.Namespace) -> int:
    try:
        from google.antigravity import Agent, CapabilitiesConfig, LocalAgentConfig
    except ImportError as e:
        sys.stderr.write(f"Error: google-antigravity SDK import failed: {e}\n")
        emit_event("done", {"exit_code": 1, "error": str(e)})
        return 1

    config_kwargs = {"capabilities": CapabilitiesConfig()}
    if args.cwd:
        config_kwargs["working_directory"] = args.cwd
    if args.conversation:
        config_kwargs.setdefault("conversation_id", args.conversation)

    try:
        config = LocalAgentConfig(**config_kwargs)
        agent = Agent(config)
        enter = getattr(agent, "__aenter__", None)
        if enter is not None:
            await enter()
    except Exception as exc:
        sys.stderr.write(f"Error: failed to initialize Antigravity agent: {exc}\n")
        emit_event("done", {"exit_code": 1, "error": str(exc)})
        return 1

    state = BridgeState()
    exit_code = 0

    conversation_id = (
        getattr(agent, "conversation_id", None) or args.conversation or ""
    )
    emit_event("init", {"conversation_id": str(conversation_id)})

    try:
        while True:
            line = await read_stdin_line()
            if not line:
                break
            line = line.strip()
            if not line:
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(message, dict):
                continue

            event = message.get("event")

            if event == "interrupt":
                turn_task = state.turn_task
                if turn_task is not None and not turn_task.done():
                    turn_task.cancel()
                    try:
                        await turn_task
                    except (asyncio.CancelledError, Exception):
                        pass
                state.pending_requests.clear()

            elif event in ("permission_response", "user_input_response"):
                request_id = message.get("request_id")
                if request_id is not None:
                    state.resolve_request(request_id, message)

            elif event == "user":
                previous_turn = state.turn_task
                if previous_turn is not None and not previous_turn.done():
                    # Serialize turns like the CLI daemon does.
                    await previous_turn
                content = ""
                message_body = message.get("message")
                if isinstance(message_body, dict):
                    content = str(message_body.get("content") or "")
                elif isinstance(message.get("input"), str):
                    content = message["input"]
                images_raw = message.get("images")
                images = [str(img) for img in images_raw] if isinstance(images_raw, list) else []
                state.turn_task = asyncio.create_task(
                    run_turn(agent, state, content, images, args.cwd)
                )

    finally:
        turn_task = state.turn_task
        if turn_task is not None and not turn_task.done():
            turn_task.cancel()
            try:
                await turn_task
            except (asyncio.CancelledError, Exception):
                pass
        exit_agent = getattr(agent, "__aexit__", None)
        if exit_agent is not None:
            try:
                await exit_agent(None, None, None)
            except Exception:
                pass

    emit_event("done", {"exit_code": exit_code})
    return exit_code


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="T3Code Antigravity SDK bridge daemon")
    parser.add_argument(
        "--input-format",
        default="stream-json",
        help="Expected inbound format (only stream-json is supported)",
    )
    parser.add_argument(
        "--output-format",
        default="stream-json",
        help="Expected outbound format (only stream-json is supported)",
    )
    parser.add_argument("--model", default="gemini-3.7-flash", help="Model slug")
    parser.add_argument("--effort", default="medium", help="Reasoning effort")
    parser.add_argument("--cwd", default="", help="Active workspace working directory")
    parser.add_argument("--conversation", default="", help="Existing Antigravity conversation id")
    parser.add_argument("--image", action="append", default=[], help="Image attachment file path")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.input_format != "stream-json" or args.output_format != "stream-json":
        sys.stderr.write("Error: only stream-json input/output formats are supported\n")
        emit_event("done", {"exit_code": 1, "error": "unsupported format"})
        sys.exit(1)

    if args.cwd and os.path.isdir(args.cwd):
        try:
            os.chdir(args.cwd)
        except OSError:
            pass

    exit_code = asyncio.run(run_bridge(args))
    if exit_code != 0:
        sys.exit(exit_code)


if __name__ == "__main__":
    main()
