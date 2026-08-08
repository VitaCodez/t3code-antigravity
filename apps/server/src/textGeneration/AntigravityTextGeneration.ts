import * as Effect from "effect/Effect";
import type { AntigravitySettings } from "@t3tools/contracts";
import { sanitizeBranchFragment } from "@t3tools/shared/git";

import * as TextGeneration from "./TextGeneration.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

export const makeAntigravityTextGeneration = Effect.fn("makeAntigravityTextGeneration")(function* (
  _settings: AntigravitySettings,
  _environment: NodeJS.ProcessEnv = process.env,
) {
  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("AntigravityTextGeneration.generateCommitMessage")(function* (input) {
      return {
        subject: sanitizeCommitSubject(input.stagedSummary.slice(0, 72) || "update changes"),
        body: input.stagedSummary.trim(),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("AntigravityTextGeneration.generatePrContent")(function* (input) {
      return {
        title: sanitizePrTitle(input.diffSummary.slice(0, 72) || "Update changes"),
        body: input.diffSummary.trim(),
      };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("AntigravityTextGeneration.generateBranchName")(function* (input) {
      return {
        branch: sanitizeBranchFragment(input.message.slice(0, 30) || "feature-branch"),
      };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("AntigravityTextGeneration.generateThreadTitle")(function* (input) {
      return {
        title: sanitizeThreadTitle(input.message.slice(0, 50) || "New Thread"),
      };
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
});
