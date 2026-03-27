import { readFileSync } from "node:fs";
import { build } from "esbuild";

const rootPkg = JSON.parse(readFileSync("../../package.json", "utf-8"));

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: "dist/sideways.cjs",
  define: {
    "process.env.SIDEWAYS_VERSION": JSON.stringify(rootPkg.version),
  },
});
