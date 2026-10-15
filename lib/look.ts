import type { Bot } from "./types";

/* Bot colors as the UI paints them, shared by the app and the computers Deskwisp dresses (lib/server/desktop). */

export const DESKTOP_BG =
  "linear-gradient(160deg, #F1EDFF 0%, #DED6FF 45%, #B9A9FF 100%)";

/** A soft wash of a bot's color, for its desktop wallpaper and Details card. */
export function botWash(b: Bot) {
  if (b.color.toUpperCase() === "#C9BDFF" || b.isMain) return DESKTOP_BG;
  return `linear-gradient(160deg, color-mix(in oklab, ${b.color} 22%, white) 0%, color-mix(in oklab, ${b.color} 38%, white) 55%, color-mix(in oklab, ${b.color} 62%, white) 100%)`;
}

/** The bezel color when you've taken over a bot's computer: the bot's own color (the main bot's violet). */
export function botBezel(b: Bot) {
  if (b.isMain || b.color.toUpperCase() === "#C9BDFF") return "#7C5CFF";
  return b.color;
}

/** The bot's color as text or an accent on black (its buttons): the main bot's violet, others' own color, lifted a little. */
export function botOnInk(b: Bot) {
  if (b.isMain || b.color.toUpperCase() === "#C9BDFF") return "#C9BDFF";
  return `color-mix(in oklab, ${b.color} 85%, white)`;
}
