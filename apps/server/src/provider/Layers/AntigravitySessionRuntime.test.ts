import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Sink from "effect/Sink";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  AntigravitySettings,
  ApprovalRequestId,
  ProviderDriverKind,
  ThreadId,
} from "@t3tools/contracts";

import {
  makeAntigravitySessionRuntime,
  resolveAntigravitySpawnCommand,
  resolveAntigravityContextLimit,
  classifyRequestType,
  mapAntigravityToolToCanonicalItemType,
  getAntigravityToolDetail,
  isRecoverableAntigravityError,
} from "./AntigravitySessionRuntime.ts";
import { buildAntigravityDeveloperInstructions } from "../AntigravityDeveloperInstructions.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";

const decodeAntigravitySettings = Schema.decodeSync(AntigravitySettings);
const PROVIDER = ProviderDriverKind.make("antigravity");

interface TrackableAntigravityProcess {
  handle: ReturnType<typeof ChildProcessSpawner.makeHandle>;
  stdoutQueue: Queue.Queue<Uint8Array>;
  kills: Array<number>;
}

const ndjsonLine = (payload: unknown) => new TextEncoder().encode(JSON.stringify(payload) + "\n");

const makeTrackableProcess = (pidNumber: number) =>
  Effect.gen(function* () {
    const stdoutQueue = yield* Queue.unbounded<Uint8Array>();
    const kills: Array<number> = [];
    const byteStream = Stream.empty;
    const handle = ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(pidNumber),
      exitCode: Effect.never,
      isRunning: Effect.succeed(false),
      kill: () =>
        Effect.sync(() => {
          kills.push(kills.length + 1);
        }),
      stdout: Stream.fromQueue(stdoutQueue),
      stderr: byteStream,
      all: byteStream,
      stdin: Sink.drain,
      getInputFd: () => Sink.drain,
      getOutputFd: () => byteStream,
      unref: Effect.succeed(Effect.void),
    });
    return { handle, stdoutQueue, kills } satisfies TrackableAntigravityProcess;
  });

