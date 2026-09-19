import { type ConnpassFeed, eventReference } from "./connpass-feed.js";
import { experienceReference, type ExperienceMemory, type ExperienceStore } from "./experience-memory.js";

/** Used by the live Gateway; delivery receipts, not generation, advance state. */
export async function deliverMusing(options: {
  background: string;
  memories: ExperienceMemory[];
  store: ExperienceStore;
  feed?: ConnpassFeed;
  generate: (material: string) => Promise<string>;
  send: (text: string) => Promise<{ id: string }>;
  now?: number;
}): Promise<{ id: string; text: string }> {
  const now = options.now ?? Date.now();
  const event = options.feed?.select(now);
  // Only finite, non-identifying interests can connect a conversation to a public event.
  const interest = options.memories.some(m => /用語|呼び方|説明/.test(m.quote)) ? "言葉を分かりやすく説明すること" : "AIで開発するときの工夫";
  // Public event introductions never receive raw private conversation/identity data.
  const material = event
    ? `公開イベントの情報から、${interest}への興味と関連する点があれば、一つだけ自然に話す。参加したとは言わない。\n${eventReference([event])}`
    : `${options.background}\n${experienceReference(options.memories)}\n根拠がない体験や誰かとの会話を作らない。材料がなければ想像または問いとして話す。根拠の引用や人名/IDは独り言に転載せず、自分の気づきとして一般化する。`;
  const generated = await options.generate(material);
  if (!generated.trim()) throw new Error("Empty musing");
  const text = event ? `${generated.replace(/https?:\/\/\S+/g, "").trim().slice(0, 400)}\n${event.url}` : generated.slice(0, 400);
  if (event && !options.feed!.reserve(event.url, now)) throw new Error("Event already reserved");
  if (!event && options.memories.length) options.store.holdMusing(options.memories.map(m => m.id), now + 7 * 86400_000);
  try {
    const sent = await options.send(text);
    if (event) options.feed!.delivered(event.url, sent.id, now);
    else if (options.memories.length) options.store.markMused(options.memories.map(m => m.id), now);
    return { id: sent.id, text };
  } catch (error) {
    const status = (error as { status?: number }).status;
    const rejected = !!status && status >= 400 && status < 500 && status !== 408;
    if (event) options.feed!.failed(event.url, rejected);
    else if (rejected && options.memories.length) options.store.holdMusing(options.memories.map(m => m.id), 0);
    throw error;
  }
}
