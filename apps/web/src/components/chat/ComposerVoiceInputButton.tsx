import { memo, useCallback, useEffect, useRef, useState } from "react";
import { MicIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

type VoiceInputState = "idle" | "recording" | "processing";

/** Prototype guard: never record longer than this, even if stop is missed. */
const MAX_RECORDING_MS = 120_000;

const formatElapsed = (totalSeconds: number) => {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

const pickAudioMimeType = () => {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    return "";
  }
  for (const candidate of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]) {
    try {
      if (MediaRecorder.isTypeSupported(candidate)) return candidate;
    } catch {
      /* Unsupported string — fall through to the next candidate. */
    }
  }
  return "";
};

/**
 * Prototype seam for the server STT call. The button owns capture + UX states;
 * transcription arrives here as an audio clip and (once wired) resolves to
 * text inserted at the composer cursor. For the prototype it only proves the
 * clip was captured and says so out loud.
 */
const transcribeVoiceClipPrototype = async (clip: { blob: Blob; durationSeconds: number }) => {
  console.info("[voice-input prototype] captured clip", {
    bytes: clip.blob.size,
    mimeType: clip.blob.type || "browser-default",
    durationSeconds: clip.durationSeconds,
  });
  toastManager.add({
    type: "info",
    title: "Voice input is a prototype",
    description: `Captured ${formatElapsed(clip.durationSeconds)} of audio. The transcription engine is not connected yet.`,
  });
};

/**
 * Prototype mic button for composer voice input. Sits between attach and send,
 * owns the full capture UX (idle → recording → processing), and hands the
 * recorded clip to `onTranscribe` — the seam where server STT plugs in.
 */
export const ComposerVoiceInputButton = memo(function ComposerVoiceInputButton({
  preserveComposerFocusOnPointerDown = false,
  onTranscribe = transcribeVoiceClipPrototype,
}: {
  preserveComposerFocusOnPointerDown?: boolean;
  onTranscribe?: (clip: { blob: Blob; durationSeconds: number }) => Promise<void>;
}) {
  const [state, setState] = useState<VoiceInputState>("idle");
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const autoStopRef = useRef<number | null>(null);

  const cleanupCapture = useCallback(() => {
    if (autoStopRef.current !== null) {
      window.clearTimeout(autoStopRef.current);
      autoStopRef.current = null;
    }
    recorderRef.current = null;
    chunksRef.current = [];
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => cleanupCapture, [cleanupCapture]);

  const finishClip = useCallback(
    async (blob: Blob) => {
      const durationSeconds = Math.max(1, Math.round((Date.now() - startedAtRef.current) / 1000));
      setState("processing");
      try {
        await onTranscribe({ blob, durationSeconds });
      } finally {
        cleanupCapture();
        setState("idle");
      }
    },
    [cleanupCapture, onTranscribe],
  );

  const startRecording = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      toastManager.add({
        type: "warning",
        title: "Microphone is not available",
        description: "Voice input needs a secure context (https or localhost) with a microphone.",
      });
      return;
    }
    setState("recording");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = pickAudioMimeType();
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      streamRef.current = stream;
      recorderRef.current = recorder;
      chunksRef.current = [];
      startedAtRef.current = Date.now();
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const mimeType = recorder.mimeType || undefined;
        const blob =
          mimeType === undefined
            ? new Blob(chunksRef.current)
            : new Blob(chunksRef.current, { type: mimeType });
        void finishClip(blob);
      };
      recorder.start();
      autoStopRef.current = window.setTimeout(() => {
        if (recorderRef.current?.state === "recording") recorderRef.current.stop();
      }, MAX_RECORDING_MS);
    } catch (error) {
      cleanupCapture();
      setState("idle");
      const denied = error instanceof DOMException && error.name === "NotAllowedError";
      toastManager.add({
        type: "warning",
        title: denied ? "Microphone access was denied" : "Could not start recording",
        description: denied
          ? "Allow microphone access in the browser to dictate with your voice."
          : "The microphone could not be opened. Try again once another app releases it.",
      });
    }
  }, [cleanupCapture, finishClip]);

  const toggleRecording = useCallback(() => {
    if (state === "recording") {
      if (recorderRef.current?.state === "recording") recorderRef.current.stop();
      return;
    }
    if (state === "idle") void startRecording();
  }, [state, startRecording]);

  if (state === "processing") {
    return (
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        disabled
        aria-label="Processing voice input"
        data-voice-input-state="processing"
      >
        <Spinner className="size-4" aria-hidden="true" />
      </Button>
    );
  }

  const isRecording = state === "recording";

  if (isRecording) {
    /* Recording: same ghost mic button, turned red with a soft breathing
       halo. No extra shapes — the red mic is the whole signal. */
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onPointerDown={
                preserveComposerFocusOnPointerDown ? (event) => event.preventDefault() : undefined
              }
              onClick={toggleRecording}
              aria-label="Stop recording"
              aria-pressed
              data-voice-input-state="recording"
              className="relative"
            />
          }
        >
          <span
            aria-hidden="true"
            className="absolute inset-1 rounded-full bg-destructive/15 motion-safe:animate-voice-pulse"
          />
          <span
            aria-hidden="true"
            className="absolute inset-0.5 rounded-full border-2 border-destructive"
          />
          <MicIcon
            aria-hidden="true"
            className="relative size-4 text-destructive motion-safe:animate-voice-pulse"
          />
        </TooltipTrigger>
        <TooltipPopup>Stop recording</TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onPointerDown={
              preserveComposerFocusOnPointerDown ? (event) => event.preventDefault() : undefined
            }
            onClick={toggleRecording}
            aria-label="Dictate with your voice"
            aria-pressed={false}
            data-voice-input-state={state}
          />
        }
      >
        <MicIcon aria-hidden="true" className="size-4" />
      </TooltipTrigger>
      <TooltipPopup>Dictate with your voice</TooltipPopup>
    </Tooltip>
  );
});
