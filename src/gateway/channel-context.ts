import { ChannelType, PermissionFlagsBits, type Message, type TextChannel } from "discord.js";

const READ = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.ReadMessageHistory;

export function canShareChannel(source: Pick<TextChannel, "id" | "guild" | "permissionsFor" | "permissionOverwrites">, destinationId: string, requesterId: string, botId: string): boolean {
  if (!source.permissionsFor(requesterId)?.has(READ) || !source.permissionsFor(botId)?.has(READ)) return false;
  if (source.id === destinationId) return true;
  // Cross-channel replies are public: exclude any source with restricted readership.
  if (!source.permissionsFor(source.guild.roles.everyone)?.has(READ)) return false;
  return !source.permissionOverwrites.cache.some(overwrite => overwrite.deny.any(READ));
}

export async function readMentionedChannels(message: Message, selectedIds?: string[]): Promise<{ context: string; status: string; readable: boolean } | null> {
  const referenced = [...new Set([...message.content.matchAll(/<#(\d+)>/g)].map(match => match[1]!))];
  const ids = selectedIds ? selectedIds.filter(id => referenced.includes(id)) : referenced;
  if (!ids.length || !message.guild || !message.client.user) return null;
  const entries: Array<Record<string, unknown>> = [];
  const statuses: string[] = [];
  let readable = false;
  try {
    await message.guild.members.fetch(message.author.id);
    await message.guild.members.fetch(message.client.user.id);
  } catch {
    return { context: "", status: "閲覧権限を確認できませんでした。少し待って再度お試しください。", readable: false };
  }
  for (const id of ids.slice(0, 3)) {
    try {
      const source = await message.guild.channels.fetch(id);
      if (!source || source.guild.id !== message.guildId || (source.type !== ChannelType.GuildText && source.type !== ChannelType.GuildAnnouncement)) {
        statuses.push(`<#${id}>: このサーバーの通常のテキストチャンネルを指定してください。`);
        continue;
      }
      if (!canShareChannel(source, message.channelId, message.author.id, message.client.user.id)) {
        statuses.push(`<#${id}>: 閲覧権限または公開先の制約により、ここには内容を掲載できません。`);
        continue;
      }
      const messages = await source.messages.fetch({ limit: 20 });
      const rows = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp).map(item => ({
        timestamp: item.createdAt.toISOString(),
        content: item.content.slice(0, 350),
        url: `https://discord.com/channels/${message.guildId}/${id}/${item.id}`,
        attachmentCount: item.attachments.size,
      }));
      const hasText = rows.some(row => row.content.trim());
      readable ||= hasText;
      entries.push({ channel: source.name, channelId: id, scope: "直近20件まで。添付ファイル本文は未取得。", messages: rows });
      statuses.push(channelReadStatus(id, rows.length, hasText));
    } catch {
      statuses.push(`<#${id}>: 履歴の取得に失敗しました。未確認の内容は回答しません。`);
    }
  }
  if (ids.length > 3) statuses.push("参照は1回につき3チャンネルまでです。");
  return { context: JSON.stringify({ sources: entries, status: statuses }), status: statuses.join("\n"), readable };
}

export function channelReadStatus(id: string, count: number, hasText: boolean): string {
  if (hasText) return `<#${id}>: チャンネルを閲覧でき、直近${count}件を取得しました。`;
  if (count === 0) return `<#${id}>: チャンネルにはアクセスできましたが、履歴APIから投稿が返ってきませんでした。`;
  return `<#${id}>: 投稿${count}件の存在は確認できましたが、本文は取得できていません。添付のみの投稿や、Message Content Intentの設定による制限が考えられます。チャンネルが空とは判断できません。`;
}
