// S5 GOAL A positive fixture: a shim-bearing graph may import static assets.
// The real consumer is src/renderer/android-pos (the renderer's Tailwind
// stylesheet + sql.js's wasm). These imports are Vite-resolved at build time,
// not TypeScript-resolved, so they surface as UNRESOLVED_* / bare-package
// diagnostics that are shimAllowable and dropped when the graph is a renderer
// behind the shim (here forced via the assumeShimGraph verifier option, since
// fixtures cannot sit on the src/renderer/android-pos/shim path that
// production detection keys on).
import './style.css';
// `?url` is a Vite-only asset idiom with no TS type declaration in this
// fixture context; the boundary verifier parses the source directly (no type
// check), and Vite resolves it at build time in the real android graph.
// @ts-ignore — vite ?url asset import (no type declaration in fixtures)
import sqlWasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import initSqlJs from 'sql.js';

export const locateWasm: string = sqlWasmUrl;
export const sqlFactory: unknown = initSqlJs;
