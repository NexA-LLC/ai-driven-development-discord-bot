/** Refresh Discord's short-lived typing indicator without blocking the reply. */
export function startTyping(channel: { sendTyping(): Promise<unknown> }): () => void {
  let stopped = false;
  let pending = false;
  const refresh = async (): Promise<void> => {
    if (stopped || pending) return;
    pending = true;
    try { await channel.sendTyping(); }
    catch { /* Missing permissions or transient failures must not block replies. */ }
    finally { pending = false; }
  };
  void refresh();
  const timer = setInterval(() => { void refresh(); }, 7000);
  timer.unref();
  return () => { stopped = true; clearInterval(timer); };
}