describe("AntigravitySessionRuntime", () => {
  it("resolves spawn command safely on Windows without shell: true", () => {
    const cmdResult = resolveAntigravitySpawnCommand("C:\\Tools\\agy.cmd", ["--help"]);
    expect(cmdResult.shell).toBe(false);
    if (process.platform === "win32") {
      expect(cmdResult.command.toLowerCase()).toContain("cmd.exe");
      expect(cmdResult.args).toEqual(["/d", "/s", "/c", "C:\\Tools\\agy.cmd", "--help"]);
    } else {
      expect(cmdResult.command).toBe("C:\\Tools\\agy.cmd");
    }

    const exeResult = resolveAntigravitySpawnCommand("C:\\Tools\\agy.exe", ["--help"]);
    expect(exeResult.shell).toBe(false);
    expect(exeResult.command).toBe("C:\\Tools\\agy.exe");
  });

  it("correctly classifies request types for permissions", () => {
    expect(classifyRequestType("run_command")).toBe("command_execution_approval");
    expect(classifyRequestType("view_file")).toBe("file_read_approval");
    expect(classifyRequestType("write_to_file")).toBe("file_change_approval");
    expect(classifyRequestType("custom_tool")).toBe("dynamic_tool_call");
  });

  it("maps subagent hierarchy tools with structured details and titles", () => {
    const invoke = mapAntigravityToolToCanonicalItemType("invoke_subagent", {
      Subagents: [{ Role: "Code Reviewer", TypeName: "research", Prompt: "Check diffs" }],
    });
    expect(invoke.itemType).toBe("collab_agent_tool_call");
    expect(invoke.title).toBe("Subagent: Code Reviewer");

    const sendMsg = mapAntigravityToolToCanonicalItemType("send_message", {
      Recipient: "agent-123",
      Message: "Proceed with step 2",
    });
    expect(sendMsg.itemType).toBe("collab_agent_tool_call");
    expect(sendMsg.title).toBe("Message subagent: agent-123");

    const defineSub = mapAntigravityToolToCanonicalItemType("define_subagent", {
      name: "tester",
      description: "Runs tests",
    });
    expect(defineSub.itemType).toBe("collab_agent_tool_call");
    expect(defineSub.title).toBe("Define subagent: tester");

    const manageSub = mapAntigravityToolToCanonicalItemType("manage_subagents", {
      Action: "list",
    });
    expect(manageSub.itemType).toBe("collab_agent_tool_call");
    expect(manageSub.title).toBe("Manage subagents: list");

    const invokeDetail = getAntigravityToolDetail({
      Subagents: [{ Role: "Code Reviewer", Prompt: "Review the PR changes" }],
    });
    expect(invokeDetail).toBe("Code Reviewer: Review the PR changes");
  });

  it("identifies recoverable errors", () => {
    expect(isRecoverableAntigravityError("missing conversation 123")).toBe(true);
    expect(isRecoverableAntigravityError("connection reset by peer")).toBe(true);
    expect(isRecoverableAntigravityError("process exited with code 1")).toBe(true);
    expect(isRecoverableAntigravityError("syntax error in prompt")).toBe(false);
  });

  it("builds Plan Mode developer instructions with proposed_plan rules and non-mutating constraints", () => {
    const planInstructions = buildAntigravityDeveloperInstructions("plan", {
      model: "gemini-3.7-flash",
      reasoningEffort: "high",
    });
    expect(planInstructions).toContain("<collaboration_mode># Plan Mode");
    expect(planInstructions).toContain("<proposed_plan>");
    expect(planInstructions).toContain("</proposed_plan>");
    expect(planInstructions).toContain("You must NOT perform **mutating** actions");
    expect(planInstructions).toContain("<runtime_info>");
    expect(planInstructions).toContain("gemini-3.7-flash with high effort");

    const defaultInstructions = buildAntigravityDeveloperInstructions("default", {
      model: "gemini-3.7-flash",
    });
    expect(defaultInstructions).toContain("<collaboration_mode># Collaboration Mode: Default");
  });

  it.effect("handles persistent daemon turn streaming and token usage", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stdoutQueue = yield* Queue.unbounded<Uint8Array>();
        let capturedStdin = "";
        const loggedEvents: Array<any> = [];

        const mockLogger: EventNdjsonLogger = {
          filePath: "mock.log",
          write: (event) =>
            Effect.sync(() => {
              loggedEvents.push(event);
            }),
          close: () => Effect.void,
        };

        const mockSpawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.succeed(
              ChildProcessSpawner.makeHandle({
                pid: ChildProcessSpawner.ProcessId(4321),
                exitCode: Effect.never,
                isRunning: Effect.succeed(false),
                kill: () => Effect.void,
                stdout: Stream.fromQueue(stdoutQueue),
                stderr: Stream.empty,
                stdin: Sink.forEach((chunk: Uint8Array) =>
                  Effect.sync(() => {
                    capturedStdin += new TextDecoder().decode(chunk);
                  }),
                ),
              }),
            ),
          ),
        );

        const testLayer = Layer.mergeAll(NodeServices.layer, mockSpawnerLayer);

        yield* Effect.gen(function* () {
          const settings = decodeAntigravitySettings({ enabled: true });
          const threadId = ThreadId.make("thread-session-test-1");

          const runtime = yield* makeAntigravitySessionRuntime({
            threadId,
            settings,
            cwd: process.cwd(),
            runtimeMode: "full-access",
            nativeEventLogger: mockLogger,
          });

          const session = yield* runtime.start();
          expect(session.provider).toBe(PROVIDER);
          expect(session.threadId).toBe(threadId);

          const eventCollector: Array<any> = [];
          yield* Stream.runForEach(runtime.events, (event) =>
            Effect.sync(() => {
              eventCollector.push(event);
            }),
          ).pipe(Effect.forkScoped);

          // Push init event
          yield* Queue.offer(
            stdoutQueue,
            new TextEncoder().encode(
              JSON.stringify({ event: "init", conversation_id: "conv-123" }) + "\n",
            ),
          );

          const turnResult = yield* runtime.sendTurn({
            input: "Hello Antigravity",
          });

          expect(turnResult.threadId).toBe(threadId);
          expect(turnResult.turnId).toBeDefined();

          // Push thought and response events
          yield* Queue.offer(
            stdoutQueue,
            new TextEncoder().encode(
              JSON.stringify({
                event: "step_update",
                step_update: {
                  step_type: "thought",
                  thought_delta: "Thinking about the task...",
                  usage: { input_tokens: 10, output_tokens: 5, thinking_tokens: 15 },
                },
              }) + "\n",
            ),
          );

          yield* Queue.offer(
            stdoutQueue,
            new TextEncoder().encode(
              JSON.stringify({
                event: "step_update",
                step_update: {
                  step_type: "agent_response",
                  text_delta: "Here is the response.",
                },
              }) + "\n",
            ),
          );

          yield* Queue.offer(
            stdoutQueue,
            new TextEncoder().encode(
              JSON.stringify({
                event: "result",
                result: {
                  status: "DONE",
                  conversation_id: "conv-123",
                  usage: {
                    total_tokens: 30,
                    input_tokens: 10,
                    output_tokens: 5,
                    thinking_tokens: 15,
                  },
                },
              }) + "\n",
            ),
          );

          for (let i = 0; i < 5; i++) {
            yield* Effect.yieldNow;
          }

          const reasoningEvents = eventCollector.filter(
            (e) => e.type === "content.delta" && e.payload?.streamKind === "reasoning_text",
          );
          expect(reasoningEvents.length).toBeGreaterThan(0);
          expect(reasoningEvents[0].payload.delta).toBe("Thinking about the task...");

          const textEvents = eventCollector.filter(
            (e) => e.type === "content.delta" && e.payload?.streamKind === "assistant_text",
          );
          expect(textEvents.length).toBeGreaterThan(0);
          expect(textEvents[0].payload.delta).toBe("Here is the response.");

          const usageEvents = eventCollector.filter((e) => e.type === "thread.token-usage.updated");
          expect(usageEvents.length).toBeGreaterThan(0);
          expect(usageEvents[0].payload.usage.reasoningOutputTokens).toBe(15);
          expect(usageEvents[0].payload.usage.maxTokens).toBe(1_048_576);
          // compactsAutomatically is only reported when the CLI reports it.
          expect(usageEvents[0].payload.usage.compactsAutomatically).toBeUndefined();

          expect(capturedStdin).toContain('"event":"user"');
          expect(capturedStdin).toContain("Hello Antigravity");

          expect(loggedEvents.length).toBeGreaterThan(0);

          yield* runtime.close;
        }).pipe(Effect.provide(testLayer));
      }),
    ),
  );

  it.effect("handles interactive tool approvals via Deferred and responds to requests", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stdoutQueue = yield* Queue.unbounded<Uint8Array>();
        let capturedStdin = "";

        const mockSpawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.succeed(
              ChildProcessSpawner.makeHandle({
                pid: ChildProcessSpawner.ProcessId(4322),
                exitCode: Effect.never,
                isRunning: Effect.succeed(false),
                kill: () => Effect.void,
                stdout: Stream.fromQueue(stdoutQueue),
                stderr: Stream.empty,
                stdin: Sink.forEach((chunk: Uint8Array) =>
                  Effect.sync(() => {
                    capturedStdin += new TextDecoder().decode(chunk);
                  }),
                ),
              }),
            ),
          ),
        );

        const testLayer = Layer.mergeAll(NodeServices.layer, mockSpawnerLayer);

        yield* Effect.gen(function* () {
          const settings = decodeAntigravitySettings({ enabled: true });
          const threadId = ThreadId.make("thread-session-approval-1");

          const runtime = yield* makeAntigravitySessionRuntime({
            threadId,
            settings,
            cwd: process.cwd(),
            runtimeMode: "approval-required",
          });

          yield* runtime.start();

          const eventCollector: Array<any> = [];
          yield* Stream.runForEach(runtime.events, (event) =>
            Effect.sync(() => {
              eventCollector.push(event);
            }),
          ).pipe(Effect.forkScoped);

          yield* runtime.sendTurn({
            input: "run tests",
          });

          // Push approval request
          yield* Queue.offer(
            stdoutQueue,
            new TextEncoder().encode(
              JSON.stringify({
                event: "step_update",
                step_update: {
                  step_type: "tool",
                  tool_name: "run_command",
                  state: "PENDING_APPROVAL",
                  tool_info: { parameters: { CommandLine: "npm test" } },
                },
              }) + "\n",
            ),
          );

          for (let i = 0; i < 5; i++) {
            yield* Effect.yieldNow;
          }

          const requestOpened = eventCollector.find((e) => e.type === "request.opened");
          expect(requestOpened).toBeDefined();
          expect(requestOpened.payload.requestType).toBe("command_execution_approval");
          expect(requestOpened.requestId).toBeDefined();

          const requestId = ApprovalRequestId.make(requestOpened.requestId);
          yield* runtime.respondToRequest(requestId, "accept");

          for (let i = 0; i < 5; i++) {
            yield* Effect.yieldNow;
          }

          const requestResolved = eventCollector.find((e) => e.type === "request.resolved");
          expect(requestResolved).toBeDefined();
          expect(requestResolved.payload.decision).toBe("accept");

          expect(capturedStdin).toContain("permission_response");
          expect(capturedStdin).toContain("accept");

          yield* runtime.close;
        }).pipe(Effect.provide(testLayer));
      }),
    ),
  );

  it.effect("handles ask_question questionnaires with multi-question ID correlation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stdoutQueue = yield* Queue.unbounded<Uint8Array>();
        let capturedStdin = "";

        const mockSpawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.succeed(
              ChildProcessSpawner.makeHandle({
                pid: ChildProcessSpawner.ProcessId(4323),
                exitCode: Effect.never,
                isRunning: Effect.succeed(false),
                kill: () => Effect.void,
                stdout: Stream.fromQueue(stdoutQueue),
                stderr: Stream.empty,
                stdin: Sink.forEach((chunk: Uint8Array) =>
                  Effect.sync(() => {
                    capturedStdin += new TextDecoder().decode(chunk);
                  }),
                ),
              }),
            ),
          ),
        );

        const testLayer = Layer.mergeAll(NodeServices.layer, mockSpawnerLayer);

        yield* Effect.gen(function* () {
          const settings = decodeAntigravitySettings({ enabled: true });
          const threadId = ThreadId.make("thread-session-question-1");

          const runtime = yield* makeAntigravitySessionRuntime({
            threadId,
            settings,
            cwd: process.cwd(),
            runtimeMode: "full-access",
          });

          yield* runtime.start();

          const eventCollector: Array<any> = [];
          yield* Stream.runForEach(runtime.events, (event) =>
            Effect.sync(() => {
              eventCollector.push(event);
            }),
          ).pipe(Effect.forkScoped);

          yield* runtime.sendTurn({
            input: "setup db",
          });

          // Push ask_question tool event without explicit question id
          yield* Queue.offer(
            stdoutQueue,
            new TextEncoder().encode(
              JSON.stringify({
                event: "step_update",
                step_update: {
                  step_type: "tool",
                  tool_name: "ask_question",
                  state: "ACTIVE",
                  tool_info: {
                    parameters: {
                      questions: [
                        {
                          question: "Which database would you prefer?",
                          options: ["PostgreSQL", "SQLite"],
                        },
                      ],
                    },
                  },
                },
              }) + "\n",
            ),
          );

          for (let i = 0; i < 5; i++) {
            yield* Effect.yieldNow;
          }

          const inputRequested = eventCollector.find((e) => e.type === "user-input.requested");
          expect(inputRequested).toBeDefined();
          expect(inputRequested.payload.questions.length).toBe(1);
          expect(inputRequested.payload.questions[0].id).toBe("q_0");
          expect(inputRequested.payload.questions[0].question).toBe(
            "Which database would you prefer?",
          );

          const requestId = ApprovalRequestId.make(inputRequested.requestId);
          yield* runtime.respondToUserInput(requestId, { q_0: "PostgreSQL" });

          for (let i = 0; i < 5; i++) {
            yield* Effect.yieldNow;
          }

          const inputResolved = eventCollector.find((e) => e.type === "user-input.resolved");
          expect(inputResolved).toBeDefined();
          expect(inputResolved.payload.answers).toEqual({ q_0: "PostgreSQL" });

          expect(capturedStdin).toContain("user_input_response");
          expect(capturedStdin).toContain("PostgreSQL");
          expect(capturedStdin).toContain("Which database would you prefer?");

          yield* runtime.close;
        }).pipe(Effect.provide(testLayer));
      }),
    ),
  );

  it.effect(
    "injects Plan Mode developer instructions into user_message when interactionMode is plan",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const stdoutQueue = yield* Queue.unbounded<Uint8Array>();
          let capturedStdin = "";

          const mockSpawnerLayer = Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() =>
              Effect.succeed(
                ChildProcessSpawner.makeHandle({
                  pid: ChildProcessSpawner.ProcessId(4324),
                  exitCode: Effect.never,
                  isRunning: Effect.succeed(false),
                  kill: () => Effect.void,
                  stdout: Stream.fromQueue(stdoutQueue),
                  stderr: Stream.empty,
                  stdin: Sink.forEach((chunk: Uint8Array) =>
                    Effect.sync(() => {
                      capturedStdin += new TextDecoder().decode(chunk);
                    }),
                  ),
                }),
              ),
            ),
          );

          const testLayer = Layer.mergeAll(NodeServices.layer, mockSpawnerLayer);

          yield* Effect.gen(function* () {
            const settings = decodeAntigravitySettings({ enabled: true });
            const threadId = ThreadId.make("thread-session-plan-1");

            const runtime = yield* makeAntigravitySessionRuntime({
              threadId,
              settings,
              cwd: process.cwd(),
              runtimeMode: "full-access",
            });

            yield* runtime.start();

            yield* runtime.sendTurn({
              input: "Design the database schema",
              interactionMode: "plan",
            });

            for (let i = 0; i < 5; i++) {
              yield* Effect.yieldNow;
            }

            expect(capturedStdin).toContain('"event":"user"');
            expect(capturedStdin).toContain("<developer_instructions>");
            expect(capturedStdin).toContain("<proposed_plan>");
            expect(capturedStdin).toContain("Plan Mode (Conversational)");
            expect(capturedStdin).toContain("Design the database schema");

            yield* runtime.close;
          }).pipe(Effect.provide(testLayer));
        }),
      ),
  );

  it.effect(
    "emits canonical plan lifecycle items when proposed_plan tag is returned in response",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const stdoutQueue = yield* Queue.unbounded<Uint8Array>();

          const mockSpawnerLayer = Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() =>
              Effect.succeed(
                ChildProcessSpawner.makeHandle({
                  pid: ChildProcessSpawner.ProcessId(4325),
                  exitCode: Effect.never,
                  isRunning: Effect.succeed(false),
                  kill: () => Effect.void,
                  stdout: Stream.fromQueue(stdoutQueue),
                  stderr: Stream.empty,
                  stdin: Sink.drain,
                }),
              ),
            ),
          );

          const testLayer = Layer.mergeAll(NodeServices.layer, mockSpawnerLayer);

          yield* Effect.gen(function* () {
            const settings = decodeAntigravitySettings({ enabled: true });
            const threadId = ThreadId.make("thread-session-plan-events-1");

            const runtime = yield* makeAntigravitySessionRuntime({
              threadId,
              settings,
              cwd: process.cwd(),
              runtimeMode: "full-access",
            });

            yield* runtime.start();

            const eventCollector: Array<any> = [];
            yield* Stream.runForEach(runtime.events, (event) =>
              Effect.sync(() => {
                eventCollector.push(event);
              }),
            ).pipe(Effect.forkScoped);

            yield* runtime.sendTurn({
              input: "Make a plan",
              interactionMode: "plan",
            });

            // Model outputs response containing <proposed_plan> block
            const planMarkdown = `# Authentication Spec\n\n1. Use OAuth\n2. Add JWT sessions`;
            yield* Queue.offer(
              stdoutQueue,
              new TextEncoder().encode(
                JSON.stringify({
                  event: "step_update",
                  step_update: {
                    step_type: "agent_response",
                    text_delta: `Here is the plan:\n\n<proposed_plan>\n${planMarkdown}\n</proposed_plan>`,
                  },
                }) + "\n",
              ),
            );

            yield* Queue.offer(
              stdoutQueue,
              new TextEncoder().encode(
                JSON.stringify({
                  event: "result",
                  result: {
                    status: "DONE",
                  },
                }) + "\n",
              ),
            );

            for (let i = 0; i < 5; i++) {
              yield* Effect.yieldNow;
            }

            const planItemStarted = eventCollector.find(
              (e) => e.type === "item.started" && e.payload?.itemType === "plan",
            );
            expect(planItemStarted).toBeDefined();
            expect(planItemStarted.payload.title).toBe("Plan");
            expect(planItemStarted.payload.detail).toBe("Authentication Spec");
            expect(planItemStarted.payload.data?.plan).toContain("Authentication Spec");

            const planItemCompleted = eventCollector.find(
              (e) => e.type === "item.completed" && e.payload?.itemType === "plan",
            );
            expect(planItemCompleted).toBeDefined();
            expect(planItemCompleted.payload.status).toBe("completed");

            yield* runtime.close;
          }).pipe(Effect.provide(testLayer));
        }),
      ),
  );

  it.effect(
    "dynamically injects Default mode developer instructions when switching from plan to default",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const stdoutQueue = yield* Queue.unbounded<Uint8Array>();
          let capturedStdin = "";

          const mockSpawnerLayer = Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() =>
              Effect.succeed(
                ChildProcessSpawner.makeHandle({
                  pid: ChildProcessSpawner.ProcessId(4326),
                  exitCode: Effect.never,
                  isRunning: Effect.succeed(false),
                  kill: () => Effect.void,
                  stdout: Stream.fromQueue(stdoutQueue),
                  stderr: Stream.empty,
                  stdin: Sink.forEach((chunk: Uint8Array) =>
                    Effect.sync(() => {
                      capturedStdin += new TextDecoder().decode(chunk);
                    }),
                  ),
                }),
              ),
            ),
          );

          const testLayer = Layer.mergeAll(NodeServices.layer, mockSpawnerLayer);

          yield* Effect.gen(function* () {
            const settings = decodeAntigravitySettings({ enabled: true });
            const threadId = ThreadId.make("thread-session-mode-switch-1");

            const runtime = yield* makeAntigravitySessionRuntime({
              threadId,
              settings,
              cwd: process.cwd(),
              runtimeMode: "full-access",
            });

            yield* runtime.start();

            // Turn 1: in Plan Mode
            yield* runtime.sendTurn({
              input: "Draft plan",
              interactionMode: "plan",
            });

            for (let i = 0; i < 5; i++) {
              yield* Effect.yieldNow;
            }

            expect(capturedStdin).toContain("Plan Mode (Conversational)");

            // Clear captured stdin and push turn 1 completion
            capturedStdin = "";
            yield* Queue.offer(
              stdoutQueue,
              new TextEncoder().encode(
                JSON.stringify({
                  event: "result",
                  result: { status: "DONE" },
                }) + "\n",
              ),
            );

            for (let i = 0; i < 5; i++) {
              yield* Effect.yieldNow;
            }

            // Turn 2: Switch to Default Mode
            yield* runtime.sendTurn({
              input: "Now implement it",
              interactionMode: "default",
            });

            for (let i = 0; i < 5; i++) {
              yield* Effect.yieldNow;
            }

            expect(capturedStdin).toContain("Collaboration Mode: Default");
            expect(capturedStdin).toContain("Now implement it");

            yield* runtime.close;
          }).pipe(Effect.provide(testLayer));
        }),
      ),
  );

  it.effect("fails fast when a second turn is sent while one is in flight", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const proc = yield* makeTrackableProcess(4400);
        const mockSpawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.succeed(proc.handle)),
        );
        const testLayer = Layer.mergeAll(NodeServices.layer, mockSpawnerLayer);

        yield* Effect.gen(function* () {
          const settings = decodeAntigravitySettings({ enabled: true });
          const threadId = ThreadId.make("thread-overlap-guard-1");

          const runtime = yield* makeAntigravitySessionRuntime({
            threadId,
            settings,
            cwd: process.cwd(),
            runtimeMode: "full-access",
          });

          yield* runtime.start();
          yield* runtime.sendTurn({ input: "first turn" });

          const outcome = yield* runtime.sendTurn({ input: "second turn" }).pipe(Effect.result);
          expect(Result.isFailure(outcome)).toBe(true);
          if (Result.isFailure(outcome)) {
            expect(String(outcome.failure.detail)).toContain("already in progress");
          }

          // The first turn can still complete normally afterwards.
          yield* Queue.offer(
            proc.stdoutQueue,
            ndjsonLine({ event: "result", result: { status: "DONE" } }),
          );
          for (let i = 0; i < 5; i++) {
            yield* Effect.yieldNow;
          }
          const nextOutcome = yield* runtime.sendTurn({ input: "third turn" }).pipe(Effect.result);
          expect(Result.isSuccess(nextOutcome)).toBe(true);

          yield* runtime.close;
        }).pipe(Effect.provide(testLayer));
      }),
    ),
  );

  it.effect("kills the daemon on interrupt so late output cannot resurrect the turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const proc = yield* makeTrackableProcess(4401);
        const mockSpawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.succeed(proc.handle)),
        );
        const testLayer = Layer.mergeAll(NodeServices.layer, mockSpawnerLayer);

        yield* Effect.gen(function* () {
          const settings = decodeAntigravitySettings({ enabled: true });
          const threadId = ThreadId.make("thread-interrupt-kill-1");

          const runtime = yield* makeAntigravitySessionRuntime({
            threadId,
            settings,
            cwd: process.cwd(),
            runtimeMode: "full-access",
          });

          yield* runtime.start();
          yield* runtime.sendTurn({ input: "long running task" });
          expect(proc.kills.length).toBe(0);

          yield* runtime.interruptTurn();
          expect(proc.kills.length).toBeGreaterThan(0);

          yield* runtime.close;
        }).pipe(Effect.provide(testLayer));
      }),
    ),
  );

  it.effect("respawns and kills the previous daemon when model/effort changes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processes: TrackableAntigravityProcess[] = [];
        let spawnIndex = 0;
        const mockSpawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.gen(function* () {
              const proc = yield* makeTrackableProcess(4500 + spawnIndex);
              spawnIndex += 1;
              processes.push(proc);
              return proc.handle;
            }),
          ),
        );
        const testLayer = Layer.mergeAll(NodeServices.layer, mockSpawnerLayer);

        yield* Effect.gen(function* () {
          const settings = decodeAntigravitySettings({ enabled: true });
          const threadId = ThreadId.make("thread-respawn-model-change-1");

          const runtime = yield* makeAntigravitySessionRuntime({
            threadId,
            settings,
            cwd: process.cwd(),
            runtimeMode: "full-access",
          });

          yield* runtime.start();
          expect(processes.length).toBe(1);

          // Same model/effort as the spawned daemon: no respawn.
          yield* runtime.sendTurn({
            input: "turn one",
            model: "gemini-3.7-flash",
            effort: "medium",
          });
          expect(processes.length).toBe(1);

          // Model switch: old daemon killed, new daemon spawned.
          const firstProcess = processes[0]!;
          yield* Queue.offer(
            firstProcess.stdoutQueue,
            ndjsonLine({ event: "result", result: { status: "DONE" } }),
          );
          for (let i = 0; i < 5; i++) {
            yield* Effect.yieldNow;
          }
          yield* runtime.sendTurn({
            input: "turn two",
            model: "gemini-2.5-pro",
            effort: "high",
          });
          expect(processes.length).toBe(2);
          expect(firstProcess.kills.length).toBeGreaterThan(0);

          yield* runtime.close;
        }).pipe(Effect.provide(testLayer));
      }),
    ),
  );

  it.effect("emits a single approval request for repeated PENDING_APPROVAL state updates", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const proc = yield* makeTrackableProcess(4402);
        const mockSpawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.succeed(proc.handle)),
        );
        const testLayer = Layer.mergeAll(NodeServices.layer, mockSpawnerLayer);

        yield* Effect.gen(function* () {
          const settings = decodeAntigravitySettings({ enabled: true });
          const threadId = ThreadId.make("thread-approval-dedupe-1");

          const runtime = yield* makeAntigravitySessionRuntime({
            threadId,
            settings,
            cwd: process.cwd(),
            runtimeMode: "approval-required",
          });
          yield* runtime.start();

          const eventCollector: Array<any> = [];
          yield* Stream.runForEach(runtime.events, (event) =>
            Effect.sync(() => {
              eventCollector.push(event);
            }),
          ).pipe(Effect.forkScoped);

          yield* runtime.sendTurn({ input: "run tests" });

          const approvalLine = JSON.stringify({
            event: "step_update",
            step_update: {
              step_type: "tool",
              tool_name: "run_command",
              state: "PENDING_APPROVAL",
              tool_info: { parameters: { CommandLine: "npm test" } },
            },
          });
          // The daemon re-emits the same pending state (e.g. a refresh).
          yield* Queue.offer(proc.stdoutQueue, new TextEncoder().encode(approvalLine + "\n"));
          yield* Queue.offer(proc.stdoutQueue, new TextEncoder().encode(approvalLine + "\n"));

          for (let i = 0; i < 10; i++) {
            yield* Effect.yieldNow;
          }

          const openedEvents = eventCollector.filter((e) => e.type === "request.opened");
          expect(openedEvents.length).toBe(1);

          yield* runtime.close;
        }).pipe(Effect.provide(testLayer));
      }),
    ),
  );

  it.effect("does not leak non-JSON stdout lines into the assistant message", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const proc = yield* makeTrackableProcess(4403);
        const mockSpawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.succeed(proc.handle)),
        );
        const testLayer = Layer.mergeAll(NodeServices.layer, mockSpawnerLayer);

        yield* Effect.gen(function* () {
          const settings = decodeAntigravitySettings({ enabled: true });
          const threadId = ThreadId.make("thread-noise-filter-1");

          const runtime = yield* makeAntigravitySessionRuntime({
            threadId,
            settings,
            cwd: process.cwd(),
            runtimeMode: "full-access",
          });
          yield* runtime.start();

          const eventCollector: Array<any> = [];
          yield* Stream.runForEach(runtime.events, (event) =>
            Effect.sync(() => {
              eventCollector.push(event);
            }),
          ).pipe(Effect.forkScoped);

          yield* runtime.sendTurn({ input: "hello" });

          // Banner text and partial/multi-line JSON must never surface as
          // assistant content.
          yield* Queue.offer(
            proc.stdoutQueue,
            new TextEncoder().encode("Antigravity CLI v9.9.9 — starting up\n"),
          );
          yield* Queue.offer(proc.stdoutQueue, new TextEncoder().encode("{broken json...\n"));
          yield* Queue.offer(
            proc.stdoutQueue,
            new TextEncoder().encode(
              JSON.stringify({
                event: "step_update",
                step_update: { step_type: "agent_response", text_delta: "real response" },
              }) + "\n",
            ),
          );

          for (let i = 0; i < 10; i++) {
            yield* Effect.yieldNow;
          }

          const textDeltas = eventCollector
            .filter((e) => e.type === "content.delta" && e.payload?.streamKind === "assistant_text")
            .map((e) => String(e.payload.delta));
          expect(textDeltas.join("")).toContain("real response");
          expect(textDeltas.join("")).not.toContain("starting up");
          expect(textDeltas.join("")).not.toContain("broken json");

          yield* runtime.close;
        }).pipe(Effect.provide(testLayer));
      }),
    ),
  );
});

