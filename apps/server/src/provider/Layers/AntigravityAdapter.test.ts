import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  AntigravitySettings,
  ChatAttachment,
  ProviderDriverKind,
  ThreadId,
} from "@t3tools/contracts";

import { makeAntigravityAdapter } from "./AntigravityAdapter.ts";

const decodeAntigravitySettings = Schema.decodeSync(AntigravitySettings);
const PROVIDER = ProviderDriverKind.make("antigravity");

function mockSpawnerHandle() {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1234),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    stdout: Stream.make(new TextEncoder().encode("Hello from Antigravity mock")),
    stderr: Stream.empty,
  });
}

const mockSpawnerLayer = Layer.succeed(
  ChildProcessSpawner.ChildProcessSpawner,
  ChildProcessSpawner.make(() => Effect.succeed(mockSpawnerHandle())),
);

const testLayer = Layer.mergeAll(NodeServices.layer, mockSpawnerLayer);

it.layer(testLayer)("AntigravityAdapter", (it) => {
  it.effect("starts session and lists active session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const settings = decodeAntigravitySettings({ enabled: true });
        const adapter = yield* makeAntigravityAdapter(settings);

        const threadId = ThreadId.make("thread-test-1");
        const session = yield* adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });

        expect(session.provider).toBe(PROVIDER);
        expect(session.threadId).toBe(threadId);

        const sessions = yield* adapter.listSessions();
        expect(sessions.length).toBe(1);
        expect(sessions[0]?.threadId).toBe(threadId);

        yield* adapter.stopSession(threadId);
        const afterStop = yield* adapter.listSessions();
        expect(afterStop.length).toBe(0);
      }),
    ),
  );

  it.effect("emits session.started runtime event on startSession", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const settings = decodeAntigravitySettings({ enabled: true });
        const adapter = yield* makeAntigravityAdapter(settings);
        const threadId = ThreadId.make("thread-test-2");

        const [eventOpt] = yield* Effect.all(
          [
            Stream.runHead(adapter.streamEvents),
            adapter.startSession({
              threadId,
              cwd: process.cwd(),
              runtimeMode: "full-access",
            }),
          ],
          { concurrency: "unbounded" },
        );

        expect(Option.isSome(eventOpt)).toBe(true);
        if (Option.isSome(eventOpt)) {
          expect(eventOpt.value.type).toBe("session.started");
          expect(eventOpt.value.threadId).toBe(threadId);
        }
      }),
    ),
  );

  it.effect("handles sendTurn with image attachments gracefully", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const settings = decodeAntigravitySettings({ enabled: true });
        const adapter = yield* makeAntigravityAdapter(settings);
        const threadId = ThreadId.make("thread-test-3");

        yield* adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });

        const imageAttachment = {
          type: "image" as const,
          id: "thread-test-12345678-1234-1234-1234-123456789abc",
          mimeType: "image/png",
          name: "screenshot.png",
        } as unknown as ChatAttachment;

        const result = yield* adapter.sendTurn({
          threadId,
          input: "what is on the picture",
          attachments: [imageAttachment],
        });

        expect(result.threadId).toBe(threadId);
        expect(result.turnId).toBeDefined();
      }),
    ),
  );

  it.effect("includes active workspace cwd in sendTurn prompts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const settings = decodeAntigravitySettings({ enabled: true });
        const adapter = yield* makeAntigravityAdapter(settings);
        const threadId = ThreadId.make("thread-test-4");
        const customCwd = "/tmp/my-active-workspace";

        yield* adapter.startSession({
          threadId,
          cwd: customCwd,
          runtimeMode: "full-access",
        });

        const result = yield* adapter.sendTurn({
          threadId,
          input: "where am I?",
        });

        expect(result.threadId).toBe(threadId);
        expect(result.turnId).toBeDefined();
      }),
    ),
  );

  it.effect("restores conversationId from resumeCursor on startSession", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const settings = decodeAntigravitySettings({ enabled: true });
        const adapter = yield* makeAntigravityAdapter(settings);
        const threadId = ThreadId.make("thread-test-5");
        const existingConvId = "8c912790-21f6-47be-8ede-c7bd74d27f58";

        const session = yield* adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
          resumeCursor: {
            schemaVersion: 1,
            conversationId: existingConvId,
          },
        });

        expect(session.threadId).toBe(threadId);
        expect(session.resumeCursor).toEqual({
          schemaVersion: 1,
          conversationId: existingConvId,
        });

        const result = yield* adapter.sendTurn({
          threadId,
          input: "continue our chat",
        });

        expect(result.threadId).toBe(threadId);
      }),
    ),
  );
});
