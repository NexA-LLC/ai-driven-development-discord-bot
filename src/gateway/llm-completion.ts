import { LlmRequestError } from "./llm-reliability.js";

export interface LlmCompletionBody {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
}

/** Require user-visible final text, not merely an HTTP 200 or hidden reasoning. */
export function completionText(body: LlmCompletionBody): string {
  const choice = body.choices?.[0];
  const text = (choice?.message?.content ?? "")
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/<\/?think>/g, "")
    .trim();
  if (text.length > 0) return text;
  throw new LlmRequestError(
    choice?.finish_reason === "length"
      ? "LLM spent the whole token budget on reasoning and returned no text"
      : "LLM API returned no final text",
    { code: "empty_response", retryable: true },
  );
}
