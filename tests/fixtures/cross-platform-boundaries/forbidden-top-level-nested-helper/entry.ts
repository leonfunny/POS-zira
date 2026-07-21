(() => {
  function startPolling() {
    setInterval(() => undefined, 1_000);
  }

  startPolling();
})();

export const status = 'scheduled';
