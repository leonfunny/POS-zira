export function dormantNetworkEscapes() {
  fetch('/catalog');
  new XMLHttpRequest();
  new WebSocket('wss://example.invalid');
  new EventSource('/events');
  navigator.sendBeacon('/audit');
}
