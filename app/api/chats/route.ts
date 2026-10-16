import { getState, id, update } from "@/lib/server/store";
import { botChatId, type Chat } from "@/lib/types";
import { notReady } from "@/lib/server/ready";

/** Start a conversation: one bot opens its own chat, two or more make a group chat. */
export async function POST(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  const { botIds, title } = (await request.json()) as { botIds?: string[]; title?: string };
  if (!botIds?.length) return Response.json({ error: "pick at least one bot" }, { status: 400 });
  if (botIds.length === 1) return Response.json({ chatId: botChatId(botIds[0]) });
  const chat: Chat = { id: id("grp"), kind: "group", botIds, title: title?.trim() || undefined, createdAt: Date.now(), typing: [], workspaceId: getState().workspace };
  update((s) => s.chats.push(chat));
  return Response.json({ chatId: chat.id });
}

/** Rename a group chat (an empty title goes back to its bots' names), or archive it / bring it back. */
export async function PATCH(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  const { chatId, title, archived } = (await request.json().catch(() => ({}))) as { chatId?: string; title?: string; archived?: boolean };
  const c = getState().chats.find((x) => x.id === chatId);
  if (!c || c.kind !== "group") return Response.json({ error: "no such group" }, { status: 404 });
  update(() => {
    if (typeof title === "string") c.title = title.replace(/\s+/g, " ").trim().slice(0, 60) || undefined;
    if (typeof archived === "boolean") c.archived = archived || undefined;
  });
  return Response.json({ ok: true });
}

/** Delete a group chat and its messages. (A bot's own chat goes when the bot does.) */
export async function DELETE(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  const { chatId } = (await request.json().catch(() => ({}))) as { chatId?: string };
  update((s) => {
    const c = s.chats.find((x) => x.id === chatId);
    if (!c || c.kind !== "group") return;
    s.chats = s.chats.filter((x) => x.id !== chatId);
    s.messages = s.messages.filter((m) => m.chatId !== chatId);
  });
  return Response.json({ ok: true });
}
