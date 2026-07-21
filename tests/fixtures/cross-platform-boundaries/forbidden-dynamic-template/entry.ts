export async function loadPlatformModule() {
  return import(`node:${'fs'}`);
}
