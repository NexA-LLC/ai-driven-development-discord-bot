export interface AddressInput {
  mentioned: boolean;
  repliedToSu: boolean;
  hasAudio: boolean;
  inMusings: boolean;
}

export interface ChannelInput {
  inMonitoredChannel: boolean;
  allowMentionsAnywhere: boolean;
  inMusings: boolean;
  inWelcome: boolean;
}

/** @スー, a Discord reply to スー, or audio dropped in her musings channel. */
export function isAddressedToSu(input: AddressInput): boolean {
  return input.mentioned || input.repliedToSu || (input.hasAudio && input.inMusings);
}

/** Mentions/replies are allowed in monitored, musings, and welcome channels. */
export function isConversationChannel(input: ChannelInput): boolean {
  return input.inMonitoredChannel || input.allowMentionsAnywhere || input.inMusings || input.inWelcome;
}

export function shouldAnswerMessage(input: AddressInput & ChannelInput): boolean {
  return isAddressedToSu(input) && isConversationChannel(input);
}

export function stripBotMention(content: string, botId: string): string {
  return content.replace(new RegExp(`<@!?${botId}>`, "g"), "").trim();
}

/** Keep the clerk's previous line so a reply like "温めて" still has "温めますか？". */
export function buildAddressedPrompt(userText: string, referencedSuContent?: string): string {
  const text = userText.trim() || "この店で何ができますか？";
  const quoted = referencedSuContent?.trim();
  if (!quoted) return text;
  return `スーの直前の発言:\n${quoted.slice(0, 500)}\n\nお客さんの返事:\n${text}`;
}
