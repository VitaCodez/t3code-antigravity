import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { AntigravitySettings } from "@t3tools/contracts";

import {
  buildInitialAntigravityProviderSnapshot,
  checkAntigravityProviderStatus,
} from "./AntigravityProvider.ts";
import { resolveAntigravitySpawnCommand } from "./AntigravityAdapter.ts";

const decodeAntigravitySettings = Schema.decodeSync(AntigravitySettings);

describe("buildInitialAntigravityProviderSnapshot", () => {
  it.effect("returns a disabled snapshot when settings.enabled is false", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialAntigravityProviderSnapshot(
        decodeAntigravitySettings({ enabled: false }),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("disabled");
    }),
  );

  it.effect("returns a pending snapshot when enabled with Gemini built-in models", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialAntigravityProviderSnapshot(
        decodeAntigravitySettings({ enabled: true }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.version).toBeNull();
      expect(snapshot.message).toContain("Checking Antigravity CLI");

      const modelSlugs = snapshot.models.map((m) => m.slug);
      expect(modelSlugs).toContain("gemini-3.7-flash");
      expect(modelSlugs).toContain("gemini-2.5-pro");
      expect(modelSlugs).toContain("gemini-2.0-flash");
      expect(modelSlugs).toContain("gemini-3.6-flash");

      const flashModel = snapshot.models.find((m) => m.slug === "gemini-3.7-flash");
      const flashContextWindow = flashModel?.capabilities?.optionDescriptors?.find(
        (d) => d.id === "contextWindow",
      );
      expect(flashContextWindow).toBeDefined();
      if (flashContextWindow?.type === "select") {
        expect(flashContextWindow.options.map((o) => o.id)).toEqual(["200k", "1m"]);
        expect(flashContextWindow.currentValue).toBe("1m");
      }

      const proModel = snapshot.models.find((m) => m.slug === "gemini-2.5-pro");
      const proContextWindow = proModel?.capabilities?.optionDescriptors?.find(
        (d) => d.id === "contextWindow",
      );
      expect(proContextWindow).toBeDefined();
      if (proContextWindow?.type === "select") {
        expect(proContextWindow.options.map((o) => o.id)).toEqual(["200k", "1m", "2m"]);
        expect(proContextWindow.currentValue).toBe("2m");
      }
    }),
  );
});

describe("resolveAntigravitySpawnCommand", () => {
  it("resolves basic command without shell on non-bat files", () => {
    const res = resolveAntigravitySpawnCommand("agy", ["--print", "hello"]);
    expect(res.command).toMatch(/agy(\.exe)?$/i);
    expect(res.args).toEqual(["--print", "hello"]);
    expect(res.shell).toBe(false);
  });
});

it.layer(NodeServices.layer)("checkAntigravityProviderStatus", (it) => {
  it.effect("reports binary as missing when binary path does not exist", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkAntigravityProviderStatus(
        decodeAntigravitySettings({
          enabled: true,
          binaryPath: "/non/existent/path/to/agy-binary",
        }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
    }),
  );

  it.effect("reports installed CLI as ready when --help exits 0", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-agy-test-" });
          const agyPath = path.join(dir, process.platform === "win32" ? "agy.cmd" : "agy");

          if (process.platform === "win32") {
            yield* fs.writeFileString(agyPath, "@echo off\r\necho agy v2.0.0\r\nexit /b 0\r\n");
          } else {
            yield* fs.writeFileString(agyPath, "#!/bin/sh\necho 'agy v2.0.0'\nexit 0\n");
            yield* fs.chmod(agyPath, 0o755);
          }

          return yield* checkAntigravityProviderStatus(
            decodeAntigravitySettings({ enabled: true, binaryPath: agyPath }),
          );
        }),
      );

      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("ready");
    }),
  );
});
