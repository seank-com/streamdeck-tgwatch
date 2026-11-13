// Bundles src/plugin.ts (plus GramJS) into a single ESM file Stream Deck can run.
import { build, context } from "esbuild";
import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";

const sdPlugin = "com.seank.telegram-watch.sdPlugin";
const watch = process.argv.includes("--watch");

const options = {
	entryPoints: ["src/plugin.ts"],
	outfile: `${sdPlugin}/bin/plugin.js`,
	bundle: true,
	platform: "node",
	target: "node20",
	format: "esm",
	sourcemap: watch ? "inline" : false,
	// GramJS is CommonJS; give the ESM bundle a real `require` for Node built-ins.
	banner: {
		js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);',
	},
	logLevel: "info",
	plugins: [
		{
			name: "restart-streamdeck",
			setup(b) {
				b.onEnd((r) => {
					if (watch && r.errors.length === 0) {
						try {
							execSync("streamdeck restart com.seank.telegram-watch", { stdio: "inherit" });
						} catch {
							/* Stream Deck not running / CLI missing — ignore */
						}
					}
				});
			},
		},
	],
};

mkdirSync(`${sdPlugin}/bin`, { recursive: true });
writeFileSync(`${sdPlugin}/bin/package.json`, '{ "type": "module" }\n');

if (watch) {
	const ctx = await context(options);
	await ctx.watch();
} else {
	await build(options);
}
