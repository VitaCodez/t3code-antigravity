"""
Antigravity Python SDK bridge script for T3Code.
Interacts with google.antigravity Python SDK and streams JSON events to stdout.
"""
import argparse
import asyncio
import json
import sys

def emit_event(event_type: str, data: dict):
    payload = {"type": event_type, **data}
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()

async def main():
    parser = argparse.ArgumentParser(description="T3Code Antigravity SDK Bridge")
    parser.add_argument("--prompt", required=True, help="User prompt")
    parser.add_argument("--model", default="gemini-3.6-flash", help="Model slug")
    parser.add_argument("--effort", default="medium", help="Reasoning effort")
    args = parser.parse_args()

    try:
        from google.antigravity import Agent, LocalAgentConfig, CapabilitiesConfig
    except ImportError as e:
        sys.stderr.write(f"Error: google-antigravity SDK import failed: {e}\n")
        sys.exit(1)

    try:
        config = LocalAgentConfig(
            capabilities=CapabilitiesConfig(),
        )

        async with Agent(config) as agent:
            response = await agent.chat(args.prompt)

            # Stream thinking thoughts if available
            if hasattr(response, "thoughts"):
                async for thought in response.thoughts:
                    emit_event("thought", {"content": str(thought)})

            # Stream tokens
            async for token in response:
                emit_event("token", {"content": str(token)})

            # Stream tool calls if available
            if hasattr(response, "tool_calls"):
                async for call in response.tool_calls:
                    emit_event("tool_call", {
                        "name": getattr(call, "name", "tool"),
                        "args": getattr(call, "args", {})
                    })

            emit_event("done", {"exit_code": 0})

    except Exception as exc:
        sys.stderr.write(f"Antigravity execution error: {exc}\n")
        emit_event("done", {"exit_code": 1, "error": str(exc)})
        sys.exit(1)

if __name__ == "__main__":
    asyncio.run(main())
