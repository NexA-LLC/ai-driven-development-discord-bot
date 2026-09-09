/** Read the exact four choice markers from our rendered quiz, never from prose. */
export function renderedQuizEmojis(content: string): string[] {
  if (!/^\*\*[^\n]*みんなの(?:予測|投票|クイズ)\*\*/u.test(content)) return [];
  const lines = content.split("\n");
  const questionEnd = lines.indexOf("", 3);
  const choices = lines.slice(questionEnd + 1, questionEnd + 5);
  if (questionEnd < 0 || choices.length !== 4) return [];
  const emojis = choices.map(line => line.split(" ")[0] ?? "");
  return emojis.every(Boolean) && new Set(emojis).size === 4 ? emojis : [];
}

export async function seedQuizReactions(content: string, message: { id: string; channel_id: string }, token: string): Promise<void> {
  for (const emoji of renderedQuizEmojis(content)) {
    const response = await fetch(`https://discord.com/api/v10/channels/${message.channel_id}/messages/${message.id}/reactions/${encodeURIComponent(emoji)}/@me`, {
      method: "PUT", headers: { authorization: `Bot ${token}` }, signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Quiz reaction returned ${response.status}`);
  }
}