describe("resolveAntigravityContextLimit", () => {
  it("resolves explicit selected context window options", () => {
    expect(resolveAntigravityContextLimit("gemini-3.7-flash", "200k")).toBe(200_000);
    expect(resolveAntigravityContextLimit("gemini-3.7-flash", "1m")).toBe(1_048_576);
    expect(resolveAntigravityContextLimit("gemini-2.5-pro", "2m")).toBe(2_097_152);
  });

  it("resolves model defaults when context window is not specified", () => {
    expect(resolveAntigravityContextLimit("gemini-2.5-pro")).toBe(2_097_152);
    expect(resolveAntigravityContextLimit("gemini-1.5-pro")).toBe(2_097_152);
    expect(resolveAntigravityContextLimit("custom-pro-model")).toBe(2_097_152);
    expect(resolveAntigravityContextLimit("gemini-3.7-flash")).toBe(1_048_576);
    expect(resolveAntigravityContextLimit("gemini-2.0-flash")).toBe(1_048_576);
    expect(resolveAntigravityContextLimit("gemini-3.6-flash")).toBe(1_048_576);
    expect(resolveAntigravityContextLimit("claude-3-7-sonnet")).toBe(200_000);
    expect(resolveAntigravityContextLimit("gpt-4o")).toBe(128_000);
    expect(resolveAntigravityContextLimit(undefined)).toBe(1_048_576);
  });
});
