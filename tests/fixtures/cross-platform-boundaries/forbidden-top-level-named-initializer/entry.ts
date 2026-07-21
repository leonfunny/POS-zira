const startImmediately = function startPolling() {
  setInterval(() => undefined, 1_000);
};

startImmediately();

export const status = 'scheduled';
