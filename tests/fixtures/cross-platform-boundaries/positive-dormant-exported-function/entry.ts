export function startOnlyWhenRequested(): void {
  setInterval(() => undefined, 1_000);
}

export const status = 'idle';
