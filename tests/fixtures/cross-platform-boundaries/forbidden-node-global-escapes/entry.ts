export function loadOnlyWhenRequested(): unknown[] {
  const requiredModule = module.require('fs');
  const resolvedModule = require.resolve('fs');
  const callableBuffer = Buffer('order');
  return [requiredModule, resolvedModule, callableBuffer];
}
