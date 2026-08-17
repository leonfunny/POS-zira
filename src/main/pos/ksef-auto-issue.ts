/**
 * KSeF auto-issue hand-off (>450 zl NIP flow).
 *
 * Orders are created offline-first, so the e-invoice can only be issued once
 * the order reaches the backend. The sync layer calls trigger() right after
 * it stamps backend_id; pos.module registers the actual implementation
 * (config check -> POST issue-ksef-invoice). This tiny registry exists so
 * sync-log-service never has to import pos.module (no dependency cycle).
 *
 * Everything is best-effort: a failed issue never breaks sync — the History
 * tab "Wystaw fakturę KSeF" button remains the manual fallback.
 */

type KsefAutoIssueHandler = (localOrderId: string) => Promise<void>;

let handler: KsefAutoIssueHandler | null = null;

export function registerKsefAutoIssueHandler(fn: KsefAutoIssueHandler): void {
  handler = fn;
}

export function triggerKsefAutoIssue(localOrderId: string): void {
  if (!handler) return;
  void handler(localOrderId).catch(() => {
    // logged inside the handler; never let this surface into sync
  });
}
