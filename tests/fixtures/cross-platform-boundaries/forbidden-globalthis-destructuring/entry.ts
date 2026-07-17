const { process, electronAPI } = globalThis as any;

export const escapedGlobals = [process, electronAPI];
