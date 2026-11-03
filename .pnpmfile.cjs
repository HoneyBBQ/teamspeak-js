// TypeDoc drives the TypeScript compiler API, which TypeScript 7 (the native
// compiler this repo builds with) does not expose. TypeDoc therefore gets its
// own TypeScript 6.0 instead of the peer it would find at the root. This only
// affects the docs build; nothing published depends on it.
function readPackage(pkg) {
  if (pkg.name === "typedoc") {
    delete pkg.peerDependencies?.typescript;
    pkg.dependencies = { ...pkg.dependencies, typescript: "npm:typescript@6.0.3" };
  }
  return pkg;
}

module.exports = { hooks: { readPackage } };
