"use client";

import { useEffect, useRef, useState } from "react";

type Phase = "idle" | "recording" | "transcribing";

/** A recording stops on its own past this (a message, not a meeting). */
const MAX_MS = 5 * 60_000;

/** How many bars the recording's waveform shows, newest on the right. */
const BARS = 14;

/** Where to let Deskwisp use the mic, in this computer's own words. */
const micSettings = () =>
  /Windows/i.test(navigator.userAgent) ? "Windows Settings → Privacy & security → Microphone" : "System Settings → Privacy & Security → Microphone";

/** The best format this browser records in that OpenAI reads: Opus in WebM, else MP4. */
const recordingType = () => ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((t) => MediaRecorder.isTypeSupported(t)) ?? "";

/**
 * The composer's mic: click to talk, click again (or press Enter) to stop, and what you said lands in
 * the message box to read before sending (Esc throws the recording away). Transcribed by
 * /api/transcribe (gpt-transcribe), counted for the bot the chat is with.
 */
export function MicButton({ botId, onText, onError }: { botId?: string; onText: (text: string) => void; onError: (message: string) => void }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [startedAt, setStartedAt] = useState(0);
  const [now, setNow] = useState(0);
  // How loud you are, the last few beats: the waveform that shows it's hearing you.
  const [levels, setLevels] = useState<number[]>(() => Array(BARS).fill(0));
  const rec = useRef<{ recorder: MediaRecorder; stream: MediaStream; keep: boolean; timer: ReturnType<typeof setTimeout>; ctx?: AudioContext; meter?: AnalyserNode } | null>(null);
  // Asking for the mic (a second click meanwhile would start a second recorder, never stopped), and whether the composer is still here.
  const asking = useRef(false);
  const here = useRef(true);

  // The clock and the waveform while recording.
  useEffect(() => {
    if (phase !== "recording") return;
    const buf = new Uint8Array(512);
    const t = setInterval(() => {
      setNow(Date.now());
      const meter = rec.current?.meter;
      if (!meter) return;
      meter.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += ((v - 128) / 128) ** 2;
      const level = Math.min(1, Math.sqrt(sum / buf.length) * 4);
      setLevels((l) => [...l.slice(1), level]);
    }, 90);
    return () => clearInterval(t);
  }, [phase]);

  const stop = (keep: boolean) => {
    const r = rec.current;
    if (!r || r.recorder.state === "inactive") return;
    r.keep = keep;
    clearTimeout(r.timer);
    r.recorder.stop();
  };

  // Enter stops (and keeps) a recording; Esc throws it away. Leaving the chat throws it away too.
  useEffect(() => {
    if (phase !== "recording") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      stop(e.key === "Enter");
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [phase]);
  // Set again on every mount: React's development mode mounts twice, and the first unmount mustn't
  // leave the mic thinking the composer went away (it would let go of the mic the moment it got it).
  useEffect(() => {
    here.current = true;
    return () => {
      here.current = false;
      stop(false);
    };
  }, []);

  const start = async () => {
    if (asking.current || rec.current) return;
    asking.current = true;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      return onError(/denied|permission|notallowed/i.test(`${(e as Error).name} ${(e as Error).message}`) ? `Deskwisp needs microphone access. Turn it on in ${micSettings()}.` : (e as Error).message);
    } finally {
      asking.current = false;
    }
    // The composer went away while the mic was being asked for: let it go at once.
    if (!here.current) return stream.getTracks().forEach((t) => t.stop());
    const type = recordingType();
    const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      void rec.current?.ctx?.close().catch(() => {});
      const keep = rec.current?.keep;
      rec.current = null;
      if (!keep || !chunks.length) return setPhase("idle");
      setPhase("transcribing");
      const form = new FormData();
      form.append("audio", new Blob(chunks, { type: recorder.mimeType || type || "audio/webm" }));
      if (botId) form.append("botId", botId);
      try {
        const res = await fetch("/api/transcribe", { method: "POST", body: form });
        const body = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
        if (!res.ok) throw new Error(body.error ?? "Couldn't hear that. Try again.");
        if (body.text) onText(body.text);
        else onError("Didn't catch any words. Try again.");
      } catch (e) {
        onError((e as Error).message);
      } finally {
        setPhase("idle");
      }
    };
    rec.current = { recorder, stream, keep: false, timer: setTimeout(() => stop(true), MAX_MS) };
    try {
      const ctx = new AudioContext();
      const meter = ctx.createAnalyser();
      meter.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(meter);
      rec.current.ctx = ctx;
      rec.current.meter = meter;
    } catch {
      // No waveform then; the recording goes on.
    }
    setLevels(Array(BARS).fill(0));
    recorder.start(1000);
    setStartedAt(Date.now());
    setNow(Date.now());
    setPhase("recording");
  };

  const secs = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (phase === "recording")
    return (
      <button
        type="button"
        onClick={() => stop(true)}
        aria-label="Stop recording"
        data-tip="Stop · Enter to finish, Esc to cancel"
        className="flex h-[30px] shrink-0 items-center gap-2 rounded-full bg-[#FDECEA] pl-2.5 pr-3 text-[12.5px] font-medium tabular-nums leading-4 text-[#B42318]"
      >
        <span className="size-2 animate-pulse rounded-full bg-[#D92D20]" />
        <span aria-hidden className="flex h-4 items-center gap-[2px]">
          {levels.map((l, i) => (
            <span key={i} className="w-[2px] rounded-full bg-[#D92D20] transition-[height] duration-75" style={{ height: `${Math.max(2, Math.round(l * 16))}px`, opacity: 0.45 + l * 0.55 }} />
          ))}
        </span>
        {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, "0")}
      </button>
    );
  return (
    <button
      type="button"
      onClick={() => void start()}
      disabled={phase === "transcribing"}
      aria-label={phase === "transcribing" ? "Transcribing" : "Talk instead of typing"}
      data-tip={phase === "transcribing" ? "Writing down what you said…" : "Talk instead of typing"}
      className="flex size-[30px] shrink-0 items-center justify-center rounded-full text-[#6B6B6B] hover:bg-[#F2F2F0] hover:text-ink disabled:hover:bg-transparent"
    >
      {phase === "transcribing" ? (
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className="animate-spin">
          <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.6" />
          <path d="M14 8a6 6 0 00-6-6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
          <rect x="5.5" y="1.75" width="5" height="8.5" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M3 7.75a5 5 0 0010 0M8 12.75v1.75" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      )}
    </button>
  );
}
