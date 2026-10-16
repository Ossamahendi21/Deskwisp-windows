import { addMessage, getState, id, update } from "@/lib/server/store";
import { botChatId, workspaceOf, type Chat } from "@/lib/types";
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

/**
 * Change a group chat: rename it (an empty title goes back to its bots' names), archive it / bring it
 * back, or add a bot to it / take one out (`add` / `remove`: a bot id). A group keeps at least two bots;
 * its chat says who was added or taken out.
 */
export async function PATCH(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  const { chatId, title, archived, add, remove } = (await request.json().catch(() => ({}))) as {
    chatId?: string;
    title?: string;
    archived?: boolean;
    add?: string;
    remove?: string;
  };
  const c = getState().chats.find((x) => x.id === chatId);
  if (!c || c.kind !== "group") return Response.json({ error: "no such group" }, { status: 404 });
  const joining = add ? getState().bots.find((b) => b.id === add) : undefined;
  if (add) {
    if (!joining) return Response.json({ error: "no such bot" }, { status: 404 });
    if (workspaceOf(joining) !== (c.workspaceId ?? workspaceOf(undefined))) return Response.json({ error: `${joining.name} is on another team` }, { status: 409 });
  }
  const adding = !!joining && !c.botIds.includes(joining.id);
  const leaving = remove ? getState().bots.find((b) => b.id === remove) : undefined;
  if (remove) {
    if (!c.botIds.includes(remove)) return Response.json({ error: "That bot isn't in this group" }, { status: 404 });
    if (c.botIds.length <= 2) return Response.json({ error: "A group needs at least two bots. Delete the group instead, or add another bot first." }, { status: 409 });
  }
  update(() => {
    if (typeof title === "string") c.title = title.replace(/\s+/g, " ").trim().slice(0, 60) || undefined;
    if (typeof archived === "boolean") c.archived = archived || undefined;
    if (adding) c.botIds = [...c.botIds, joining!.id];
    if (remove) {
      c.botIds = c.botIds.filter((x) => x !== remove);
      c.typing = c.typing.filter((x) => x !== remove);
      if (c.asking) delete c.asking[remove];
    }
  });
  if (adding) addMessage({ chatId: c.id, role: "system", text: `You added ${joining!.name} to the group` });
  if (remove) addMessage({ chatId: c.id, role: "system", text: `You took ${leaving?.name ?? "a bot"} out of the group` });
  return Response.json({ ok: true, botIds: c.botIds });
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
