const process = { label: 'synthetic' };
const Buffer = { label: 'synthetic' };
const module = { require: (value: string) => value };
const require = { resolve: (value: string) => value };
const electronAPI = { label: 'synthetic' };

export function readSyntheticGlobals(): string[] {
  return [
    process.label,
    Buffer.label,
    module.require('module'),
    require.resolve('module'),
    electronAPI.label,
  ];
}
