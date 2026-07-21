// S5 GOAL A negative fixture: a NON-shim graph importing a static asset is
// still flagged. The asset-import allowance is gated on the graph being a
// renderer behind the shim; without the shim installer (and without the
// test-only assumeShimGraph flag), a `.css` import is an unresolved local
// import and must be reported. This pins the "everything else unchanged"
// guarantee of the S5 verifier extension.
import './style.css';

export const assetImported = true;
