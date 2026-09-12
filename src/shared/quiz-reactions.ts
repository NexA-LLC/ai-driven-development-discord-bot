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

export async function seedQuizReactions(content: string, message: { id: string; channel_id: string }, token: string, wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))): Promise<void> {
  const emojis = renderedQuizEmojis(content);
  if (!emojis.length) return;
  const failed: string[] = [];
  for (const emoji of emojis) {
    let succeeded = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      let delay = 1000 * 2 ** attempt;
      try {
        const response = await fetch(`https://discord.com/api/v10/channels/${message.channel_id}/messages/${message.id}/reactions/${encodeURIComponent(emoji)}/@me`, {
          method: "PUT", headers: { authorization: `Bot ${token}` }, signal: AbortSignal.timeout(15000),
        });
        if (response.ok) { succeeded = true; break; }
        if (response.status !== 429 && response.status < 500) break;
        if (response.status === 429) {
          const body = await response.json() as { retry_after?: number };
          const seconds = Number(body.retry_after ?? response.headers.get("retry-after"));
          if (Number.isFinite(seconds) && seconds > 0) delay = Math.ceil(seconds * 1000) + 100;
          // Do not retry earlier than Discord permits or hold a worker indefinitely.
          if (delay > 60000) break;
        }
      } catch { /* Retry network failures and timeouts on the same idempotent PUT. */ }
      if (attempt < 3) await wait(delay);
    }
    if (!succeeded) failed.push(emoji);
  }
  if (failed.length) throw new Error(`Quiz reactions incomplete message=${message.id} missing=${failed.join(",")}`);
}
