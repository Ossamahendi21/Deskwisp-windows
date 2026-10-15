"use client";

import { createContext, useContext } from "react";
import { mascotMarkup } from "@/lib/mascot";

/**
 * Plush-style bot mascots with headphones (lib/mascot.ts draws them). Every mascot in the app reads
 * which bots are at work from one place (BusyBots, set at the top of the app): a busy bot opens its
 * eyes, an idle one vibes with them closed.
 */
export const BusyBots = createContext<ReadonlySet<string>>(new Set());

export function Mascot({
  botId,
  color,
  size = 24,
  antenna = true,
}: {
  botId: string;
  color: string;
  size?: number;
  /** The main bot's highlighter headphones; false draws them in ink (the chat pill's small mark). */
  antenna?: boolean;
}) {
  const awake = useContext(BusyBots).has(botId);
  // Markup comes from our own constant shapes and bot colors, never from user text.
  return (
    <svg
      viewBox="0 0 40 40"
      style={{ width: size, height: size, flexShrink: 0 }}
      dangerouslySetInnerHTML={{ __html: mascotMarkup(botId, color, { mood: awake ? "awake" : "idle", accent: antenna }) }}
    />
  );
}

export function Spinner({ size = 13, color = "#16132B" }: { size?: number; color?: string }) {
  return (
    <svg viewBox="0 0 14 14" width={size} height={size} className="animate-spin" style={{ flexShrink: 0 }}>
      <circle cx="7" cy="7" r="5.2" fill="none" stroke={color} strokeWidth="1.6" strokeDasharray="24 9" strokeLinecap="round" />
    </svg>
  );
}

/** Two sparks, the kind that float off a wisp. */
const NOTES = [
  '<path d="M12 2c.7 4.6 2.6 6.6 7.2 7.2-4.6.7-6.5 2.6-7.2 7.2-.7-4.6-2.6-6.5-7.2-7.2C9.4 8.6 11.3 6.6 12 2z"/>',
  '<path d="M12 4c.5 3.4 1.9 4.8 5.3 5.3-3.4.5-4.8 1.9-5.3 5.3-.5-3.4-1.9-4.8-5.3-5.3C10.1 8.8 11.5 7.4 12 4z"/><circle cx="18.5" cy="17.5" r="1.6"/>',
];

/**
 * Wispy listening to music, bopping to the beat while notes drift out of its headphones: the app's
 * first load, the same scene as the window's splash (desktop/splash.html). CSS only (globals.css).
 */
export function WispyLoading({ label, children }: { label: string; children?: React.ReactNode }) {
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-3.5 text-[13px] text-pencil select-none">
      <div className="wispy-loading-scene" aria-hidden="true">
        <div className="wispy-loading-shadow" />
        {(["l", "r", "l", "r"] as const).map((side, i) => (
          <svg key={i} className={`wispy-loading-note ${side}`} viewBox="0 0 24 24" dangerouslySetInnerHTML={{ __html: `<g fill="#7C5CFF">${NOTES[i === 0 || i === 3 ? 0 : 1]}</g>` }} />
        ))}
        <svg className="wispy-loading-wispy" viewBox="0 0 40 40" dangerouslySetInnerHTML={{ __html: mascotMarkup("wispy", "#16132B", { mood: "awake" }) }} />
      </div>
      <div>{label}</div>
      {/* Below the label without moving it: the scene stays where the splash had it. */}
      {children && (
        <div className="relative -mt-3.5 h-0 w-full">
          <div className="absolute top-3.5 left-1/2 -translate-x-1/2">{children}</div>
        </div>
      )}
    </div>
  );
}
