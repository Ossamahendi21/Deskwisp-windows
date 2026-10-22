/**
 * The bots' mascots, as SVG markup in a 0 0 40 40 box: little wisps in the bot's color, a soft flame
 * shape with a curl at its tip and a spark floating beside it (the Deskwisp look). Idle, a wisp rests
 * with its eyes closed; at work, it opens them, each bot with its own expression. One source for the
 * app, the bots' desktops, and their pictures in Slack, Telegram and Discord
 * (scripts/render-mascots.mjs). Plain TypeScript: no React, no imports.
 */

export type Mood = "idle" | "awake";

/** The wisp: a rounded body that narrows into a curled tip, leaning a little to the right. */
const WISP =
  "M21.5 2.5c-.6 3.4 1.4 5.6 4.6 7.6C31.2 13.4 35 18.2 35 24.6 35 32 28.6 37.5 20 37.5S5 32 5 24.6c0-4.9 2.6-8.8 6-11.4.1 2.4 1.2 4.1 3.1 4.9-.4-6.2 2.3-11.5 7.4-15.6z";
const INK = "#16132B";
/** Deskwisp's accent. */
export const ACCENT = "#7C5CFF";
/** The main bot's body. */
export const MAIN_COLOR = "#16132B";

/** A workspace's main bot (its id from older installs is kept as it was): drawn in ink, with an accent spark. */
export const isMainBotId = (botId: string) => /^(sam|wispy)(-\d+)?$/.test(botId);

/** Each bot's own face when it's working, fixed by its id: open eyes, a smile, or a wink. */
const FACES = ["open", "happy", "wink"] as const;
export function faceOf(botId: string): (typeof FACES)[number] {
  if (isMainBotId(botId)) return "open";
  let h = 0;
  for (const ch of botId.replace(/-\d+$/, "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return FACES[h % FACES.length];
}

const eyes = (face: "rest" | (typeof FACES)[number], c: string) => {
  const arc = (d: string) => `<path d="${d}" fill="none" stroke="${c}" stroke-width="1.7" stroke-linecap="round"/>`;
  if (face === "rest") return arc("M13.4 25q1.9 1.8 3.8 0M22.8 25q1.9 1.8 3.8 0");
  if (face === "happy") return arc("M13.4 26.1q1.9-2.1 3.8 0M22.8 26.1q1.9-2.1 3.8 0");
  const dot = (cx: number) => `<ellipse cx="${cx}" cy="25.1" rx="1.9" ry="2.6" fill="${c}"/>`;
  if (face === "wink") return dot(15.3) + arc("M22.8 25.3q1.9 1.7 3.8 0");
  return dot(15.3) + dot(24.7);
};

/** A four-point spark floating up and to the right of the tip. */
const spark = (c: string) => `<path d="M33 3.2c.4 2.6 1.4 3.6 4 4-2.6.4-3.6 1.4-4 4-.4-2.6-1.4-3.6-4-4 2.6-.4 3.6-1.4 4-4z" fill="${c}"/>`;

/**
 * The Deskwisp logo: Wispy in white, smiling, its spark in yellow, on violet. It's the app's icon, the
 * installer's, the favicons, the website's and the one the chat apps show (scripts/render-icons.mjs
 * renders them all from it). Inside the app the main bot keeps its ink. "circle" for icons, "square"
 * for pictures that other apps crop themselves.
 */
const LOGO_GLYPH =
  `<path d="${WISP}" fill="#fff"/>` +
  `<path d="M13.4 25.6q1.9-2.3 3.8 0M22.8 25.6q1.9-2.3 3.8 0" fill="none" stroke="${MAIN_COLOR}" stroke-width="1.8" stroke-linecap="round"/>` +
  `<path d="M17.4 28.6q2.6 3.4 5.2 0z" fill="${MAIN_COLOR}"/>` +
  spark("#FFC83D");
export const logoMarkup = (shape: "circle" | "square" = "circle") =>
  (shape === "circle" ? `<circle cx="20" cy="20" r="20" fill="${ACCENT}"/>` : `<rect width="40" height="40" fill="${ACCENT}"/>`) +
  `<g transform="translate(7.2 7.2) scale(.64)">${LOGO_GLYPH}</g>`;
export const logoSvg = (shape: "circle" | "square" = "circle") => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">${logoMarkup(shape)}</svg>`;

/**
 * A bot's mascot. `accent` false draws the main bot's spark in a quiet grey instead of the accent
 * (for spots where the accent would clash).
 */
export function mascotMarkup(botId: string, color: string, opts: { mood?: Mood; accent?: boolean } = {}) {
  const mood = opts.mood ?? "idle";
  const face = mood === "idle" ? "rest" : faceOf(botId);
  const glow = `<path d="M25.2 15.2c2.6 1.2 4.6 3.1 5.7 5.6" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" opacity=".35"/>`;
  if (isMainBotId(botId)) {
    const lit = opts.accent !== false;
    return `<path d="${WISP}" fill="${MAIN_COLOR}"/>${glow}${eyes(face, "#fff")}${spark(lit ? ACCENT : "#8B88A3")}`;
  }
  const cheeks = `<ellipse cx="11.4" cy="29" rx="2" ry="1.1" fill="#fff" opacity=".45"/><ellipse cx="28.6" cy="29" rx="2" ry="1.1" fill="#fff" opacity=".45"/>`;
  return `<path d="${WISP}" fill="${color}"/>${glow}${eyes(face, INK)}${cheeks}${spark(INK)}`;
}

/**
 * The bots' pictures, rendered ahead of time (scripts/render-mascots.mjs) into edge/public/mascot,
 * served at /mascot/<name>.png and .jpg for Slack, Telegram and Discord: the main bot, and a wisp in
 * each of these colors (new bots' colors).
 */
export const PICTURE_COLORS = ["#FF9F43", "#2EC4B6", "#A78BFA", "#F87171", "#60A5FA", "#34D399", "#FFC83D", "#FF6FB5", "#47C46B", "#5B8CFF"];
export const PICTURE_SHAPES: Record<string, string> = {};

/** A bot's rendered picture ("wisp-2EC4B6"), or null when its color has none (it shows the logo instead). */
export function pictureName(b: { id: string; color: string; isMain: boolean }): string | null {
  if (b.isMain) return `main-${MAIN_COLOR.slice(1)}`;
  const hex = b.color.replace("#", "").toUpperCase();
  return PICTURE_COLORS.some((c) => c.slice(1).toUpperCase() === hex) ? `wisp-${hex}` : null;
}

/** A whole SVG document for a bot's mascot, for pages outside the app. */
export const mascotSvg = (botId: string, color: string, size: number, mood: Mood = "idle") =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="${size}" height="${size}">${mascotMarkup(botId, color, { mood })}</svg>`;
