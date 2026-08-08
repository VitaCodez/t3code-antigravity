import {
  ApprovalRequestId,
  type AntigravitySettings,
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
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = NodePath.dirname(__filename);

export function resolveAntigravitySpawnCommand(
  binary: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv = process.env,
): { command: string; args: Array<string>; shell: boolean } {
  if (process.platform !== "win32") {
    let resolved = binary;
    if (!binary.includes("/")) {
      const home = env.HOME?.trim();
      if (home && NodeFS.existsSync(`${home}/.gemini/antigravity/bin/agy`)) {
        resolved = `${home}/.gemini/antigravity/bin/agy`;
      }
    }
    return { command: resolved, args: [...args], shell: false };
  }

  let resolvedBinary = binary;
  if (!binary.includes("\\") && !binary.includes("/")) {
    const localAppData = env.LOCALAPPDATA?.trim();
    const userProfile = env.USERPROFILE?.trim();
    if (localAppData && NodeFS.existsSync(`${localAppData}\\agy\\bin\\agy.exe`)) {
      resolvedBinary = `${localAppData}\\agy\\bin\\agy.exe`;
    } else if (
      userProfile &&
      NodeFS.existsSync(`${userProfile}\\.gemini\\antigravity\\bin\\agy.exe`)
    ) {
      resolvedBinary = `${userProfile}\\.gemini\\antigravity\\bin\\agy.exe`;
    }
  }

  const isCmdOrBat =
    resolvedBinary.toLowerCase().endsWith(".cmd") || resolvedBinary.toLowerCase().endsWith(".bat");

  if (!isCmdOrBat) {
    return { command: resolvedBinary, args: [...args], shell: false };
  }

  const escapedArgs = args.map((arg) => {
    let escaped = arg.replace(/(\\*)"/g, '$1$1\\"');
    escaped = escaped.replace(/(\\*)$/, "$1$1");
    return `"${escaped}"`.replace(/([()\][%!^"`<>&|;, *?])/g, "^$1");
  });

  return { command: resolvedBinary, args: escapedArgs, shell: true };
}

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
} from "../Errors.ts";
import type { AntigravityAdapterShape } from "../Services/AntigravityAdapter.ts";

const PROVIDER = ProviderDriverKind.make("antigravity");

export interface AntigravityAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly instanceId?: ProviderInstanceId;
}

interface AntigravitySessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  activeFiber: Fiber.Fiber<void, never> | undefined;
  activeTurnId: TurnId | undefined;
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
  currentModelId: string | undefined;
}

export function makeAntigravityAdapter(
  settings: AntigravitySettings,
  options: AntigravityAdapterLiveOptions = {},
): Effect.Effect<
  AntigravityAdapterShape,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> {
  return Effect.gen(function* () {
    const adapterScope = yield* Scope.Scope;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const processEnv = options.environment ?? process.env;
    const instanceId = options.instanceId ?? ProviderInstanceId.make("antigravity");

    const sessionsRef = yield* Ref.make(new Map<ThreadId, AntigravitySessionContext>());
    const eventsPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const emitEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
      PubSub.publish(eventsPubSub, event).pipe(Effect.asVoid);

    const makeEventId = (type: string, threadId: ThreadId, turnId?: TurnId): EventId =>
      EventId.make(
        `${PROVIDER}:${instanceId}:${threadId}:${turnId ?? "session"}:${type}:${Date.now()}`,
      );

    const startSession = (
      input: ProviderSessionStartInput,
    ): Effect.Effect<ProviderSession, ProviderAdapterProcessError> =>
      Effect.gen(function* () {
        const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
        const checkedAt = yield* nowIso;
        const requestedModel = input.modelSelection?.model ?? "gemini-3.6-flash";
        const session: ProviderSession = {
          provider: PROVIDER,
          providerInstanceId: instanceId,
          status: "ready",
          runtimeMode: input.runtimeMode ?? "full-access",
          cwd: input.cwd,
          model: requestedModel,
          threadId: input.threadId,
          createdAt: checkedAt,
          updatedAt: checkedAt,
        };

        const ctx: AntigravitySessionContext = {
          threadId: input.threadId,
          session,
          activeFiber: undefined,
          activeTurnId: undefined,
          turns: [],
          currentModelId: requestedModel,
        };

        yield* Effect.logInfo("antigravity.startSession", {
          threadId: input.threadId,
          model: requestedModel,
        });

        yield* Ref.update(sessionsRef, (map) => new Map(map).set(input.threadId, ctx));

        yield* emitEvent({
          eventId: makeEventId("session.started", input.threadId),
          provider: PROVIDER,
          providerInstanceId: instanceId,
          threadId: input.threadId,
          createdAt: checkedAt,
          type: "session.started",
          payload: {},
        });

        return session;
      });

    const sendTurn = (
      input: ProviderSendTurnInput,
    ): Effect.Effect<
      ProviderTurnStartResult,
      ProviderAdapterSessionNotFoundError | ProviderAdapterProcessError
    > =>
      Effect.gen(function* () {
        const sessions = yield* Ref.get(sessionsRef);
        const ctx = sessions.get(input.threadId);
        if (!ctx) {
          return yield* Effect.fail(
            new ProviderAdapterSessionNotFoundError({
              provider: PROVIDER,
              threadId: input.threadId,
            }),
          );
        }

        const turnId = TurnId.make(`turn-${Date.now()}`);
        ctx.activeTurnId = turnId;

        let textPrompt = typeof input.input === "string" ? input.input.trim() : "";
        if (input.attachments && input.attachments.length > 0) {
          const attachmentLines = input.attachments
            .map((att) => {
              if (att.type === "file" && att.path) {
                return `[Attached File: ${att.path}]`;
              }
              if (att.type === "image" && att.path) {
                return `[Attached Image: ${att.path}]`;
              }
              return `[Attached ${att.type}]`;
            })
            .join("\n");
          textPrompt = textPrompt ? `${textPrompt}\n\n${attachmentLines}` : attachmentLines;
        }

        const selectedModel =
          input.modelSelection?.model ?? ctx.currentModelId ?? "gemini-3.6-flash";
        const effortOption = input.modelSelection?.options?.find((opt) => opt.id === "effort");
        const effortValue = typeof effortOption?.value === "string" ? effortOption.value : "medium";

        let spawnCommand: { command: string; args: Array<string>; shell: boolean };

        if (settings.usePythonSdk) {
          const pythonBinary = settings.pythonPath || "python";
          const bridgePath = NodePath.resolve(__dirname, "../scripts/antigravity_bridge.py");
          const pyArgs = [
            "-u",
            bridgePath,
            "--prompt",
            textPrompt,
            "--model",
            selectedModel,
            "--effort",
            effortValue,
          ];
          spawnCommand = { command: pythonBinary, args: pyArgs, shell: false };
        } else {
          const binary = settings.binaryPath || "agy";
          const args: Array<string> = ["--print", textPrompt, "--dangerously-skip-permissions"];

          if (ctx.turns.length > 0) {
            args.push("--continue");
          }

          if (selectedModel) {
            args.push("--model", selectedModel, "--effort", effortValue);
          }

          if (settings.launchArgs) {
            args.push(...settings.launchArgs.split(/\s+/).filter(Boolean));
          }

          spawnCommand = resolveAntigravitySpawnCommand(binary, args, processEnv);
        }

        yield* Effect.logInfo("antigravity.sendTurn.initiating", {
          threadId: input.threadId,
          turnId,
          prompt: textPrompt,
          command: spawnCommand.command,
          args: spawnCommand.args,
        });

        const itemId = RuntimeItemId.make(`item-${turnId}`);

        yield* emitEvent({
          eventId: makeEventId("turn.start", input.threadId, turnId),
          provider: PROVIDER,
          providerInstanceId: instanceId,
          threadId: input.threadId,
          turnId,
          createdAt: new Date().toISOString(),
          type: "turn.started",
          payload: {},
        });

        yield* emitEvent({
          eventId: makeEventId("item.start", input.threadId, turnId),
          provider: PROVIDER,
          providerInstanceId: instanceId,
          threadId: input.threadId,
          turnId,
          itemId,
          createdAt: new Date().toISOString(),
          type: "item.started",
          payload: {
            itemType: "assistant_message",
            status: "inProgress",
          },
        });

        yield* Effect.logInfo("antigravity.spawn", {
          command: spawnCommand.command,
          args: spawnCommand.args,
          cwd: ctx.session.cwd,
        });

        const child = yield* spawner
          .spawn(
            ChildProcess.make(spawnCommand.command, spawnCommand.args, {
              cwd: ctx.session.cwd,
              env: processEnv,
              shell: spawnCommand.shell,
            }),
          )
          .pipe(
            Effect.provideService(Scope.Scope, adapterScope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: String(cause),
                }),
            ),
          );

        const runFiber = yield* Effect.gen(function* () {
          let fullText = "";
          let stderrText = "";

          yield* Effect.all(
            [
              Stream.runForEach(child.stdout, (chunk) =>
                Effect.gen(function* () {
                  const text = new TextDecoder().decode(chunk);
                  yield* Effect.logInfo("antigravity.stdout.chunk", { textLength: text.length });

                  if (settings.usePythonSdk) {
                    const lines = text.split("\n");
                    for (const line of lines) {
                      const trimmed = line.trim();
                      if (!trimmed) continue;
                      if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
                        try {
                          const parsed = JSON.parse(trimmed);
                          if (parsed.type === "token" && parsed.content) {
                            fullText += parsed.content;
                            yield* emitEvent({
                              eventId: makeEventId("content.delta", input.threadId, turnId),
                              provider: PROVIDER,
                              providerInstanceId: instanceId,
                              threadId: input.threadId,
                              turnId,
                              itemId,
                              createdAt: new Date().toISOString(),
                              type: "content.delta",
                              payload: { streamKind: "assistant_text", delta: parsed.content },
                            });
                            continue;
                          }
                          if (parsed.type === "thought" && parsed.content) {
                            yield* emitEvent({
                              eventId: makeEventId("content.delta", input.threadId, turnId),
                              provider: PROVIDER,
                              providerInstanceId: instanceId,
                              threadId: input.threadId,
                              turnId,
                              itemId,
                              createdAt: new Date().toISOString(),
                              type: "content.delta",
                              payload: { streamKind: "thought", delta: parsed.content },
                            });
                            continue;
                          }
                        } catch {
                          // Ignore parse error and fallback to raw text below
                        }
                      }
                    }
                  } else {
                    fullText += text;
                    yield* emitEvent({
                      eventId: makeEventId("content.delta", input.threadId, turnId),
                      provider: PROVIDER,
                      providerInstanceId: instanceId,
                      threadId: input.threadId,
                      turnId,
                      itemId,
                      createdAt: new Date().toISOString(),
                      type: "content.delta",
                      payload: {
                        streamKind: "assistant_text",
                        delta: text,
                      },
                    });
                  }
                }),
              ),
              Stream.runForEach(child.stderr, (chunk) =>
                Effect.gen(function* () {
                  const errChunk = new TextDecoder().decode(chunk);
                  stderrText += errChunk;
                  yield* Effect.logWarning("antigravity.stderr.chunk", { text: errChunk });
                }),
              ),
            ],
            { concurrency: "unbounded" },
          );

          const exitCode = yield* child.exitCode;
          yield* Effect.logInfo("antigravity.process.exit", {
            exitCode,
            fullTextLength: fullText.length,
            stderrLength: stderrText.length,
          });

          if (exitCode !== 0 && stderrText.trim() && !fullText) {
            const errMessage = stderrText.trim();
            fullText = `Error: ${errMessage}`;
            yield* emitEvent({
              eventId: makeEventId("content.delta", input.threadId, turnId),
              provider: PROVIDER,
              providerInstanceId: instanceId,
              threadId: input.threadId,
              turnId,
              itemId,
              createdAt: new Date().toISOString(),
              type: "content.delta",
              payload: {
                streamKind: "assistant_text",
                delta: fullText,
              },
            });
          }

          ctx.turns.push({ id: turnId, items: [{ prompt: textPrompt, response: fullText }] });
          ctx.activeTurnId = undefined;
          ctx.activeFiber = undefined;

          yield* emitEvent({
            eventId: makeEventId("item.complete", input.threadId, turnId),
            provider: PROVIDER,
            providerInstanceId: instanceId,
            threadId: input.threadId,
            turnId,
            itemId,
            createdAt: new Date().toISOString(),
            type: "item.completed",
            payload: {
              itemType: "assistant_message",
              status: exitCode === 0 ? "completed" : "failed",
            },
          });

          yield* emitEvent({
            eventId: makeEventId("turn.complete", input.threadId, turnId),
            provider: PROVIDER,
            providerInstanceId: instanceId,
            threadId: input.threadId,
            turnId,
            createdAt: new Date().toISOString(),
            type: "turn.completed",
            payload: {
              state: exitCode === 0 ? "completed" : "failed",
            },
          });
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              ctx.activeTurnId = undefined;
              ctx.activeFiber = undefined;
              yield* emitEvent({
                eventId: makeEventId("item.complete", input.threadId, turnId),
                provider: PROVIDER,
                providerInstanceId: instanceId,
                threadId: input.threadId,
                turnId,
                itemId,
                createdAt: new Date().toISOString(),
                type: "item.completed",
                payload: {
                  itemType: "assistant_message",
                  status: "failed",
                },
              });
              yield* emitEvent({
                eventId: makeEventId("turn.complete", input.threadId, turnId),
                provider: PROVIDER,
                providerInstanceId: instanceId,
                threadId: input.threadId,
                turnId,
                createdAt: new Date().toISOString(),
                type: "turn.completed",
                payload: {
                  state: "failed",
                },
              });
            }),
          ),
          Effect.forkIn(adapterScope),
        );

        ctx.activeFiber = runFiber;

        return { threadId: input.threadId, turnId };
      });

    const interruptTurn = (
      threadId: ThreadId,
      _turnId?: TurnId,
    ): Effect.Effect<void, ProviderAdapterSessionNotFoundError> =>
      Effect.gen(function* () {
        const sessions = yield* Ref.get(sessionsRef);
        const ctx = sessions.get(threadId);
        if (!ctx) {
          return yield* Effect.fail(
            new ProviderAdapterSessionNotFoundError({
              provider: PROVIDER,
              threadId,
            }),
          );
        }

        if (ctx.activeFiber) {
          yield* Fiber.interrupt(ctx.activeFiber);
          ctx.activeFiber = undefined;
          if (ctx.activeTurnId) {
            yield* emitEvent({
              eventId: makeEventId("turn.complete", threadId, ctx.activeTurnId),
              provider: PROVIDER,
              providerInstanceId: instanceId,
              threadId,
              turnId: ctx.activeTurnId,
              createdAt: new Date().toISOString(),
              type: "turn.completed",
              payload: {
                state: "interrupted",
              },
            });
            ctx.activeTurnId = undefined;
          }
        }
      });

    const stopSession = (
      threadId: ThreadId,
    ): Effect.Effect<void, ProviderAdapterSessionNotFoundError> =>
      Effect.gen(function* () {
        yield* interruptTurn(threadId).pipe(Effect.catchCause(() => Effect.void));
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
        return Array.from(sessions.values()).map((ctx) => ctx.session);
      });

    const hasSession = (threadId: ThreadId): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const sessions = yield* Ref.get(sessionsRef);
        return sessions.has(threadId);
      });

    const readThread = (
      threadId: ThreadId,
    ): Effect.Effect<
      { threadId: ThreadId; turns: ReadonlyArray<{ id: TurnId; items: ReadonlyArray<unknown> }> },
      ProviderAdapterSessionNotFoundError
    > =>
      Effect.gen(function* () {
        const sessions = yield* Ref.get(sessionsRef);
        const ctx = sessions.get(threadId);
        if (!ctx) {
          return yield* Effect.fail(
            new ProviderAdapterSessionNotFoundError({
              provider: PROVIDER,
              threadId,
            }),
          );
        }
        return {
          threadId,
          turns: ctx.turns,
        };
      });

    const rollbackThread = (
      threadId: ThreadId,
      numTurns: number,
    ): Effect.Effect<
      { threadId: ThreadId; turns: ReadonlyArray<{ id: TurnId; items: ReadonlyArray<unknown> }> },
      ProviderAdapterSessionNotFoundError
    > =>
      Effect.gen(function* () {
        const sessions = yield* Ref.get(sessionsRef);
        const ctx = sessions.get(threadId);
        if (!ctx) {
          return yield* Effect.fail(
            new ProviderAdapterSessionNotFoundError({
              provider: PROVIDER,
              threadId,
            }),
          );
        }
        ctx.turns = ctx.turns.slice(0, Math.max(0, ctx.turns.length - numTurns));
        return {
          threadId,
          turns: ctx.turns,
        };
      });

    const respondToRequest = (
      _threadId: ThreadId,
      _requestId: ApprovalRequestId,
      _decision: ProviderApprovalDecision,
    ): Effect.Effect<void, ProviderAdapterRequestError> => Effect.void;

    const respondToUserInput = (
      _threadId: ThreadId,
      _requestId: ApprovalRequestId,
      _answers: ProviderUserInputAnswers,
    ): Effect.Effect<void, ProviderAdapterRequestError> => Effect.void;

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
