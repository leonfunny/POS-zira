export const runtimeName = globalThis.process.env.RUNTIME_NAME;
export const encodedOrder = globalThis['Buffer'].from('order').toString('base64');
