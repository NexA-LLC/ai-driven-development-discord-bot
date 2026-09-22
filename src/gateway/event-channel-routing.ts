import type { EventEntry } from "./connpass-feed.js";

export const EVENT_BRANCH_DEFINITIONS = [
  { keywords: ["遠州", "ensyu"], channelName: "遠州支部-ensyu" },
  { keywords: ["大阪", "osaka"], channelName: "大阪支部-osaka" },
  { keywords: ["神戸", "kobe"], channelName: "神戸支部-kobe" },
  { keywords: ["名古屋", "nagoya"], channelName: "名古屋支部-nagoya" },
  { keywords: ["広島", "hiroshima"], channelName: "広島支部-hiroshima" },
  { keywords: ["福岡", "fukuoka"], channelName: "福岡支部-fukuoka" },
  { keywords: ["沖縄", "okinawa"], channelName: "沖縄支部-okinawa" },
] as const;

export interface EventBranchChannel {
  keywords: readonly string[];
  channelId: string;
}

export function matchEventBranchChannel(event: EventEntry, branches: readonly EventBranchChannel[]): string | undefined {
  const fields = [event.title, event.groupTitle ?? "", event.place ?? "", event.address ?? ""];
  for (const field of fields) {
    const value = field.toLowerCase();
    for (const branch of branches) {
      if (branch.keywords.some(keyword => value.includes(keyword.toLowerCase()))) return branch.channelId;
    }
  }
  return;
}
