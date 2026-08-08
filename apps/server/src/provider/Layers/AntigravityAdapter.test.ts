import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";
import { AntigravitySettings, ProviderDriverKind, ThreadId } from "@t3tools/contracts";

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
});
