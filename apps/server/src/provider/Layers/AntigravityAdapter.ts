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
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

import { ServerConfig } from "../../config.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";

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
    const appData = env.APPDATA?.trim();
    if (localAppData && NodeFS.existsSync(`${localAppData}\\agy\\bin\\agy.exe`)) {
      resolvedBinary = `${localAppData}\\agy\\bin\\agy.exe`;
    } else if (
      userProfile &&
      NodeFS.existsSync(`${userProfile}\\.gemini\\antigravity\\bin\\agy.exe`)
    ) {
      resolvedBinary = `${userProfile}\\.gemini\\antigravity\\bin\\agy.exe`;
    } else if (
      localAppData &&
      NodeFS.existsSync(`${localAppData}\\Programs\\Antigravity\\bin\\agy.exe`)
    ) {
      resolvedBinary = `${localAppData}\\Programs\\Antigravity\\bin\\agy.exe`;
    } else if (appData && NodeFS.existsSync(`${appData}\\Antigravity\\bin\\agy.exe`)) {
      resolvedBinary = `${appData}\\Antigravity\\bin\\agy.exe`;
    } else if (appData && NodeFS.existsSync(`${appData}\\Roaming\\Antigravity\\bin\\agy.exe`)) {
      resolvedBinary = `${appData}\\Roaming\\Antigravity\\bin\\agy.exe`;
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
export const ANTIGRAVITY_RESUME_VERSION = 1 as const;

export interface AntigravityResumeCursor {
  readonly schemaVersion: typeof ANTIGRAVITY_RESUME_VERSION;
  readonly conversationId: string;
}

export function parseAntigravityResume(raw: unknown): AntigravityResumeCursor | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.conversationId === "string" && record.conversationId.trim().length > 0) {
    return {
      schemaVersion: ANTIGRAVITY_RESUME_VERSION,
      conversationId: record.conversationId.trim(),
    };
  }
  return undefined;
}

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
  agyConversationId: string | undefined;
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
    const maybeServerConfig = yield* Effect.serviceOption(ServerConfig);
    const attachmentsDir = Option.isSome(maybeServerConfig)
      ? maybeServerConfig.value.attachmentsDir
      : process.cwd();
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
        const requestedModel = input.modelSelection?.model ?? "gemini-3.7-flash";
        const resume = parseAntigravityResume(input.resumeCursor);
        const agyConversationId = resume?.conversationId;

        const session: ProviderSession = {
          provider: PROVIDER,
          providerInstanceId: instanceId,
          status: "ready",
          runtimeMode: input.runtimeMode ?? "full-access",
          cwd: input.cwd,
          model: requestedModel,
          threadId: input.threadId,
          ...(resume
            ? {
                resumeCursor: {
                  schemaVersion: ANTIGRAVITY_RESUME_VERSION,
                  conversationId: resume.conversationId,
                },
              }
            : {}),
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
          agyConversationId,
        };

        yield* Effect.logInfo("antigravity.startSession", {
          threadId: input.threadId,
          model: requestedModel,
          agyConversationId,
        });

        yield* Ref.update(sessionsRef, (map) => new Map(map).set(input.threadId, ctx));

        yield* emitEvent({
          eventId: makeEventId("session.started", input.threadId),
          provider: PROVIDER,
          providerInstanceId: instanceId,
          threadId: input.threadId,
          createdAt: checkedAt,
          type: "session.started",
          payload: {
            ...(agyConversationId ? { providerThreadId: agyConversationId } : {}),
            ...(session.resumeCursor !== undefined ? { resume: session.resumeCursor } : {}),
          },
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
        const imagePaths: Array<string> = [];
        const activeCwd = ctx.session.cwd;

        if (input.attachments && input.attachments.length > 0) {
          const attachmentLines = input.attachments
            .map((att) => {
              if (att.type === "file") {
                const filePath =
                  att.path ??
                  resolveAttachmentPath({
                    attachmentsDir,
                    attachment: att,
                  });
                return filePath ? `[Attached File: ${filePath}]` : `[Attached File: ${att.name}]`;
              }
              if (att.type === "image") {
                const imgPath = resolveAttachmentPath({
                  attachmentsDir,
                  attachment: att,
                });
                if (imgPath) {
                  imagePaths.push(imgPath);
                  return `[Attached Image: ${imgPath}]`;
                }
                return `[Attached Image: ${att.name}]`;
              }
              return `[Attached ${att.type}]`;
            })
            .join("\n");
          textPrompt = textPrompt ? `${textPrompt}\n\n${attachmentLines}` : attachmentLines;
        }

        if (activeCwd && !textPrompt.includes("[Active Workspace Folder:")) {
          textPrompt = `[Active Workspace Folder: ${activeCwd}]\n\n${textPrompt}`;
        }

        const selectedModel =
          input.modelSelection?.model ?? ctx.currentModelId ?? "gemini-3.7-flash";
        const effortOption = input.modelSelection?.options?.find((opt) => opt.id === "effort");
        const rawEffort =
          typeof effortOption?.value === "string" ? effortOption.value.trim().toLowerCase() : "";
        const validEfforts = ["low", "medium", "high"];
        const effortValue = validEfforts.includes(rawEffort) ? rawEffort : "medium";

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
          if (activeCwd) {
            pyArgs.push("--cwd", activeCwd);
          }
          for (const imgPath of imagePaths) {
            pyArgs.push("--image", imgPath);
          }
          spawnCommand = { command: pythonBinary, args: pyArgs, shell: false };
        } else {
          const binary = settings.binaryPath || "agy";
          const args: Array<string> = [
            "--print",
            textPrompt,
            "--dangerously-skip-permissions",
            "--output-format",
            "stream-json",
          ];

          if (ctx.agyConversationId) {
            args.push("--conversation", ctx.agyConversationId);
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
          agyConversationId: ctx.agyConversationId,
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
          let stdoutBuffer = "";

          const processLine = (line: string): Effect.Effect<void> =>
            Effect.gen(function* () {
              const trimmed = line.trim();
              if (!trimmed) return;

              if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
                try {
                  const parsed = JSON.parse(trimmed);

                  if (parsed.event === "init" && parsed.conversation_id) {
                    ctx.agyConversationId = String(parsed.conversation_id);
                    ctx.session.resumeCursor = {
                      schemaVersion: ANTIGRAVITY_RESUME_VERSION,
                      conversationId: ctx.agyConversationId,
                    };
                    yield* Effect.logInfo("antigravity.conversation.init", {
                      conversationId: ctx.agyConversationId,
                    });
                    return;
                  }

                  if (parsed.event === "step_update" && parsed.step_update) {
                    const step = parsed.step_update;
                    if (step.conversation_id && !ctx.agyConversationId) {
                      ctx.agyConversationId = String(step.conversation_id);
                      ctx.session.resumeCursor = {
                        schemaVersion: ANTIGRAVITY_RESUME_VERSION,
                        conversationId: ctx.agyConversationId,
                      };
                    }
                    if (
                      step.step_type === "agent_response" &&
                      typeof step.text_delta === "string" &&
                      step.text_delta.length > 0
                    ) {
                      fullText += step.text_delta;
                      yield* emitEvent({
                        eventId: makeEventId("content.delta", input.threadId, turnId),
                        provider: PROVIDER,
                        providerInstanceId: instanceId,
                        threadId: input.threadId,
                        turnId,
                        itemId,
                        createdAt: new Date().toISOString(),
                        type: "content.delta",
                        payload: { streamKind: "assistant_text", delta: step.text_delta },
                      });
                      return;
                    }
                    if (
                      step.step_type === "thought" &&
                      typeof step.text_delta === "string" &&
                      step.text_delta.length > 0
                    ) {
                      yield* emitEvent({
                        eventId: makeEventId("content.delta", input.threadId, turnId),
                        provider: PROVIDER,
                        providerInstanceId: instanceId,
                        threadId: input.threadId,
                        turnId,
                        itemId,
                        createdAt: new Date().toISOString(),
                        type: "content.delta",
                        payload: { streamKind: "thought", delta: step.text_delta },
                      });
                      return;
                    }
                    return;
                  }

                  if (parsed.event === "result" && parsed.result) {
                    const res = parsed.result;
                    if (res.conversation_id) {
                      ctx.agyConversationId = String(res.conversation_id);
                      ctx.session.resumeCursor = {
                        schemaVersion: ANTIGRAVITY_RESUME_VERSION,
                        conversationId: ctx.agyConversationId,
                      };
                    }
                    if (res.status === "ERROR" || res.error) {
                      const errorMsg = String(
                        res.error || res.response || "Antigravity turn error",
                      );
                      if (!fullText) {
                        fullText = `Error: ${errorMsg}`;
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
                            delta: `\n\n**Error:** ${errorMsg}\n`,
                          },
                        });
                      }
                    } else if (typeof res.response === "string" && !fullText) {
                      fullText = res.response;
                      yield* emitEvent({
                        eventId: makeEventId("content.delta", input.threadId, turnId),
                        provider: PROVIDER,
                        providerInstanceId: instanceId,
                        threadId: input.threadId,
                        turnId,
                        itemId,
                        createdAt: new Date().toISOString(),
                        type: "content.delta",
                        payload: { streamKind: "assistant_text", delta: res.response },
                      });
                    }
                    return;
                  }

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
                    return;
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
                    return;
                  }
                } catch {
                  // Fall through to plain text
                }
              }

              fullText += line + "\n";
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
                  delta: line + "\n",
                },
              });
            });

          yield* Effect.all(
            [
              child.stdout.pipe(
                Stream.decodeText(),
                Stream.runForEach((text) =>
                  Effect.gen(function* () {
                    yield* Effect.logInfo("antigravity.stdout.chunk", { textLength: text.length });
                    stdoutBuffer += text;

                    const lines = stdoutBuffer.split("\n");
                    stdoutBuffer = lines.pop() ?? "";

                    for (const line of lines) {
                      yield* processLine(line);
                    }
                  }),
                ),
              ),
              child.stderr.pipe(
                Stream.decodeText(),
                Stream.runForEach((errChunk) =>
                  Effect.gen(function* () {
                    stderrText += errChunk;
                    yield* Effect.logWarning("antigravity.stderr.chunk", { text: errChunk });
                  }),
                ),
              ),
            ],
            { concurrency: "unbounded" },
          );

          if (stdoutBuffer.trim().length > 0) {
            yield* processLine(stdoutBuffer);
          }

          const exitCode = yield* child.exitCode;
          yield* Effect.logInfo("antigravity.process.exit", {
            exitCode,
            fullTextLength: fullText.length,
            stderrLength: stderrText.length,
            agyConversationId: ctx.agyConversationId,
          });

          let errorMessage: string | undefined;
          if (exitCode !== 0) {
            errorMessage =
              stderrText.trim() ||
              (fullText.startsWith("Error:")
                ? fullText
                : `Antigravity process exited with non-zero status (${exitCode}).`);
            if (!fullText) {
              fullText = `Error: ${errorMessage}`;
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
                  delta: `\n\n**Error:** ${errorMessage}\n`,
                },
              });
            }
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
              ...(errorMessage ? { errorMessage } : {}),
              ...(ctx.agyConversationId ? { providerThreadId: ctx.agyConversationId } : {}),
              ...(ctx.session.resumeCursor !== undefined
                ? { resumeCursor: ctx.session.resumeCursor }
                : {}),
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
