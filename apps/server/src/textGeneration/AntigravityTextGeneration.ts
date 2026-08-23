import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { type AntigravitySettings, TextGenerationError } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import { resolveAntigravitySpawnCommand } from "../provider/Layers/AntigravityAdapter.ts";

import * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

const ANTIGRAVITY_TEXT_TIMEOUT_MS = 60_000;

function parseJsonOutput<T>(raw: string): T | undefined {
  const jsonStr = extractJsonObject(raw);
  try {
    return JSON.parse(jsonStr) as T;
  } catch {
    return undefined;
  }
}

export const makeAntigravityTextGeneration = Effect.fn("makeAntigravityTextGeneration")(function* (
  settings: AntigravitySettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const runAntigravityCli = (
    prompt: string,
    cwd: string,
    model: string | undefined,
    operation: string,
  ): Effect.Effect<string, TextGenerationError> =>
    Effect.gen(function* () {
      const binary = settings.binaryPath || "agy";
      const args: Array<string> = [
        "--print",
        prompt,
        "--dangerously-skip-permissions",
        "--output-format",
        "text",
      ];
      if (model) {
        args.push("--model", model);
      }

      const spawnCommand = resolveAntigravitySpawnCommand(binary, args, environment);

      const child = yield* spawner
        .spawn(
          ChildProcess.make(spawnCommand.command, spawnCommand.args, {
            cwd,
            env: environment,
            shell: spawnCommand.shell,
          }),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation,
                detail: `Failed to spawn Antigravity CLI: ${cause}`,
                cause,
              }),
          ),
        );

      let stdout = "";
      yield* child.stdout.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) =>
          Effect.sync(() => {
            stdout += chunk;
          }),
        ),
      );

      const exitCode = yield* child.exitCode;
      if (exitCode !== 0) {
        return yield* Effect.fail(
          new TextGenerationError({
            operation,
            detail: `Antigravity CLI exited with code ${exitCode}`,
          }),
        );
      }

      return stdout.trim();
    }).pipe(Effect.timeout(ANTIGRAVITY_TEXT_TIMEOUT_MS));

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("AntigravityTextGeneration.generateCommitMessage")(function* (input) {
      const fallbackSubject = sanitizeCommitSubject(
        input.stagedSummary.slice(0, 72) || "update changes",
      );
      const fallbackBody = input.stagedSummary.trim();
      const fallbackBranch = input.includeBranch
        ? sanitizeBranchFragment(input.stagedSummary.slice(0, 30) || "feature-branch")
        : undefined;

      const prompt = buildCommitMessagePrompt(input);
      const cliResult = yield* runAntigravityCli(
        prompt,
        input.cwd,
        input.modelSelection?.model,
        "generateCommitMessage",
      ).pipe(Effect.option);

      if (cliResult._tag === "Some" && cliResult.value) {
        const parsed = parseJsonOutput<{ subject?: string; body?: string; branch?: string }>(
          cliResult.value,
        );
        if (parsed?.subject) {
          return {
            subject: sanitizeCommitSubject(parsed.subject),
            body: parsed.body ?? "",
            ...(input.includeBranch && parsed.branch
              ? { branch: sanitizeFeatureBranchName(parsed.branch) }
              : fallbackBranch !== undefined
                ? { branch: fallbackBranch }
                : {}),
          };
        }
      }

      return {
        subject: fallbackSubject,
        body: fallbackBody,
        ...(fallbackBranch !== undefined ? { branch: fallbackBranch } : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("AntigravityTextGeneration.generatePrContent")(function* (input) {
      const fallbackTitle = sanitizePrTitle(input.diffSummary.slice(0, 72) || "Update changes");
      const fallbackBody = input.diffSummary.trim();

      const prompt = buildPrContentPrompt(input);
      const cliResult = yield* runAntigravityCli(
        prompt,
        input.cwd,
        input.modelSelection?.model,
        "generatePrContent",
      ).pipe(Effect.option);

      if (cliResult._tag === "Some" && cliResult.value) {
        const parsed = parseJsonOutput<{ title?: string; body?: string }>(cliResult.value);
        if (parsed?.title) {
          return {
            title: sanitizePrTitle(parsed.title),
            body: parsed.body ?? "",
          };
        }
      }

      return {
        title: fallbackTitle,
        body: fallbackBody,
      };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("AntigravityTextGeneration.generateBranchName")(function* (input) {
      const fallbackBranch = sanitizeBranchFragment(input.message.slice(0, 30) || "feature-branch");

      const prompt = buildBranchNamePrompt(input);
      const cliResult = yield* runAntigravityCli(
        prompt,
        input.cwd,
        input.modelSelection?.model,
        "generateBranchName",
      ).pipe(Effect.option);

      if (cliResult._tag === "Some" && cliResult.value) {
        const parsed = parseJsonOutput<{ branch?: string }>(cliResult.value);
        if (parsed?.branch) {
          return {
            branch: sanitizeFeatureBranchName(parsed.branch),
          };
        }
      }

      return {
        branch: fallbackBranch,
      };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("AntigravityTextGeneration.generateThreadTitle")(function* (input) {
      const fallbackTitle = sanitizeThreadTitle(input.message.slice(0, 50) || "New Thread");

      const prompt = buildThreadTitlePrompt(input);
      const cliResult = yield* runAntigravityCli(
        prompt,
        input.cwd,
        input.modelSelection?.model,
        "generateThreadTitle",
      ).pipe(Effect.option);

      if (cliResult._tag === "Some" && cliResult.value) {
        const parsed = parseJsonOutput<{ title?: string }>(cliResult.value);
        if (parsed?.title) {
          return {
            title: sanitizeThreadTitle(parsed.title),
          };
        }
      }

      return {
        title: fallbackTitle,
      };
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
});
