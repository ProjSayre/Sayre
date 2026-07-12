// Placeholder entrypoint so this package's TypeScript project has at least one
// compilable source file (required for `tsc --noEmit`/`tsc -p tsconfig.json`
// to succeed — an empty `include` match is a hard TypeScript error, TS18003).
//
// No application logic lives here. This ticket (W0-00) only pins dependency
// versions; the real service-layer implementation lands in a later ticket.
// The `dev` script (`tsx watch src/index.ts`) referenced in package.json
// targets this file only so it does not point at a nonexistent path.
export {};
