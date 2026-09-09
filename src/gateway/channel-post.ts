import { ChannelType, PermissionFlagsBits, type Message } from "discord.js";

/** Intent is selected by the model; the executor enforces scope and permissions. */
export async function postChannelMessage(message: Message, args: unknown) {
  const { channel_id: id, content } = (args ?? {}) as { channel_id?: unknown; content?: unknown };
  const allowed = [...message.content.matchAll(/<#(\d+)>/g)].map(match => match[1]);
  if (typeof id !== "string" || !allowed.includes(id)) throw new Error("今回指定されたチャンネルにのみ投稿できます");
  if (typeof content !== "string" || !content.trim() || content.length > 2000) throw new Error("投稿本文は1〜2000文字で指定してください");
  if (!message.guild || !message.client.user) throw new Error("サーバー内でのみ投稿できます");
  await message.guild.members.fetch(message.author.id);
  await message.guild.members.fetch(message.client.user.id);
  const channel = await message.guild.channels.fetch(id);
  if (!channel || channel.guild.id !== message.guildId || channel.type !== ChannelType.GuildText) throw new Error("このサーバーの通常のテキストチャンネルを指定してください");
  const required = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages;
  if (!channel.permissionsFor(message.author.id)?.has(required) || !channel.permissionsFor(message.client.user.id)?.has(required)) throw new Error("依頼者またはBotに投稿権限がありません");
  // A stable nonce makes repeated execution of the same inbound request idempotent.
  const sent = await channel.send({ content, allowedMentions: { parse: [] }, nonce: message.id, enforceNonce: true });
  return { posted: true, channelId: id, messageId: sent.id, url: sent.url };
}
