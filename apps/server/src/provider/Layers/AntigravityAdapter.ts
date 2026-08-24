/**
 * AntigravityAdapterLive - Scoped live implementation for the Antigravity provider adapter.
 *
 * Wraps the Antigravity session runtime behind the `AntigravityAdapter` service
 * contract and maps runtime events/failures into the shared provider architecture.
 *
 * @module AntigravityAdapterLive
 */
import {
  ApprovalRequestId,
  type AntigravitySettings,
  CanonicalItemType,
  EventId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  RuntimeRequestId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { AntigravityAdapterShape } from "../Services/AntigravityAdapter.ts";
import {
  ANTIGRAVITY_RESUME_VERSION,
  type AntigravityResumeCursor,
  type AntigravitySessionRuntimeError,
  type AntigravitySessionRuntimeOptions,
  type AntigravitySessionRuntimeShape,
  classifyRequestType,
  getAntigravityToolDetail,
  isRecoverableAntigravityError,
  makeAntigravitySessionRuntime,
  mapAntigravityToolToCanonicalItemType,
  parseAntigravityResume,
  resolveAntigravitySpawnCommand,
} from "./AntigravitySessionRuntime.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";

export {
  ANTIGRAVITY_RESUME_VERSION,
  type AntigravityResumeCursor,
  parseAntigravityResume,
  resolveAntigravitySpawnCommand,
  classifyRequestType,
  mapAntigravityToolToCanonicalItemType,
  getAntigravityToolDetail,
  isRecoverableAntigravityError,
};

const PROVIDER = ProviderDriverKind.make("antigravity");

const isProviderAdapterSessionNotFoundError = Schema.is(ProviderAdapterSessionNotFoundError);

export interface AntigravityAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly instanceId?: ProviderInstanceId;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly makeRuntime?: (
    options: AntigravitySessionRuntimeOptions,
  ) => Effect.Effect<
    AntigravitySessionRuntimeShape,
    AntigravitySessionRuntimeError,
    ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope
  >;
}

interface AntigravityAdapterSessionContext {
  readonly threadId: ThreadId;
  readonly scope: Scope.Closeable;
  readonly runtime: AntigravitySessionRuntimeShape;
  readonly eventFiber: Fiber.Fiber<void, never>;
  stopped: boolean;
}

function mapAntigravityRuntimeError(
  threadId: ThreadId,
  method: string,
  error: unknown,
): ProviderAdapterError {
  if (isProviderAdapterSessionNotFoundError(error)) {
    return error;
  }
  const detail =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "detail" in error
        ? String((error as { detail: unknown }).detail)
        : String(error);

  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail,
    cause: error,
  });
}

export function makeAntigravityAdapter(
  settings: AntigravitySettings,
  options: AntigravityAdapterLiveOptions = {},
): Effect.Effect<
  AntigravityAdapterShape,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope
