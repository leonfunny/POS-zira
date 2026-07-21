export function readOnlyWhenRequested(): string | undefined {
  const runtime = globalThis as any;
  return runtime.process.env.RUNTIME_NAME;
}
