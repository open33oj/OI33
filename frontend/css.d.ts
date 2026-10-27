// esbuild bundles these as side-effect imports into entry.js; TypeScript needs
// the module shape declared to accept them.
declare module '*.css';
