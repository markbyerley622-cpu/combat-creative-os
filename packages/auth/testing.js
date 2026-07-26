// Subpath shim for `@combat/auth/testing`.
//
// The workspace compiles to CommonJS under `moduleResolution: "Node"` (node10),
// which ignores `package.json` "exports" maps — so a real file has to sit at the
// subpath. This is hand-written source, not a build artifact: it forwards to the
// compiled `dist/testing`, keeping the deterministic identity fakes off the
// package's root import path (see src/testing.ts's doc comment).
module.exports = require('./dist/testing');
