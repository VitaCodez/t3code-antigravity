import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { AntigravitySettings, ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import { makeAntigravityTextGeneration } from "./AntigravityTextGeneration.ts";

const decodeAntigravitySettings = Schema.decodeSync(AntigravitySettings);

function mockJsonSpawnerHandle(jsonResponse: string) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1234),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    stdout: Stream.make(new TextEncoder().encode(jsonResponse)),
    stderr: Stream.empty,
  });
}

const makeMockSpawnerLayer = (response: string) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.succeed(mockJsonSpawnerHandle(response))),
  );

describe("AntigravityTextGeneration", () => {
  it.effect("generates commit message from model output", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const mockResponse =
          '```json\n{"subject": "feat: add user authentication", "body": "- add login form\\n- add token validation"}\n```';
        const layer = Layer.mergeAll(NodeServices.layer, makeMockSpawnerLayer(mockResponse));

        const testEffect = Effect.gen(function* () {
          const settings = decodeAntigravitySettings({ enabled: true });
          const tg = yield* makeAntigravityTextGeneration(settings);

          const result = yield* tg.generateCommitMessage({
            cwd: process.cwd(),
            branch: "main",
            stagedSummary: "add login form and token validation",
            stagedPatch: "diff --git a/auth.ts b/auth.ts...",
            modelSelection: createModelSelection(
              ProviderInstanceId.make("antigravity"),
              "gemini-3.7-flash",
            ),
          });

          expect(result.subject).toBe("feat: add user authentication");
          expect(result.body).toContain("add login form");
        });

        yield* Effect.provide(testEffect, layer);
      }),
    ),
  );

  it.effect("falls back gracefully to sanitized summary when CLI fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const failingSpawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.succeed(
              ChildProcessSpawner.makeHandle({
                pid: ChildProcessSpawner.ProcessId(1234),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
                stdout: Stream.empty,
                stderr: Stream.make(new TextEncoder().encode("CLI error")),
              }),
            ),
          ),
        );
        const layer = Layer.mergeAll(NodeServices.layer, failingSpawnerLayer);

        const testEffect = Effect.gen(function* () {
          const settings = decodeAntigravitySettings({ enabled: true });
          const tg = yield* makeAntigravityTextGeneration(settings);

          const result = yield* tg.generateCommitMessage({
            cwd: process.cwd(),
            branch: "main",
            stagedSummary: "fix: resolve token expiration bug in auth middleware",
            stagedPatch: "diff...",
            modelSelection: createModelSelection(
              ProviderInstanceId.make("antigravity"),
              "gemini-3.7-flash",
            ),
          });

          expect(result.subject).toBe("fix: resolve token expiration bug in auth middleware");
        });

        yield* Effect.provide(testEffect, layer);
      }),
    ),
  );
});
