import esbuild from "esbuild";
import * as fs from "node:fs";

const production = process.argv.includes("production");
const obsidianExternals = [
  "obsidian", "electron", "@codemirror/state", "@codemirror/view",
  "@lezer/common", "node:net", "node:fs", "node:os", "node:path",
];

const hasBridge = fs.existsSync("bridge/bridge.ts");

async function buildBridgeOnce() {
  await esbuild.build({
    entryPoints: ["bridge/bridge.ts"],
    bundle: true, format: "esm", platform: "node", target: "es2022",
    outfile: "bridge.mjs", sourcemap: false, minify: production, logLevel: "info",
  });
  return fs.readFileSync("bridge.mjs", "utf8");
}

const bridgeText = hasBridge ? await buildBridgeOnce() : "";

const plugin = {
  entryPoints: ["src/main.ts"],
  bundle: true, format: "cjs", platform: "node", target: "es2022",
  external: obsidianExternals,
  // `define` replaces the bare identifier __BRIDGE_SOURCE__ (see src/bridge-asset.ts).
  define: { __BRIDGE_SOURCE__: JSON.stringify(bridgeText) },
  outfile: "main.js",
  sourcemap: production ? false : "inline",
  minify: production, logLevel: "info",
};

if (production) {
  await esbuild.build(plugin);
} else {
  // Dev/watch: plugin only. Re-run `npm run build` (production) to refresh the
  // embedded bridge text after editing bridge/bridge.ts.
  const ctx = await esbuild.context(plugin);
  await ctx.watch();
}
