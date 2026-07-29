/**
 * Module hooks that let a test import the extension's TypeScript sources the way
 * the bundler sees them. Node strips the type annotations itself; two other
 * things get in the way, and neither is worth reshaping shipped code for:
 *
 *  - the sources use extensionless relative specifiers (`./types`), which Vite
 *    resolves and Node's ESM resolver does not;
 *  - `gtfs-realtime-bindings` is CommonJS whose exports Node cannot detect
 *    statically, so `import { transit_realtime }` fails at load time even though
 *    the property is right there at runtime.
 *
 * So: append `.ts` to extensionless relative specifiers, and answer the bindings
 * specifier with a generated module that re-exports the CommonJS namespace. This
 * only gets the code loaded — it does not change what the code under test does.
 */

/** Anything already carrying a module extension is left alone. */
const HAS_EXTENSION = /\.([cm]?[jt]s|json|node|html|css)$/;

/** Stands in for the CommonJS bindings package under a scheme we own. */
const BINDINGS_URL = "grt-test:gtfs-realtime-bindings";

const HOOKS_URL = import.meta.url;

export function resolve(specifier, context, next) {
  if (specifier === "gtfs-realtime-bindings") {
    return { url: BINDINGS_URL, format: "module", shortCircuit: true };
  }
  if (specifier.startsWith(".") && !HAS_EXTENSION.test(specifier)) {
    return next(`${specifier}.ts`, context);
  }
  return next(specifier, context);
}

export function load(url, context, next) {
  if (url === BINDINGS_URL) {
    // Resolved relative to this file, so it finds the same copy of the package
    // the extension bundles rather than anything hoisted elsewhere.
    return {
      format: "module",
      shortCircuit: true,
      source: [
        `import { createRequire } from "node:module";`,
        `const require = createRequire(${JSON.stringify(HOOKS_URL)});`,
        `export const { transit_realtime } = require("gtfs-realtime-bindings");`,
      ].join("\n"),
    };
  }
  return next(url, context);
}
