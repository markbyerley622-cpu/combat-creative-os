// Subpath shim for `@combat/providers/testing`.
//
// The workspace compiles to CommonJS under `moduleResolution: "Node"` (node10),
// which ignores `package.json` "exports" maps — so a real file has to sit at the
// subpath. This is hand-written source, not a build artifact: it forwards to the
// compiled `dist/testing`, keeping the deterministic fake provider API off the
// package's root import path (see src/testing.ts's doc comment). Same shape,
// same reason, as `@combat/auth/testing`.
module.exports = require('./dist/testing');
