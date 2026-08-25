// @effect-diagnostics nodeBuiltinImport:off
import {
  ApprovalRequestId,
  CanonicalItemType,
  CanonicalRequestType,
  EventId,
  type AntigravitySettings,
  type ProviderApprovalDecision,
  type ProviderInteractionMode,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  type RuntimeMode,
  ThreadId,
  TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { buildAntigravityDeveloperInstructions } from "../AntigravityDeveloperInstructions.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = NodePath.dirname(__filename);

const PROVIDER = ProviderDriverKind.make("antigravity");
export const ANTIGRAVITY_RESUME_VERSION = 1 as const;

const decodeJsonStringExit = Schema.decodeUnknownExit(Schema.fromJsonString(Schema.Unknown));
const encodeUnknownJsonString = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

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

const firstExistingPath = (candidates: Array<string | undefined>): string | undefined => {
  for (const candidate of candidates) {
    if (candidate && NodeFS.existsSync(candidate)) return candidate;
  }
  return undefined;
};

/**
 * Windows-only: Node spawns bare command names without applying `PATHEXT`
 * resolution when `shell` is false, so an `agy.cmd`/`agy.bat` shim on PATH
 * would fail with ENOENT. Scan PATH manually for the real shim/binary.
 */
const findWindowsBinaryOnPath = (binary: string, env: NodeJS.ProcessEnv): string | undefined => {
  const pathValue = env.PATH ?? env.Path;
  if (!pathValue) return undefined;
  const dirs = pathValue.split(";").filter((dir) => dir.trim().length > 0);
  const extensions = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((ext) => ext.trim().toLowerCase())
    .filter(Boolean);
  const candidates = resolvedBinaryHasExtension(binary)
    ? [binary]
    : [...extensions.map((ext) => `${binary}${ext}`), binary];
  for (const dir of dirs) {
    for (const fileName of candidates) {
      const candidate = NodePath.join(dir, fileName);
      if (NodeFS.existsSync(candidate)) return candidate;
    }
  }
  return undefined;
};

const resolvedBinaryHasExtension = (binary: string): boolean => {
  const extension = NodePath.extname(binary).toLowerCase();
  return [".exe", ".cmd", ".bat", ".com"].includes(extension);
};

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
    resolvedBinary =
      firstExistingPath([
        localAppData ? `${localAppData}\\agy\\bin\\agy.exe` : undefined,
        userProfile ? `${userProfile}\\.gemini\\antigravity\\bin\\agy.exe` : undefined,
        localAppData ? `${localAppData}\\Programs\\Antigravity\\bin\\agy.exe` : undefined,
        appData ? `${appData}\\Antigravity\\bin\\agy.exe` : undefined,
      ]) ??
      findWindowsBinaryOnPath(binary, env) ??
      binary;
  }

  const isCmdOrBat =
    resolvedBinary.toLowerCase().endsWith(".cmd") || resolvedBinary.toLowerCase().endsWith(".bat");

  if (!isCmdOrBat) {
    return { command: resolvedBinary, args: [...args], shell: false };
  }

  // To avoid Node DEP0190 ("Passing args to a child process with shell option true"),
  // invoke cmd.exe explicitly with shell: false.
  const comspec = env.ComSpec || "cmd.exe";
  return {
    command: comspec,
    args: ["/d", "/s", "/c", resolvedBinary, ...args],
    shell: false,
  };
}

export function classifyRequestType(toolName: string | undefined | null): CanonicalRequestType {
  const normalized = (toolName ?? "").toLowerCase().trim();
  if (
    normalized === "run_command" ||
    normalized === "send_command_input" ||
    normalized.includes("command") ||
    normalized.includes("terminal") ||
    normalized.includes("shell") ||
    normalized.includes("bash") ||
    normalized.includes("exec")
  ) {
    return "command_execution_approval";
  }
  if (
    normalized === "view_file" ||
    normalized === "list_dir" ||
    normalized === "find_by_name" ||
    normalized === "grep_search" ||
    normalized === "read_resource" ||
    normalized.includes("read")
  ) {
    return "file_read_approval";
  }
  if (
    normalized === "write_to_file" ||
    normalized === "replace_file_content" ||
    normalized === "multi_replace_file_content" ||
    normalized === "sed_file" ||
    normalized.includes("edit") ||
    normalized.includes("write")
  ) {
    return "file_change_approval";
  }
  return "dynamic_tool_call";
}

export function mapAntigravityToolToCanonicalItemType(
  toolName: string | undefined | null,
  parameters?: unknown,
): {
  readonly itemType: CanonicalItemType;
  readonly title: string;
} {
  const name = (toolName ?? "").toLowerCase().trim();
  const p =
    parameters && typeof parameters === "object"
      ? (parameters as Record<string, unknown>)
      : undefined;

  switch (name) {
    case "run_command":
    case "command_status":
    case "send_command_input":
      return { itemType: "command_execution", title: "Run command" };
    case "write_to_file":
    case "replace_file_content":
    case "multi_replace_file_content":
    case "sed_file":
    case "notebook_edit":
      return { itemType: "file_change", title: "Edit file" };
    case "view_file":
    case "list_dir":
    case "find_by_name":
    case "grep_search":
    case "read_resource":
    case "list_resources":
    case "list_permissions":
      return { itemType: "command_execution", title: `Inspect: ${toolName}` };
    case "search_web":
    case "read_url_content":
    case "read_browser_page":
    case "open_browser_url":
      return { itemType: "web_search", title: "Web search" };
    case "generate_image":
      return { itemType: "image_view", title: "Generate image" };
    case "call_mcp_tool":
      return { itemType: "mcp_tool_call", title: "MCP tool call" };
    case "invoke_subagent": {
      const subagents = Array.isArray(p?.Subagents) ? p?.Subagents : [];
      const firstSubagent = subagents[0] as Record<string, unknown> | undefined;
      const role = typeof firstSubagent?.Role === "string" ? firstSubagent.Role : undefined;
      const typeName =
        typeof firstSubagent?.TypeName === "string" ? firstSubagent.TypeName : undefined;
      return {
        itemType: "collab_agent_tool_call",
        title: role || typeName ? `Subagent: ${role || typeName}` : "Subagent task",
      };
    }
    case "send_message": {
      const recipient = typeof p?.Recipient === "string" ? p.Recipient : undefined;
      return {
        itemType: "collab_agent_tool_call",
        title: recipient ? `Message subagent: ${recipient}` : "Send message to subagent",
      };
    }
    case "define_subagent": {
      const subagentName = typeof p?.name === "string" ? p.name : undefined;
      return {
        itemType: "collab_agent_tool_call",
        title: subagentName ? `Define subagent: ${subagentName}` : "Define subagent",
      };
    }
    case "manage_subagents": {
      const action = typeof p?.Action === "string" ? p.Action : undefined;
      return {
        itemType: "collab_agent_tool_call",
        title: action ? `Manage subagents: ${action}` : "Manage subagents",
      };
    }
    default:
      return { itemType: "dynamic_tool_call", title: `Tool: ${toolName || "action"}` };
  }
}

export function getAntigravityToolDetail(parameters: unknown): string | undefined {
  if (!parameters || typeof parameters !== "object") return undefined;
  const p = parameters as Record<string, unknown>;
  if (typeof p.CommandLine === "string" && p.CommandLine.trim().length > 0) {
    return p.CommandLine.trim();
  }
  if (typeof p.command === "string" && p.command.trim().length > 0) {
    return p.command.trim();
  }
  if (typeof p.TargetFile === "string" && p.TargetFile.trim().length > 0) {
    return p.TargetFile.trim();
  }
  if (typeof p.AbsolutePath === "string" && p.AbsolutePath.trim().length > 0) {
    return p.AbsolutePath.trim();
  }
  if (typeof p.DirectoryPath === "string" && p.DirectoryPath.trim().length > 0) {
    return p.DirectoryPath.trim();
  }
  if (typeof p.path === "string" && p.path.trim().length > 0) {
    return p.path.trim();
  }
  if (typeof p.query === "string" && p.query.trim().length > 0) {
    return p.query.trim();
  }
  if (typeof p.Url === "string" && p.Url.trim().length > 0) {
    return p.Url.trim();
  }
  if (typeof p.Prompt === "string" && p.Prompt.trim().length > 0) {
    return p.Prompt.trim();
  }
  // Subagent parameter details
  if (Array.isArray(p.Subagents) && p.Subagents.length > 0) {
    const first = p.Subagents[0] as Record<string, unknown>;
    const roleOrType = first.Role || first.TypeName || "subagent";
    const prompt = typeof first.Prompt === "string" ? first.Prompt.slice(0, 100) : "";
    return prompt ? `${roleOrType}: ${prompt}` : String(roleOrType);
  }
  if (typeof p.Recipient === "string" && typeof p.Message === "string") {
    return `To ${p.Recipient}: ${p.Message.slice(0, 100)}`;
  }
  if (typeof p.name === "string" && typeof p.description === "string") {
    return `${p.name} - ${p.description.slice(0, 100)}`;
  }
  if (typeof p.Action === "string") {
    return `Action: ${p.Action}`;
  }
  return undefined;
}

