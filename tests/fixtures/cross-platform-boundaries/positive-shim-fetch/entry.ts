// S6+S7 positive fixture: a shim-bearing graph may call `fetch` — the shim's
// real transport (src/renderer/android-pos/shim/real-transport.ts) reaches the
// eNail backend over fetch behind the shim installer. `fetch` is the ONE network
// primitive a shim graph is allowed to use; the bare `fetch` identifier surfaces
// as a FORBIDDEN_NETWORK_API diagnostic that is shimAllowable and dropped when
// the graph is a renderer behind the shim (here forced via assumeShimGraph,
// since fixtures cannot sit on the src/renderer/android-pos/shim path that
// production detection keys on). The call lives inside a method, not at module
// load, so the top-level-effect rail is also unaffected.
//
// Mirrors how real-transport.ts actually calls the port PosApiClient, which
// routes every request through a fetch-with-timeout helper.
export async function pullCatalog(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  return response.json();
}
