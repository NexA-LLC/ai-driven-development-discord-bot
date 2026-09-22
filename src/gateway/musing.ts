import { experienceReference, type ExperienceMemory, type ExperienceStore } from "./experience-memory.js";

/** Used by the live Gateway; delivery receipts, not generation, advance state. */
export async function deliverMusing(options: {
  background: string;
  memories: ExperienceMemory[];
  store: ExperienceStore;
  generate: (material: string) => Promise<string>;
  send: (text: string) => Promise<{ id: string }>;
  now?: number;
}): Promise<{ id: string; text: string }> {
  const now = options.now ?? Date.now();
  const material = `${options.background}\n${experienceReference(options.memories)}\n根拠がない体験や誰かとの会話を作らない。材料がなければ想像または問いとして話す。根拠の引用や人名/IDは独り言に転載せず、自分の気づきとして一般化する。`;
  const generated = await options.generate(material);
  if (!generated.trim()) throw new Error("Empty musing");
  const text = generated.slice(0, 400);
  if (options.memories.length) options.store.holdMusing(options.memories.map(m => m.id), now + 7 * 86400_000);
  try {
    const sent = await options.send(text);
    if (options.memories.length) options.store.markMused(options.memories.map(m => m.id), now);
    return { id: sent.id, text };
  } catch (error) {
    const status = (error as { status?: number }).status;
    const rejected = !!status && status >= 400 && status < 500 && status !== 408;
    if (rejected && options.memories.length) options.store.holdMusing(options.memories.map(m => m.id), 0);
    throw error;
  }
}