const RECOVERABLE_ANTIGRAVITY_ERROR_SNIPPETS = [
  "not found",
  "missing conversation",
  "no such conversation",
  "unknown conversation",
  "does not exist",
  "connection reset",
  "econnreset",
  "broken pipe",
  "process exited",
];

export function isRecoverableAntigravityError(error: unknown): boolean {
  if (!error) return false;
  const message = (
    error instanceof Error
      ? error.message
      : typeof error === "object" && "detail" in error
        ? String((error as { detail: unknown }).detail)
        : String(error)
  ).toLowerCase();
  return RECOVERABLE_ANTIGRAVITY_ERROR_SNIPPETS.some((snippet) => message.includes(snippet));
}

export function resolveAntigravityContextLimit(
  model?: string,
  selectedContextWindow?: string,
): number {
  if (selectedContextWindow) {
    switch (selectedContextWindow.toLowerCase().trim()) {
      case "200k":
        return 200_000;
      case "1m":
        return 1_048_576;
      case "2m":
        return 2_097_152;
    }
  }
  const normalizedModel = (model ?? "").toLowerCase().trim();
  if (
    normalizedModel.includes("2.5-pro") ||
    normalizedModel.includes("1.5-pro") ||
    normalizedModel.includes("-pro") ||
    normalizedModel.includes("/pro")
  ) {
    return 2_097_152;
  }
  if (normalizedModel.includes("claude")) {
    return 200_000;
  }
  if (
    normalizedModel.includes("gpt-4") ||
    normalizedModel.includes("o1") ||
    normalizedModel.includes("o3")
  ) {
    return 128_000;
  }
  // Default context limit for Gemini Flash / standard Antigravity models: 1M tokens
  return 1_048_576;
}