> {
  return Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const crypto = yield* Crypto.Crypto;
    const maybeServerConfig = yield* Effect.serviceOption(ServerConfig);
    const attachmentsDir = Option.isSome(maybeServerConfig)
      ? maybeServerConfig.value.attachmentsDir
      : process.cwd();
    const processEnv = options.environment ?? process.env;
    const instanceId = options.instanceId ?? ProviderInstanceId.make("antigravity");
    const runtimeFactory = options.makeRuntime ?? makeAntigravitySessionRuntime;
    const nativeLogger = options.nativeEventLogger;

    const sessionsRef = yield* Ref.make(new Map<ThreadId, AntigravityAdapterSessionContext>());
    const eventsPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const emitEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
      PubSub.publish(eventsPubSub, event).pipe(Effect.asVoid);

    const getSessionContext = (
      threadId: ThreadId,
    ): Effect.Effect<AntigravityAdapterSessionContext, ProviderAdapterSessionNotFoundError> =>
      Effect.gen(function* () {
        const sessions = yield* Ref.get(sessionsRef);
        const ctx = sessions.get(threadId);
        if (!ctx || ctx.stopped) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }
        return ctx;
      });

    const startSession: AntigravityAdapterShape["startSession"] = (input) =>
      Effect.gen(function* () {
        const existingSessions = yield* Ref.get(sessionsRef);
        const existing = existingSessions.get(input.threadId);
        if (existing && !existing.stopped) {
          yield* stopSession(input.threadId).pipe(Effect.catchCause(() => Effect.void));
        }

        const sessionScope = yield* Scope.make("sequential");
        const resume = parseAntigravityResume(input.resumeCursor);
        const requestedModel = input.modelSelection?.model ?? "gemini-3.7-flash";
        const effortOption = input.modelSelection?.options?.find((opt) => opt.id === "effort");
        const rawEffort =
          typeof effortOption?.value === "string" ? effortOption.value.trim().toLowerCase() : "";
        const effortValue = ["low", "medium", "high"].includes(rawEffort) ? rawEffort : "medium";
        const contextWindowOption = input.modelSelection?.options?.find(
          (opt) => opt.id === "contextWindow",
        );
        const contextWindowValue =
          typeof contextWindowOption?.value === "string"
            ? contextWindowOption.value.trim().toLowerCase()
            : undefined;

        const runtime = yield* runtimeFactory({
          threadId: input.threadId,
          providerInstanceId: instanceId,
          settings,
          environment: processEnv,
          cwd: input.cwd ?? process.cwd(),
          runtimeMode: input.runtimeMode ?? "full-access",
          model: requestedModel,
          effort: effortValue,
          ...(contextWindowValue !== undefined ? { contextWindow: contextWindowValue } : {}),
          ...(resume !== undefined ? { resumeCursor: resume } : {}),
          ...(nativeLogger ? { nativeEventLogger: nativeLogger } : {}),
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(Scope.Scope, sessionScope),
          Effect.mapError(
            (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: `Failed to construct Antigravity session runtime: ${cause}`,
                cause,
              }),
          ),
        );

        const startResult = yield* runtime.start().pipe(
          Effect.mapError((cause) =>
            mapAntigravityRuntimeError(input.threadId, "startSession", cause),
          ),
          Effect.result,
        );

        if (Result.isFailure(startResult)) {
          // The runtime owns its internal scope; without an explicit close a
          // failed start would leak any fibers/queues it created.
          yield* runtime.close.pipe(Effect.catchCause(() => Effect.void));
          return yield* startResult.failure;
        }

        const session = startResult.success;

        // Forward runtime events to adapter pubsub
        const eventFiber = yield* runtime.events.pipe(
          Stream.runForEach((event) => emitEvent(event)),
          Effect.catchCause((cause) =>
            Effect.logWarning("antigravity.events.forward.error", { cause }),
          ),
          Effect.forkIn(sessionScope),
        );

        const sessionCtx: AntigravityAdapterSessionContext = {
          threadId: input.threadId,
          scope: sessionScope,
          runtime,
          eventFiber,
          stopped: false,
        };

        yield* Ref.update(sessionsRef, (map) => new Map(map).set(input.threadId, sessionCtx));

        return session;
      });

    const sendTurn: AntigravityAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = yield* getSessionContext(input.threadId);

        const mappedAttachments: Array<{
          type: "image" | "file";
          path?: string;
          name?: string;
        }> = [];

        if (input.attachments && input.attachments.length > 0) {
          for (const att of input.attachments) {
            if (att.type !== "image") continue;
            const imgPath = resolveAttachmentPath({
              attachmentsDir,
              attachment: att,
            });
            if (!imgPath) continue;
            mappedAttachments.push({
              type: "image",
              path: imgPath,
              name: att.name,
            });
          }
        }

        const effortOption = input.modelSelection?.options?.find((opt) => opt.id === "effort");
        const rawEffort =
          typeof effortOption?.value === "string" ? effortOption.value.trim().toLowerCase() : "";
        const effortValue = ["low", "medium", "high"].includes(rawEffort) ? rawEffort : undefined;
        const contextWindowOption = input.modelSelection?.options?.find(
          (opt) => opt.id === "contextWindow",
        );
        const contextWindowValue =
          typeof contextWindowOption?.value === "string"
            ? contextWindowOption.value.trim().toLowerCase()
            : undefined;

        return yield* ctx.runtime
          .sendTurn({
            ...(typeof input.input === "string" ? { input: input.input } : {}),
            ...(mappedAttachments.length > 0 ? { attachments: mappedAttachments } : {}),
            ...(input.modelSelection?.model !== undefined
              ? { model: input.modelSelection.model }
              : {}),
            ...(effortValue !== undefined ? { effort: effortValue } : {}),
            ...(contextWindowValue !== undefined ? { contextWindow: contextWindowValue } : {}),
            ...(input.interactionMode !== undefined
              ? { interactionMode: input.interactionMode }
              : {}),
          })
          .pipe(
            Effect.mapError((cause) =>
              mapAntigravityRuntimeError(input.threadId, "sendTurn", cause),
            ),
          );
      });

    const interruptTurn: AntigravityAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.gen(function* () {
        const ctx = yield* getSessionContext(threadId);
        yield* ctx.runtime
          .interruptTurn(turnId)
          .pipe(
            Effect.mapError((cause) =>
              mapAntigravityRuntimeError(threadId, "interruptTurn", cause),
            ),
          );
      });

    const respondToRequest: AntigravityAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* getSessionContext(threadId).pipe(
          Effect.mapError((err) => mapAntigravityRuntimeError(threadId, "respondToRequest", err)),
        );
        yield* ctx.runtime
          .respondToRequest(requestId, decision)
          .pipe(
            Effect.mapError((cause) =>
              mapAntigravityRuntimeError(threadId, "respondToRequest", cause),
            ),
          );
      });

    const respondToUserInput: AntigravityAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* getSessionContext(threadId).pipe(
          Effect.mapError((err) => mapAntigravityRuntimeError(threadId, "respondToUserInput", err)),
        );
        yield* ctx.runtime
          .respondToUserInput(requestId, answers)
          .pipe(
            Effect.mapError((cause) =>
              mapAntigravityRuntimeError(threadId, "respondToUserInput", cause),
            ),
          );
      });

    const stopSession = (
      threadId: ThreadId,
    ): Effect.Effect<void, ProviderAdapterSessionNotFoundError> =>
      Effect.gen(function* () {
        const sessions = yield* Ref.get(sessionsRef);
        const ctx = sessions.get(threadId);
        if (!ctx) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }

        ctx.stopped = true;
        yield* ctx.runtime.close.pipe(Effect.catchCause(() => Effect.void));
        yield* Scope.close(ctx.scope, Exit.void);

        yield* Ref.update(sessionsRef, (map) => {
          const next = new Map(map);
          next.delete(threadId);
          return next;
        });
      });

    const stopAll = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        const sessions = yield* Ref.get(sessionsRef);
        for (const threadId of sessions.keys()) {
          yield* stopSession(threadId).pipe(Effect.catchCause(() => Effect.void));
        }
      });

    const listSessions = (): Effect.Effect<ReadonlyArray<ProviderSession>> =>
      Effect.gen(function* () {
        const sessions = yield* Ref.get(sessionsRef);
        const result: Array<ProviderSession> = [];
        for (const ctx of sessions.values()) {
          if (!ctx.stopped) {
            const sess = yield* ctx.runtime.getSession;
            result.push(sess);
          }
        }
        return result;
      });

    const hasSession = (threadId: ThreadId): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const sessions = yield* Ref.get(sessionsRef);
        const ctx = sessions.get(threadId);
        return ctx !== undefined && !ctx.stopped;
      });

    const readThread: AntigravityAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* getSessionContext(threadId);
        return yield* ctx.runtime.readThread.pipe(
          Effect.mapError((cause) => mapAntigravityRuntimeError(threadId, "readThread", cause)),
        );
      });

    const rollbackThread: AntigravityAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        const ctx = yield* getSessionContext(threadId);
        return yield* ctx.runtime
          .rollbackThread(numTurns)
          .pipe(
            Effect.mapError((cause) =>
              mapAntigravityRuntimeError(threadId, "rollbackThread", cause),
            ),
          );
      });

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
      },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      streamEvents: Stream.fromPubSub(eventsPubSub),
    };
  });
}
