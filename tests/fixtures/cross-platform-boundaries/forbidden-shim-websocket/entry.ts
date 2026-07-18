// S6+S7 negative fixture: WebSocket stays forbidden EVEN in a shim-bearing
// graph. Android is REST-only — the pa_-keyed Socket.IO the Windows agent opens
// is a hard rail the Android port never crosses (plan §1 #1, S1 §2.B note).
// `fetch` was relaxed for shim graphs, but EventSource / WebSocket /
// XMLHttpRequest / navigator.sendBeacon never are. assumeShimGraph forces the
// renderer-behind-shim mode so this asserts the socket escape is still rejected
// in that mode (the FORBIDDEN_NETWORK_API diagnostic is NOT shimAllowable for
// these names).
export function openSocket(): unknown {
  return new WebSocket('wss://example.invalid');
}