export class AntigravitySessionRuntimeError extends Schema.TaggedErrorClass<AntigravitySessionRuntimeError>()(
  "AntigravitySessionRuntimeError",
  {
    threadId: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Antigravity session error for ${this.threadId}: ${this.detail}`;
  }
}

export class AntigravitySessionRuntimePendingApprovalNotFoundError extends Schema.TaggedErrorClass<AntigravitySessionRuntimePendingApprovalNotFoundError>()(
  "AntigravitySessionRuntimePendingApprovalNotFoundError",
  {
    requestId: Schema.String,
  },
) {
  override get message(): string {
    return `Unknown pending Antigravity approval request: ${this.requestId}`;
  }
}

export class AntigravitySessionRuntimePendingUserInputNotFoundError extends Schema.TaggedErrorClass<AntigravitySessionRuntimePendingUserInputNotFoundError>()(
  "AntigravitySessionRuntimePendingUserInputNotFoundError",
  {
    requestId: Schema.String,
  },
) {
  override get message(): string {
    return `Unknown pending Antigravity user input request: ${this.requestId}`;
  }
}

export type AntigravitySessionRuntimeFailure =
  | AntigravitySessionRuntimeError
  | AntigravitySessionRuntimePendingApprovalNotFoundError
  | AntigravitySessionRuntimePendingUserInputNotFoundError;

export interface AntigravitySessionRuntimeOptions {
  readonly threadId: ThreadId;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly settings: AntigravitySettings;
  readonly environment?: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly runtimeMode: RuntimeMode;
  readonly model?: string;
  readonly effort?: string;
  readonly contextWindow?: string;
  readonly resumeCursor?: AntigravityResumeCursor;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

export interface AntigravitySessionRuntimeSendTurnInput {
  readonly input?: string;
  readonly attachments?: ReadonlyArray<{
    readonly type: "image" | "file";
    readonly url?: string;
    readonly path?: string;
    readonly name?: string;
  }>;
  readonly model?: string;
  readonly effort?: string;
  readonly contextWindow?: string;
  readonly interactionMode?: ProviderInteractionMode;
}

export interface AntigravityThreadTurnSnapshot {
  readonly id: TurnId;
  readonly items: ReadonlyArray<unknown>;
}

export interface AntigravityThreadSnapshot {
  readonly threadId: ThreadId;
  readonly turns: ReadonlyArray<AntigravityThreadTurnSnapshot>;
}

export interface AntigravitySessionRuntimeShape {
  readonly start: () => Effect.Effect<ProviderSession, AntigravitySessionRuntimeFailure>;
  readonly getSession: Effect.Effect<ProviderSession>;
  readonly sendTurn: (
    input: AntigravitySessionRuntimeSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, AntigravitySessionRuntimeFailure>;
  readonly interruptTurn: (
    turnId?: TurnId,
  ) => Effect.Effect<void, AntigravitySessionRuntimeFailure>;
  readonly readThread: Effect.Effect<AntigravityThreadSnapshot, AntigravitySessionRuntimeError>;
  readonly rollbackThread: (
    numTurns: number,
  ) => Effect.Effect<AntigravityThreadSnapshot, AntigravitySessionRuntimeError>;
  readonly respondToRequest: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Effect.Effect<void, AntigravitySessionRuntimeFailure>;
  readonly respondToUserInput: (
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ) => Effect.Effect<void, AntigravitySessionRuntimeFailure>;
  readonly events: Stream.Stream<ProviderRuntimeEvent, never>;
  readonly close: Effect.Effect<void>;
}

interface PendingApproval {
  readonly requestId: ApprovalRequestId;
  readonly requestType: CanonicalRequestType;
  readonly detail?: string;
  /**
   * Identity of the underlying tool step. Re-emitted PENDING_APPROVAL state
   * for the same step must not open a second approval card.
   */
  readonly dedupeKey?: string;
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

interface PendingUserInput {
  readonly requestId: ApprovalRequestId;
  readonly questions: ReadonlyArray<UserInputQuestion>;
  /** Same purpose as `PendingApproval.dedupeKey`. */
  readonly dedupeKey?: string;
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
}

interface ActiveTurnState {
  readonly turnId: TurnId;
  readonly itemId: RuntimeItemId;
  fullText: string;
  stderrText: string;
  readonly promptText: string;
}

export const makeAntigravitySessionRuntime = (
  options: AntigravitySessionRuntimeOptions,
): Effect.Effect<
  AntigravitySessionRuntimeShape,
  AntigravitySessionRuntimeError,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const crypto = yield* Crypto.Crypto;
    const sessionScope = yield* Scope.make("sequential");
    const processEnv = options.environment ?? process.env;
    const instanceId = options.providerInstanceId ?? ProviderInstanceId.make("antigravity");
    const requestedModel = options.model ?? "gemini-3.7-flash";
    const initialResume = options.resumeCursor;
    const initialConvId = initialResume?.conversationId;
    const nativeLogger = options.nativeEventLogger;

    const eventsQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const pendingApprovalsRef = yield* Ref.make(new Map<ApprovalRequestId, PendingApproval>());
    const pendingUserInputsRef = yield* Ref.make(new Map<ApprovalRequestId, PendingUserInput>());
    const turnsRef = yield* Ref.make<Array<AntigravityThreadTurnSnapshot>>([]);
    const agyConversationIdRef = yield* Ref.make<string | undefined>(initialConvId);
    const currentModelRef = yield* Ref.make<string>(requestedModel);
    const currentEffortRef = yield* Ref.make<string>(options.effort ?? "medium");
    const currentContextWindowRef = yield* Ref.make<string | undefined>(options.contextWindow);
    const spawnedModelRef = yield* Ref.make<string | undefined>(undefined);
    const spawnedEffortRef = yield* Ref.make<string | undefined>(undefined);
    const activeTurnRef = yield* Ref.make<ActiveTurnState | undefined>(undefined);
    const closedRef = yield* Ref.make<boolean>(false);
    const stdinQueueRef = yield* Ref.make<Queue.Queue<Uint8Array> | undefined>(undefined);
    const isProcessRunningRef = yield* Ref.make<boolean>(false);
    const activeProcessRef = yield* Ref.make<ChildProcessSpawner.ChildProcessHandle | undefined>(
      undefined,
    );
    /**
     * Bumped on every spawn and every intentional process stop. Output/exit
     * watchers capture their generation and ignore themselves once it goes
     * stale, so a killed or replaced daemon can never emit events into a
     * newer turn.
     */
    const processGenerationRef = yield* Ref.make<number>(0);
    const lastInteractionModeRef = yield* Ref.make<ProviderInteractionMode | undefined>(undefined);

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new AntigravitySessionRuntimeError({
            threadId: options.threadId,
            detail: `UUID generation failed: ${cause}`,
          }),
      ),
    );

    const MAX_RETAINED_TURNS = 100;
    const recordCompletedTurn = (turn: AntigravityThreadTurnSnapshot) =>
      Ref.update(turnsRef, (turns) => {
        const next = [...turns, turn];
        return next.length > MAX_RETAINED_TURNS
          ? next.slice(next.length - MAX_RETAINED_TURNS)
          : next;
      });

    const stopCurrentProcess = Effect.fn("antigravity.stopProcess")(function* () {
      yield* Ref.update(processGenerationRef, (n) => n + 1);
      const child = yield* Ref.getAndSet(activeProcessRef, undefined);
      if (child) {
        yield* child
          .kill({ forceKillAfter: "2 seconds" })
          .pipe(Effect.catchCause(() => Effect.void));
      }
      const stdinQueue = yield* Ref.getAndSet(stdinQueueRef, undefined);
      if (stdinQueue) {
        yield* Queue.shutdown(stdinQueue);
      }
      yield* Ref.set(isProcessRunningRef, false);
    });

    const logNativeEvent = (direction: "in" | "out", payload: unknown): Effect.Effect<void> => {
      if (!nativeLogger) return Effect.void;
      return Effect.gen(function* () {
        const timestamp = yield* nowIso;
        yield* nativeLogger.write(
          {
            direction,
            timestamp,
            threadId: options.threadId,
            payload,
          },
          options.threadId,
        );
      }).pipe(Effect.catchCause(() => Effect.void));
    };

    const makeEventId = (type: string, turnId?: TurnId): Effect.Effect<EventId> =>
      Effect.gen(function* () {
        const uuid = yield* Effect.orDie(randomUUIDv4);
        return EventId.make(
          `${PROVIDER}:${instanceId}:${options.threadId}:${turnId ?? "session"}:${type}:${uuid}`,
        );
      });

    const offerEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
      Queue.offer(eventsQueue, event).pipe(Effect.asVoid);

    const sessionCreatedAt = yield* nowIso;
    const initialSession: ProviderSession = {
      provider: PROVIDER,
      providerInstanceId: instanceId,
      status: "ready",
      runtimeMode: options.runtimeMode,
      cwd: options.cwd,
      model: requestedModel,
      threadId: options.threadId,
      ...(initialResume
        ? {
            resumeCursor: {
              schemaVersion: ANTIGRAVITY_RESUME_VERSION,
              conversationId: initialResume.conversationId,
            },
          }
        : {}),
      createdAt: sessionCreatedAt,
      updatedAt: sessionCreatedAt,
    };
    const sessionRef = yield* Ref.make<ProviderSession>(initialSession);

    const writeToStdin = (content: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const queue = yield* Ref.get(stdinQueueRef);
        if (queue) {
          yield* logNativeEvent("in", content);
          const encoded = new TextEncoder().encode(content + "\n");
          yield* Queue.offer(queue, encoded);
        }
      });

    const emitUsageEvent = (usageData: unknown, turnId: TurnId): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (!usageData || typeof usageData !== "object") return;
        const u = usageData as Record<string, unknown>;
        const inputTokens = typeof u.input_tokens === "number" ? u.input_tokens : undefined;
        const outputTokens = typeof u.output_tokens === "number" ? u.output_tokens : undefined;
        const thinkingTokens =
          typeof u.thinking_tokens === "number" ? u.thinking_tokens : undefined;
        const cachedTokens =
          typeof u.cache_read_tokens === "number" ? u.cache_read_tokens : undefined;
        const totalTokens =
          typeof u.total_tokens === "number"
            ? u.total_tokens
            : (inputTokens ?? 0) + (outputTokens ?? 0) + (thinkingTokens ?? 0);

        const rawMaxTokens =
          typeof u.max_tokens === "number"
            ? u.max_tokens
            : typeof u.model_context_window === "number"
              ? u.model_context_window
              : typeof u.context_window === "number"
                ? u.context_window
                : typeof u.context_limit === "number"
                  ? u.context_limit
                  : undefined;

        const currentModel = yield* Ref.get(currentModelRef);
        const currentContextWindow = yield* Ref.get(currentContextWindowRef);
        const maxTokens =
          rawMaxTokens ?? resolveAntigravityContextLimit(currentModel, currentContextWindow);

        const eventId = yield* makeEventId("token.usage", turnId);
        const createdAt = yield* nowIso;
        yield* offerEvent({
          eventId,
          provider: PROVIDER,
          providerInstanceId: instanceId,
          threadId: options.threadId,
          turnId,
          createdAt,
          type: "thread.token-usage.updated",
          payload: {
            usage: {
              usedTokens: totalTokens,
              ...(maxTokens !== undefined && maxTokens > 0 ? { maxTokens } : {}),
              ...(inputTokens !== undefined ? { inputTokens, lastInputTokens: inputTokens } : {}),
              ...(outputTokens !== undefined
                ? { outputTokens, lastOutputTokens: outputTokens }
                : {}),
              ...(thinkingTokens !== undefined
                ? {
                    reasoningOutputTokens: thinkingTokens,
                    lastReasoningOutputTokens: thinkingTokens,
                  }
                : {}),
              ...(cachedTokens !== undefined
                ? { cachedInputTokens: cachedTokens, lastCachedInputTokens: cachedTokens }
                : {}),
              lastUsedTokens: totalTokens,
              ...(u.compactsAutomatically === true || u.compacts_automatically === true
                ? { compactsAutomatically: true }
                : {}),
            },
          },
        });
      });

    const processStdoutLine = (line: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const trimmed = line.trim();
        if (!trimmed) return;

        yield* logNativeEvent("out", trimmed);

        const activeTurn = yield* Ref.get(activeTurnRef);
        const currentTurnId = activeTurn?.turnId;
        const currentItemId = activeTurn?.itemId;

        // The daemon speaks newline-delimited JSON. Anything else is protocol
        // noise (banners, warnings, pretty-printed logs, partial JSON) and is
        // logged natively but never injected into the assistant message.
        // Event payloads are provider-defined and loosely shaped; they are
        // normalized field-by-field in each handler below.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let parsed: { [key: string]: any } | undefined;
        const decodedExit = decodeJsonStringExit(trimmed);
        if (Exit.isSuccess(decodedExit)) {
          const candidate: unknown = decodedExit.value;
          if (candidate !== null && typeof candidate === "object") {
            parsed = candidate as Record<string, unknown>;
          }
        }

        if (!parsed) {
          yield* Effect.logWarning("antigravity.stdout.non-json-line", {
            preview: trimmed.slice(0, 200),
          });
          return;
        }
        {
          // 1. Conversation init event
          if (parsed.event === "init" && parsed.conversation_id) {
            const convId = String(parsed.conversation_id);
            yield* Ref.set(agyConversationIdRef, convId);
            yield* Ref.update(sessionRef, (s) => ({
              ...s,
              resumeCursor: {
                schemaVersion: ANTIGRAVITY_RESUME_VERSION,
                conversationId: convId,
              },
            }));
            const eventId = yield* makeEventId("thread.started");
            const createdAt = yield* nowIso;
            yield* offerEvent({
              eventId,
              provider: PROVIDER,
              providerInstanceId: instanceId,
              threadId: options.threadId,
              createdAt,
              type: "thread.started",
              // The resume cursor rides on the announcement so the server can
              // persist the conversation id as soon as the daemon reports it;
              // without this a restart between turns starts a fresh agy
              // conversation and the thread loses its history.
              payload: {
                providerThreadId: convId,
                resumeCursor: {
                  schemaVersion: ANTIGRAVITY_RESUME_VERSION,
                  conversationId: convId,
                },
              },
            });
            return;
          }

          // 2. Step update event
          if (parsed.event === "step_update" && parsed.step_update) {
            const step = parsed.step_update;
            if (step.conversation_id) {
              const convId = String(step.conversation_id);
              yield* Ref.set(agyConversationIdRef, convId);
              yield* Ref.update(sessionRef, (s) => ({
                ...s,
                resumeCursor: {
                  schemaVersion: ANTIGRAVITY_RESUME_VERSION,
                  conversationId: convId,
                },
              }));
            }

            if (step.usage && currentTurnId) {
              yield* emitUsageEvent(step.usage, currentTurnId);
            }

            // Assistant message delta
            if (
              step.step_type === "agent_response" &&
              typeof step.text_delta === "string" &&
              step.text_delta.length > 0 &&
              currentTurnId &&
              currentItemId
            ) {
              if (activeTurn) {
                activeTurn.fullText += step.text_delta;
              }
              const eventId = yield* makeEventId("content.delta", currentTurnId);
              const createdAt = yield* nowIso;
              yield* offerEvent({
                eventId,
                provider: PROVIDER,
                providerInstanceId: instanceId,
                threadId: options.threadId,
                turnId: currentTurnId,
                itemId: currentItemId,
                createdAt,
                type: "content.delta",
                payload: { streamKind: "assistant_text", delta: step.text_delta },
              });
              return;
            }

            // Reasoning / Thought delta
            if (
              ((step.step_type === "thought" &&
                typeof step.text_delta === "string" &&
                step.text_delta.length > 0) ||
                (typeof step.thought_delta === "string" && step.thought_delta.length > 0)) &&
              currentTurnId &&
              currentItemId
            ) {
              const thoughtText = step.text_delta ?? step.thought_delta;
              const eventId = yield* makeEventId("content.delta.reasoning", currentTurnId);
              const createdAt = yield* nowIso;
              yield* offerEvent({
                eventId,
                provider: PROVIDER,
                providerInstanceId: instanceId,
                threadId: options.threadId,
                turnId: currentTurnId,
                itemId: currentItemId,
                createdAt,
                type: "content.delta",
                payload: { streamKind: "reasoning_text", delta: thoughtText },
              });
              return;
            }

            // Tool execution / approval / questionnaires
            if (step.step_type === "tool") {
              const toolName = String(step.tool_name ?? "action");
              const toolStepKey = String(step.step_index ?? toolName);
              const toolItemId = RuntimeItemId.make(
                `tool-${currentTurnId ?? "session"}-${toolStepKey}`,
              );
              const { itemType, title } = mapAntigravityToolToCanonicalItemType(
                toolName,
                step.tool_info?.parameters,
              );
              const detail = getAntigravityToolDetail(step.tool_info?.parameters);

              // Check for ask_question questionnaire tool
              if (
                toolName === "ask_question" &&
                step.state === "ACTIVE" &&
                step.tool_info?.parameters
              ) {
                const params = step.tool_info.parameters as Record<string, unknown>;
                const rawQuestions = Array.isArray(params.questions) ? params.questions : [];
                const questionDedupeKey = `question:${currentTurnId ?? "session"}:${toolStepKey}`;
                if (rawQuestions.length > 0) {
                  const existingInputs = yield* Ref.get(pendingUserInputsRef);
                  if (
                    [...existingInputs.values()].some(
                      (pending) => pending.dedupeKey === questionDedupeKey,
                    )
                  ) {
                    // Re-emitted state for the same questionnaire step; keep
                    // the single card already shown to the user.
                    return;
                  }
                  const reqUuid = yield* Effect.orDie(randomUUIDv4);
                  const requestId = ApprovalRequestId.make(reqUuid);
                  const runtimeRequestId = RuntimeRequestId.make(requestId);
                  const answersDeferred = yield* Deferred.make<ProviderUserInputAnswers>();

                  const questions: UserInputQuestion[] = rawQuestions.map(
                    (q: any, idx: number) => ({
                      id: String(q.id ?? `q_${idx}`),
                      header: String(q.header ?? "Clarification"),
                      question: String(q.question ?? ""),
                      options: Array.isArray(q.options)
                        ? q.options.map((opt: any) =>
                            typeof opt === "string"
                              ? { label: opt, description: opt }
                              : {
                                  label: String(opt.label ?? opt),
                                  description: String(opt.description ?? opt),
                                },
                          )
                        : [],
                      multiSelect: Boolean(q.is_multi_select || q.multiSelect),
                    }),
                  );

                  yield* Ref.update(pendingUserInputsRef, (map) =>
                    new Map(map).set(requestId, {
                      requestId,
                      questions,
                      dedupeKey: questionDedupeKey,
                      answers: answersDeferred,
                    }),
                  );

                  const eventId = yield* makeEventId("user-input.requested", currentTurnId);
                  const createdAt = yield* nowIso;
                  yield* offerEvent({
                    eventId,
                    provider: PROVIDER,
                    providerInstanceId: instanceId,
                    threadId: options.threadId,
                    turnId: currentTurnId,
                    itemId: toolItemId,
                    requestId: runtimeRequestId,
                    createdAt,
                    type: "user-input.requested",
                    payload: { questions },
                  });

                  // Background listener to correlate answers and send to stdin
                  yield* Deferred.await(answersDeferred).pipe(
                    Effect.flatMap((resolvedAnswers) =>
                      Effect.gen(function* () {
                        yield* Ref.update(pendingUserInputsRef, (map) => {
                          const next = new Map(map);
                          next.delete(requestId);
                          return next;
                        });
                        const resEventId = yield* makeEventId("user-input.resolved", currentTurnId);
                        const resCreatedAt = yield* nowIso;
                        yield* offerEvent({
                          eventId: resEventId,
                          provider: PROVIDER,
                          providerInstanceId: instanceId,
                          threadId: options.threadId,
                          turnId: currentTurnId,
                          requestId: runtimeRequestId,
                          createdAt: resCreatedAt,
                          type: "user-input.resolved",
                          payload: { answers: resolvedAnswers },
                        });

                        // Multi-Question ID Standardization: correlate by id, q_idx, numeric index, and prompt
                        const normalizedAnswers: Record<string, unknown> = { ...resolvedAnswers };
                        questions.forEach((q, idx) => {
                          const matchedAnswer =
                            resolvedAnswers[q.id] ??
                            resolvedAnswers[`q_${idx}`] ??
                            resolvedAnswers[String(idx)] ??
                            resolvedAnswers[q.question];
                          if (matchedAnswer !== undefined) {
                            normalizedAnswers[q.id] = matchedAnswer;
                            normalizedAnswers[`q_${idx}`] = matchedAnswer;
                            if (q.question) {
                              normalizedAnswers[q.question] = matchedAnswer;
                            }
                          }
                        });

                        yield* writeToStdin(
                          encodeUnknownJsonString({
                            event: "user_input_response",
                            request_id: requestId,
                            answers: normalizedAnswers,
                          }),
                        );
                      }),
                    ),
                    Effect.forkIn(sessionScope),
                  );
                  return;
                }
              }

              // Check for interactive tool approval request
              if (step.state === "PENDING_APPROVAL" || step.approval_required) {
                const approvalDedupeKey = `approval:${currentTurnId ?? "session"}:${toolStepKey}`;
                const existingApprovals = yield* Ref.get(pendingApprovalsRef);
                if (
                  [...existingApprovals.values()].some(
                    (pending) => pending.dedupeKey === approvalDedupeKey,
                  )
                ) {
                  // Re-emitted PENDING_APPROVAL state for a step that already
                  // has an open request; keep the single card.
                  return;
                }
                const reqUuid = yield* Effect.orDie(randomUUIDv4);
                const requestId = ApprovalRequestId.make(reqUuid);
                const runtimeRequestId = RuntimeRequestId.make(requestId);
                const requestType = classifyRequestType(toolName);
                const decisionDeferred = yield* Deferred.make<ProviderApprovalDecision>();

                yield* Ref.update(pendingApprovalsRef, (map) =>
                  new Map(map).set(requestId, {
                    requestId,
                    requestType,
                    ...(detail !== undefined ? { detail } : {}),
                    dedupeKey: approvalDedupeKey,
                    decision: decisionDeferred,
                  }),
                );

                const eventId = yield* makeEventId("request.opened", currentTurnId);
                const createdAt = yield* nowIso;
                yield* offerEvent({
                  eventId,
                  provider: PROVIDER,
                  providerInstanceId: instanceId,
                  threadId: options.threadId,
                  turnId: currentTurnId,
                  itemId: toolItemId,
                  requestId: runtimeRequestId,
                  createdAt,
                  type: "request.opened",
                  payload: {
                    requestType,
                    detail,
                    args: step.tool_info?.parameters,
                  },
                });

                // Background listener to send decision once resolved
                yield* Deferred.await(decisionDeferred).pipe(
                  Effect.flatMap((resolvedDecision) =>
                    Effect.gen(function* () {
                      yield* Ref.update(pendingApprovalsRef, (map) => {
                        const next = new Map(map);
                        next.delete(requestId);
                        return next;
                      });
                      const resEventId = yield* makeEventId("request.resolved", currentTurnId);
                      const resCreatedAt = yield* nowIso;
                      yield* offerEvent({
                        eventId: resEventId,
                        provider: PROVIDER,
                        providerInstanceId: instanceId,
                        threadId: options.threadId,
                        turnId: currentTurnId,
                        requestId: runtimeRequestId,
                        createdAt: resCreatedAt,
                        type: "request.resolved",
                        payload: { requestType, decision: resolvedDecision },
                      });
                      yield* writeToStdin(
                        encodeUnknownJsonString({
                          event: "permission_response",
                          request_id: requestId,
                          decision: resolvedDecision,
                        }),
                      );
                    }),
                  ),
                  Effect.forkIn(sessionScope),
                );
                return;
              }

              // Tool lifecycle events (including subagent hierarchies)
              if (step.state === "ACTIVE") {
                const eventId = yield* makeEventId(`tool.started.${toolStepKey}`, currentTurnId);
                const createdAt = yield* nowIso;
                yield* offerEvent({
                  eventId,
                  provider: PROVIDER,
                  providerInstanceId: instanceId,
                  threadId: options.threadId,
                  turnId: currentTurnId,
                  itemId: toolItemId,
                  createdAt,
                  type: "item.started",
                  payload: {
                    itemType,
                    status: "inProgress",
                    title,
                    ...(detail ? { detail } : {}),
                    ...(step.tool_info?.parameters ? { data: step.tool_info.parameters } : {}),
                  },
                });
              } else if (step.state === "DONE" || step.state === "ERROR") {
                const isError = step.state === "ERROR" || Boolean(step.tool_info?.error);
                const errorMessage =
                  step.tool_info?.error?.message ?? (isError ? "Tool execution failed" : undefined);
                const eventId = yield* makeEventId(`tool.completed.${toolStepKey}`, currentTurnId);
                const createdAt = yield* nowIso;
                yield* offerEvent({
                  eventId,
                  provider: PROVIDER,
                  providerInstanceId: instanceId,
                  threadId: options.threadId,
                  turnId: currentTurnId,
                  itemId: toolItemId,
                  createdAt,
                  type: "item.completed",
                  payload: {
                    itemType,
                    status: isError ? "failed" : "completed",
                    title,
                    ...(errorMessage ? { detail: errorMessage } : detail ? { detail } : {}),
                    ...(step.tool_info ? { data: step.tool_info } : {}),
                  },
                });
              }
              return;
            }
            return;
          }

          // 3. Direct Permission Request
          if (parsed.event === "permission_request" || parsed.event === "tool_approval_request") {
            const reqIdStr = String(parsed.request_id ?? (yield* Effect.orDie(randomUUIDv4)));
            const requestId = ApprovalRequestId.make(reqIdStr);
            const existingApprovals = yield* Ref.get(pendingApprovalsRef);
            if (existingApprovals.has(requestId)) {
              // Duplicate delivery of the same provider request id.
              return;
            }
            const runtimeRequestId = RuntimeRequestId.make(requestId);
            const toolName = String(parsed.tool_name ?? "action");
            const requestType = classifyRequestType(toolName);
            const detail = getAntigravityToolDetail(
              parsed.tool_info?.parameters ?? parsed.parameters,
            );
            const decisionDeferred = yield* Deferred.make<ProviderApprovalDecision>();

            yield* Ref.update(pendingApprovalsRef, (map) =>
              new Map(map).set(requestId, {
                requestId,
                requestType,
                ...(detail !== undefined ? { detail } : {}),
                decision: decisionDeferred,
              }),
            );

            const eventId = yield* makeEventId("request.opened", currentTurnId);
            const createdAt = yield* nowIso;
            yield* offerEvent({
              eventId,
              provider: PROVIDER,
              providerInstanceId: instanceId,
              threadId: options.threadId,
              turnId: currentTurnId,
              requestId: runtimeRequestId,
              createdAt,
              type: "request.opened",
              payload: {
                requestType,
                detail,
                args: parsed.tool_info?.parameters ?? parsed.parameters,
              },
            });

            yield* Deferred.await(decisionDeferred).pipe(
              Effect.flatMap((resolvedDecision) =>
                Effect.gen(function* () {
                  yield* Ref.update(pendingApprovalsRef, (map) => {
                    const next = new Map(map);
                    next.delete(requestId);
                    return next;
                  });
                  const resEventId = yield* makeEventId("request.resolved", currentTurnId);
                  const resCreatedAt = yield* nowIso;
                  yield* offerEvent({
                    eventId: resEventId,
                    provider: PROVIDER,
                    providerInstanceId: instanceId,
                    threadId: options.threadId,
                    turnId: currentTurnId,
                    requestId: runtimeRequestId,
                    createdAt: resCreatedAt,
                    type: "request.resolved",
                    payload: { requestType, decision: resolvedDecision },
                  });
                  yield* writeToStdin(
                    encodeUnknownJsonString({
                      event: "permission_response",
                      request_id: requestId,
                      decision: resolvedDecision,
                    }),
                  );
                }),
              ),
              Effect.forkIn(sessionScope),
            );
            return;
          }

          // 4. Result event (Turn Completion)
          if (parsed.event === "result" && parsed.result) {
            const res = parsed.result;
            if (res.conversation_id) {
              const convId = String(res.conversation_id);
              yield* Ref.set(agyConversationIdRef, convId);
              yield* Ref.update(sessionRef, (s) => ({
                ...s,
                resumeCursor: {
                  schemaVersion: ANTIGRAVITY_RESUME_VERSION,
                  conversationId: convId,
                },
              }));
            }

            if (res.usage && currentTurnId) {
              yield* emitUsageEvent(res.usage, currentTurnId);
            }

            const isError = res.status === "ERROR" || Boolean(res.error);
            const errorMsg = isError
              ? String(res.error || res.response || "Antigravity turn error")
              : undefined;

            // Discard non-fatal stderr warnings if turn finished successfully
            if (!isError && activeTurn) {
              activeTurn.stderrText = "";
            }

            if (isError && activeTurn && !activeTurn.fullText && currentTurnId && currentItemId) {
              const isCanceledOrTimeout =
                errorMsg?.toLowerCase().includes("context canceled") ||
                errorMsg?.toLowerCase().includes("timed out") ||
                errorMsg?.toLowerCase().includes("timeout");
              const errorDelta = isCanceledOrTimeout
                ? `\n\n> ⚠️ **Turn timed out (${errorMsg}).** File modifications and tool operations completed before the timeout were preserved on disk, but the final response summary was interrupted. You can ask what was done or continue the turn.\n`
                : `\n\n**Error:** ${errorMsg}\n`;
              activeTurn.fullText = errorDelta.trim();
              const eventId = yield* makeEventId("content.delta.error", currentTurnId);
              const createdAt = yield* nowIso;
              yield* offerEvent({
                eventId,
                provider: PROVIDER,
                providerInstanceId: instanceId,
                threadId: options.threadId,
                turnId: currentTurnId,
                itemId: currentItemId,
                createdAt,
                type: "content.delta",
                payload: {
                  streamKind: "assistant_text",
                  delta: errorDelta,
                },
              });
            } else if (
              typeof res.response === "string" &&
              activeTurn &&
              !activeTurn.fullText &&
              currentTurnId &&
              currentItemId
            ) {
              activeTurn.fullText = res.response;
              const eventId = yield* makeEventId("content.delta", currentTurnId);
              const createdAt = yield* nowIso;
              yield* offerEvent({
                eventId,
                provider: PROVIDER,
                providerInstanceId: instanceId,
                threadId: options.threadId,
                turnId: currentTurnId,
                itemId: currentItemId,
                createdAt,
                type: "content.delta",
                payload: { streamKind: "assistant_text", delta: res.response },
              });
            }

            if (currentTurnId && currentItemId && activeTurn) {
              // Complete assistant message item
              const compEventId = yield* makeEventId("item.complete", currentTurnId);
              const compCreatedAt = yield* nowIso;
              yield* offerEvent({
                eventId: compEventId,
                provider: PROVIDER,
                providerInstanceId: instanceId,
                threadId: options.threadId,
                turnId: currentTurnId,
                itemId: currentItemId,
                createdAt: compCreatedAt,
                type: "item.completed",
                payload: {
                  itemType: "assistant_message",
                  status: isError ? "failed" : "completed",
                },
              });

              // If activeTurn text contains <proposed_plan>, emit canonical plan lifecycle items
              const proposedPlanMatch = activeTurn.fullText.match(
                /<proposed_plan>([\s\S]*?)<\/proposed_plan>/i,
              );
              if (proposedPlanMatch && proposedPlanMatch[1]) {
                const planContent = proposedPlanMatch[1].trim();
                const planItemId = RuntimeItemId.make(`plan-${currentTurnId}`);
                const firstLine =
                  planContent
                    .split("\n")[0]
                    ?.replace(/^[#\s]+/, "")
                    .trim() || "Proposed Plan";

                const planStartEventId = yield* makeEventId("item.start.plan", currentTurnId);
                const planStartCreatedAt = yield* nowIso;
                yield* offerEvent({
                  eventId: planStartEventId,
                  provider: PROVIDER,
                  providerInstanceId: instanceId,
                  threadId: options.threadId,
                  turnId: currentTurnId,
                  itemId: planItemId,
                  createdAt: planStartCreatedAt,
                  type: "item.started",
                  payload: {
                    itemType: "plan",
                    status: "inProgress",
                    title: "Plan",
                    detail: firstLine,
                    data: { plan: planContent },
                  },
                });

                const planCompEventId = yield* makeEventId("item.complete.plan", currentTurnId);
                const planCompCreatedAt = yield* nowIso;
                yield* offerEvent({
                  eventId: planCompEventId,
                  provider: PROVIDER,
                  providerInstanceId: instanceId,
                  threadId: options.threadId,
                  turnId: currentTurnId,
                  itemId: planItemId,
                  createdAt: planCompCreatedAt,
                  type: "item.completed",
                  payload: {
                    itemType: "plan",
                    status: "completed",
                    title: "Plan",
                    detail: firstLine,
                    data: { plan: planContent },
                  },
                });
              }

              // Complete turn
              const turnCompEventId = yield* makeEventId("turn.complete", currentTurnId);
              const turnCompCreatedAt = yield* nowIso;
              const resumeConvId = yield* Ref.get(agyConversationIdRef);
              yield* offerEvent({
                eventId: turnCompEventId,
                provider: PROVIDER,
                providerInstanceId: instanceId,
                threadId: options.threadId,
                turnId: currentTurnId,
                createdAt: turnCompCreatedAt,
                type: "turn.completed",
                payload: {
                  state: isError ? "failed" : "completed",
                  ...(errorMsg ? { errorMessage: errorMsg } : {}),
                  ...(resumeConvId ? { providerThreadId: resumeConvId } : {}),
                  ...(resumeConvId
                    ? {
                        resumeCursor: {
                          schemaVersion: ANTIGRAVITY_RESUME_VERSION,
                          conversationId: resumeConvId,
                        },
                      }
                    : {}),
                },
              });

              yield* recordCompletedTurn({
                id: currentTurnId,
                items: [{ prompt: activeTurn.promptText, response: activeTurn.fullText }],
              });
              yield* Ref.set(activeTurnRef, undefined);
            }
            return;
          }

          // 5. Fallback token / thought
          if (parsed.type === "token" && parsed.content && currentTurnId && currentItemId) {
            if (activeTurn) activeTurn.fullText += parsed.content;
            const eventId = yield* makeEventId("content.delta", currentTurnId);
            const createdAt = yield* nowIso;
            yield* offerEvent({
              eventId,
              provider: PROVIDER,
              providerInstanceId: instanceId,
              threadId: options.threadId,
              turnId: currentTurnId,
              itemId: currentItemId,
              createdAt,
              type: "content.delta",
              payload: { streamKind: "assistant_text", delta: parsed.content },
            });
            return;
          }

          if (parsed.type === "thought" && parsed.content && currentTurnId && currentItemId) {
            const eventId = yield* makeEventId("content.delta.thought", currentTurnId);
            const createdAt = yield* nowIso;
            yield* offerEvent({
              eventId,
              provider: PROVIDER,
              providerInstanceId: instanceId,
              threadId: options.threadId,
              turnId: currentTurnId,
              itemId: currentItemId,
              createdAt,
              type: "content.delta",
              payload: { streamKind: "reasoning_text", delta: parsed.content },
            });
            return;
          }
        }
      });

    const spawnProcess = Effect.fn("spawnProcess")(function* () {
      const isRunning = yield* Ref.get(isProcessRunningRef);
      if (isRunning) return;
      // Claim the slot before any awaits so concurrent callers cannot
      // double-spawn.
      yield* Ref.set(isProcessRunningRef, true);
      // Every spawn gets a fresh generation; watchers of older processes
      // become stale and drop their events.
      const generation = yield* Ref.updateAndGet(processGenerationRef, (n) => n + 1);

      const agyConversationId = yield* Ref.get(agyConversationIdRef);
      const currentModel = yield* Ref.get(currentModelRef);
      const currentEffort = yield* Ref.get(currentEffortRef);
      yield* Ref.set(spawnedModelRef, currentModel);
      yield* Ref.set(spawnedEffortRef, currentEffort);
      const runtimeMode = options.runtimeMode;
      const skipPermissions =
        runtimeMode === "full-access" || runtimeMode === "auto" || !runtimeMode;

      let spawnCommand: { command: string; args: Array<string>; shell: boolean };

      if (options.settings.usePythonSdk) {
        const pythonBinary = options.settings.pythonPath || "python";
        const bridgePath = NodePath.resolve(__dirname, "../scripts/antigravity_bridge.py");
        const pyArgs = [
          "-u",
          bridgePath,
          "--input-format",
          "stream-json",
          "--output-format",
          "stream-json",
          "--model",
          currentModel,
          "--effort",
          currentEffort,
        ];
        if (options.cwd) {
          pyArgs.push("--cwd", options.cwd);
        }
        if (agyConversationId) {
          pyArgs.push("--conversation", agyConversationId);
        }
        spawnCommand = { command: pythonBinary, args: pyArgs, shell: false };
      } else {
        const binary = options.settings.binaryPath || "agy";
        const args: Array<string> = [
          "--input-format",
          "stream-json",
          "--output-format",
          "stream-json",
        ];

        if (skipPermissions) {
          args.push("--dangerously-skip-permissions");
        }

        if (agyConversationId) {
          args.push("--conversation", agyConversationId);
        }

        if (currentModel) {
          args.push("--model", currentModel, "--effort", currentEffort);
        }

        const hasCustomTimeout =
          options.settings.launchArgs && options.settings.launchArgs.includes("--print-timeout");
        if (!hasCustomTimeout) {
          args.push("--print-timeout", "30m");
        }

        if (options.settings.launchArgs) {
          args.push(...options.settings.launchArgs.split(/\s+/).filter(Boolean));
        }

        spawnCommand = resolveAntigravitySpawnCommand(binary, args, processEnv);
      }

      yield* Effect.logInfo("antigravity.session.spawn", {
        command: spawnCommand.command,
        args: spawnCommand.args,
        cwd: options.cwd,
        agyConversationId,
      });

      const child = yield* spawner
        .spawn(
          ChildProcess.make(spawnCommand.command, spawnCommand.args, {
            cwd: options.cwd,
            env: processEnv,
            shell: spawnCommand.shell,
            forceKillAfter: "2 seconds",
          }),
        )
        .pipe(
          Effect.provideService(Scope.Scope, sessionScope),
          Effect.mapError(
            (cause) =>
              new AntigravitySessionRuntimeError({
                threadId: options.threadId,
                detail: `Failed to spawn Antigravity process: ${cause}`,
              }),
          ),
          Effect.tapError(() => Ref.set(isProcessRunningRef, false)),
        );

      yield* Ref.set(activeProcessRef, child);

      // Create stdin streaming queue
      const stdinQueue = yield* Queue.unbounded<Uint8Array>();
      yield* Ref.set(stdinQueueRef, stdinQueue);

      // Pipe stdin queue into child.stdin
      yield* Stream.fromQueue(stdinQueue).pipe(
        Stream.run(child.stdin),
        Effect.catchCause((cause) => Effect.logWarning("antigravity.stdin.closed", { cause })),
        Effect.forkIn(sessionScope),
      );

      // Process stdout & stderr streams
      let stdoutBuffer = "";
      const isStaleGeneration = Effect.map(Ref.get(processGenerationRef), (g) => g !== generation);
      yield* Effect.all(
        [
          child.stdout.pipe(
            Stream.decodeText(),
            Stream.runForEach((text) =>
              Effect.gen(function* () {
                if (yield* isStaleGeneration) return;
                stdoutBuffer += text;
                const lines = stdoutBuffer.split("\n");
                stdoutBuffer = lines.pop() ?? "";
                for (const line of lines) {
                  yield* processStdoutLine(line);
                }
              }),
            ),
          ),
          child.stderr.pipe(
            Stream.decodeText(),
            Stream.runForEach((errChunk) =>
              Effect.gen(function* () {
                if (yield* isStaleGeneration) return;
                const activeTurn = yield* Ref.get(activeTurnRef);
                if (activeTurn) {
                  activeTurn.stderrText += errChunk;
                }
                yield* logNativeEvent("out", `[stderr] ${errChunk}`);
                yield* Effect.logWarning("antigravity.stderr", { chunk: errChunk });
              }),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            if (stdoutBuffer.trim().length > 0) {
              yield* processStdoutLine(stdoutBuffer);
            }
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* Effect.logWarning("antigravity.stream.failure", { cause });
          }),
        ),
        Effect.forkIn(sessionScope),
      );

      // Watch child exit
      yield* child.exitCode.pipe(
        Effect.flatMap((exitCode) =>
          Effect.gen(function* () {
            // A replaced/killed daemon must not report its exit against a
            // newer process or turn.
            if (yield* isStaleGeneration) return;
            yield* Ref.set(isProcessRunningRef, false);
            yield* Ref.update(activeProcessRef, (current) =>
              current === child ? undefined : current,
            );
            yield* Effect.logInfo("antigravity.process.exited", { exitCode });

            const activeTurn = yield* Ref.get(activeTurnRef);
            if (activeTurn) {
              const currentTurnId = activeTurn.turnId;
              const currentItemId = activeTurn.itemId;
              if (exitCode === 0) {
                activeTurn.stderrText = "";
              }
              const errorMessage =
                activeTurn.stderrText.trim() ||
                (exitCode !== 0
                  ? `Antigravity process exited unexpectedly with code ${exitCode}.`
                  : undefined);

              if (errorMessage && !activeTurn.fullText) {
                const eventId = yield* makeEventId("content.delta.exit", currentTurnId);
                const createdAt = yield* nowIso;
                yield* offerEvent({
                  eventId,
                  provider: PROVIDER,
                  providerInstanceId: instanceId,
                  threadId: options.threadId,
                  turnId: currentTurnId,
                  itemId: currentItemId,
                  createdAt,
                  type: "content.delta",
                  payload: {
                    streamKind: "assistant_text",
                    delta: `\n\n**Error:** ${errorMessage}\n`,
                  },
                });
              }

              const compEventId = yield* makeEventId("item.complete.exit", currentTurnId);
              const compCreatedAt = yield* nowIso;
              yield* offerEvent({
                eventId: compEventId,
                provider: PROVIDER,
                providerInstanceId: instanceId,
                threadId: options.threadId,
                turnId: currentTurnId,
                itemId: currentItemId,
                createdAt: compCreatedAt,
                type: "item.completed",
                payload: {
                  itemType: "assistant_message",
                  status: exitCode === 0 ? "completed" : "failed",
                },
              });

              const turnCompEventId = yield* makeEventId("turn.complete.exit", currentTurnId);
              const turnCompCreatedAt = yield* nowIso;
              const resumeConvId = yield* Ref.get(agyConversationIdRef);
              yield* offerEvent({
                eventId: turnCompEventId,
                provider: PROVIDER,
                providerInstanceId: instanceId,
                threadId: options.threadId,
                turnId: currentTurnId,
                createdAt: turnCompCreatedAt,
                type: "turn.completed",
                payload: {
                  state: exitCode === 0 ? "completed" : "failed",
                  ...(errorMessage ? { errorMessage } : {}),
                  ...(resumeConvId ? { providerThreadId: resumeConvId } : {}),
                  ...(resumeConvId
                    ? {
                        resumeCursor: {
                          schemaVersion: ANTIGRAVITY_RESUME_VERSION,
                          conversationId: resumeConvId,
                        },
                      }
                    : {}),
                },
              });

              yield* recordCompletedTurn({
                id: currentTurnId,
                items: [{ prompt: activeTurn.promptText, response: activeTurn.fullText }],
              });
              yield* Ref.set(activeTurnRef, undefined);
            }
          }),
        ),
        Effect.forkIn(sessionScope),
      );
    });

    const start = (): Effect.Effect<ProviderSession, AntigravitySessionRuntimeError> =>
      Effect.gen(function* () {
        yield* spawnProcess();

        const checkedAt = yield* nowIso;
        const agyConvId = yield* Ref.get(agyConversationIdRef);
        const eventId = yield* makeEventId("session.started");

        yield* offerEvent({
          eventId,
          provider: PROVIDER,
          providerInstanceId: instanceId,
          threadId: options.threadId,
          createdAt: checkedAt,
          type: "session.started",
          payload: {
            ...(agyConvId ? { providerThreadId: agyConvId } : {}),
            ...(initialResume !== undefined ? { resume: initialResume } : {}),
          },
        });

        return yield* Ref.get(sessionRef);
      });

    const getSession = Ref.get(sessionRef);

    const sendTurn = (
      input: AntigravitySessionRuntimeSendTurnInput,
    ): Effect.Effect<ProviderTurnStartResult, AntigravitySessionRuntimeError> =>
      Effect.gen(function* () {
        const isClosed = yield* Ref.get(closedRef);
        if (isClosed) {
          return yield* new AntigravitySessionRuntimeError({
            threadId: options.threadId,
            detail: "Antigravity session is closed.",
          });
        }

        const inFlightTurn = yield* Ref.get(activeTurnRef);
        if (inFlightTurn) {
          return yield* new AntigravitySessionRuntimeError({
            threadId: options.threadId,
            detail: `A turn is already in progress (${inFlightTurn.turnId}). Interrupt it before starting a new one.`,
          });
        }

        const selectedModel = input.model ?? (yield* Ref.get(currentModelRef));
        const selectedEffort = input.effort ?? (yield* Ref.get(currentEffortRef));
        const selectedContextWindow =
          input.contextWindow ?? (yield* Ref.get(currentContextWindowRef));
        yield* Ref.set(currentModelRef, selectedModel);
        yield* Ref.set(currentEffortRef, selectedEffort);
        yield* Ref.set(currentContextWindowRef, selectedContextWindow);

        // Ensure process is alive and matches selected model/effort; kill and
        // respawn when the daemon was started with different launch flags.
        const isRunning = yield* Ref.get(isProcessRunningRef);
        const spawnedModel = yield* Ref.get(spawnedModelRef);
        const spawnedEffort = yield* Ref.get(spawnedEffortRef);

        if (isRunning && (spawnedModel !== selectedModel || spawnedEffort !== selectedEffort)) {
          yield* stopCurrentProcess();
          yield* spawnProcess();
        } else if (!isRunning) {
          yield* spawnProcess();
        }

        const turnUuid = yield* randomUUIDv4;
        const turnId = TurnId.make(`turn-${turnUuid}`);
        const itemId = RuntimeItemId.make(`item-${turnId}`);

        let textPrompt = typeof input.input === "string" ? input.input.trim() : "";
        const imagePaths: Array<string> = [];
        const activeCwd = options.cwd;

        if (input.attachments && input.attachments.length > 0) {
          const attachmentLines = input.attachments
            .map((att) => {
              if (att.type === "file") {
                return att.path ? `[Attached File: ${att.path}]` : `[Attached File: ${att.name}]`;
              }
              if (att.type === "image") {
                if (att.path) {
                  imagePaths.push(att.path);
                  return `[Attached Image: ${att.path}]`;
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

        const currentMode = input.interactionMode ?? "default";
        const previousMode = yield* Ref.get(lastInteractionModeRef);
        yield* Ref.set(lastInteractionModeRef, currentMode);

        const isSwitchingFromPlanToDefault = currentMode === "default" && previousMode === "plan";

        const developerInstructions = buildAntigravityDeveloperInstructions(input.interactionMode, {
          model: selectedModel,
          reasoningEffort: selectedEffort,
        });

        if (currentMode === "plan" || isSwitchingFromPlanToDefault) {
          textPrompt = `<developer_instructions>\n${developerInstructions}\n</developer_instructions>\n\n${textPrompt}`;
        }

        const activeTurn: ActiveTurnState = {
          turnId,
          itemId,
          fullText: "",
          stderrText: "",
          promptText: textPrompt,
        };
        yield* Ref.set(activeTurnRef, activeTurn);

        const turnStartEventId = yield* makeEventId("turn.start", turnId);
        const createdAt = yield* nowIso;

        yield* offerEvent({
          eventId: turnStartEventId,
          provider: PROVIDER,
          providerInstanceId: instanceId,
          threadId: options.threadId,
          turnId,
          createdAt,
          type: "turn.started",
          payload: {
            model: selectedModel,
            effort: selectedEffort,
          },
        });

        const itemStartEventId = yield* makeEventId("item.start", turnId);
        yield* offerEvent({
          eventId: itemStartEventId,
          provider: PROVIDER,
          providerInstanceId: instanceId,
          threadId: options.threadId,
          turnId,
          itemId,
          createdAt,
          type: "item.started",
          payload: {
            itemType: "assistant_message",
            status: "inProgress",
          },
        });

        // Write turn message JSON to persistent daemon process stdin
        const turnMessageJson = encodeUnknownJsonString({
          event: "user",
          message: {
            content: textPrompt,
          },
        });
        yield* writeToStdin(turnMessageJson);

        return { threadId: options.threadId, turnId };
      });

    const interruptTurn = (turnId?: TurnId): Effect.Effect<void, AntigravitySessionRuntimeError> =>
      Effect.gen(function* () {
        const activeTurn = yield* Ref.get(activeTurnRef);
        const targetTurnId = turnId ?? activeTurn?.turnId;

        // Cancel any pending approvals
        const pendingApprovals = yield* Ref.get(pendingApprovalsRef);
        for (const [reqId, pending] of pendingApprovals) {
          yield* Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore);
          const eventId = yield* makeEventId("request.resolved.cancelled", targetTurnId);
          const createdAt = yield* nowIso;
          yield* offerEvent({
            eventId,
            provider: PROVIDER,
            providerInstanceId: instanceId,
            threadId: options.threadId,
            ...(targetTurnId ? { turnId: targetTurnId } : {}),
            requestId: RuntimeRequestId.make(reqId),
            createdAt,
            type: "request.resolved",
            payload: { requestType: pending.requestType, decision: "cancel" },
          });
        }
        yield* Ref.set(pendingApprovalsRef, new Map());

        // Settle pending user inputs with empty answers
        const pendingUserInputs = yield* Ref.get(pendingUserInputsRef);
        for (const [reqId, pending] of pendingUserInputs) {
          yield* Deferred.succeed(pending.answers, {}).pipe(Effect.ignore);
          const eventId = yield* makeEventId("user-input.resolved.cancelled", targetTurnId);
          const createdAt = yield* nowIso;
          yield* offerEvent({
            eventId,
            provider: PROVIDER,
            providerInstanceId: instanceId,
            threadId: options.threadId,
            ...(targetTurnId ? { turnId: targetTurnId } : {}),
            requestId: RuntimeRequestId.make(reqId),
            createdAt,
            type: "user-input.resolved",
            payload: { answers: {} },
          });
        }
        yield* Ref.set(pendingUserInputsRef, new Map());

        // Write interrupt event to stdin
        yield* writeToStdin(encodeUnknownJsonString({ event: "interrupt" })).pipe(
          Effect.catchCause(() => Effect.void),
        );

        // Terminate the daemon rather than trusting it to honour the stdin
        // interrupt: late output from a still-running process must not mutate
        // the next turn. The next sendTurn respawns with the same conversation.
        yield* stopCurrentProcess().pipe(Effect.catchCause(() => Effect.void));

        if (targetTurnId) {
          const eventId = yield* makeEventId("turn.complete.interrupted", targetTurnId);
          const createdAt = yield* nowIso;
          yield* offerEvent({
            eventId,
            provider: PROVIDER,
            providerInstanceId: instanceId,
            threadId: options.threadId,
            turnId: targetTurnId,
            createdAt,
            type: "turn.completed",
            payload: { state: "interrupted" },
          });
        }

        yield* Ref.set(activeTurnRef, undefined);
      });

    const respondToRequest = (
      requestId: ApprovalRequestId,
      decision: ProviderApprovalDecision,
    ): Effect.Effect<void, AntigravitySessionRuntimeFailure> =>
      Effect.gen(function* () {
        const pendingApprovals = yield* Ref.get(pendingApprovalsRef);
        const pending = pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new AntigravitySessionRuntimePendingApprovalNotFoundError({ requestId });
        }
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput = (
      requestId: ApprovalRequestId,
      answers: ProviderUserInputAnswers,
    ): Effect.Effect<void, AntigravitySessionRuntimeFailure> =>
      Effect.gen(function* () {
        const pendingUserInputs = yield* Ref.get(pendingUserInputsRef);
        const pending = pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* new AntigravitySessionRuntimePendingUserInputNotFoundError({ requestId });
        }
        yield* Deferred.succeed(pending.answers, answers);
      });

    const readThread = Effect.map(Ref.get(turnsRef), (turns) => ({
      threadId: options.threadId,
      turns,
    }));

    const rollbackThread = (numTurns: number) =>
      Effect.gen(function* () {
        const turns = yield* Ref.get(turnsRef);
        // Note: this trims only the local in-memory snapshot. The daemon-side
        // conversation keeps the rolled-back turns, so the next send continues
        // with full provider context.
        const nextTurns = turns.slice(0, Math.max(0, turns.length - numTurns));
        yield* Ref.set(turnsRef, nextTurns);
        return { threadId: options.threadId, turns: nextTurns };
      });

    const close = Effect.gen(function* () {
      yield* Ref.set(closedRef, true);
      yield* interruptTurn().pipe(Effect.catchCause(() => Effect.void));
      yield* Queue.shutdown(eventsQueue);
      yield* Scope.close(sessionScope, Exit.void);
      yield* Ref.set(isProcessRunningRef, false);
    });

    return {
      start,
      getSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      events: Stream.fromQueue(eventsQueue),
      close,
    };
  });
