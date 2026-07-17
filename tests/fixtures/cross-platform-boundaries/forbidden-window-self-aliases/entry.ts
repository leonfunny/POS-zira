const host = window;
const { Buffer } = self as any;

export const escapedGlobals = [host.electronAPI, Buffer];
