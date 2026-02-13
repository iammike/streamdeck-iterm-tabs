import commonjs from "@rollup/plugin-commonjs";
import nodeResolve from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";
import terser from "@rollup/plugin-terser";
import path from "node:path";

const isWatch = !!process.env.ROLLUP_WATCH;

/**
 * @type {import("rollup").RollupOptions}
 */
const config = {
	input: "src/plugin.ts",
	output: {
		file: "com.iammikec.iterm-tabs.sdPlugin/bin/plugin.js",
		format: "es",
		sourcemap: isWatch,
	},
	plugins: [
		{
			name: "watch-externals",
			buildStart() {
				this.addWatchFile(
					path.resolve("com.iammikec.iterm-tabs.sdPlugin/manifest.json")
				);
			},
		},
		typescript({
			mapRoot: isWatch ? "./" : undefined,
		}),
		nodeResolve({
			browser: false,
			exportConditions: ["node"],
			preferBuiltins: true,
		}),
		commonjs(),
		!isWatch && terser(),
		{
			name: "emit-module-package-file",
			generateBundle() {
				this.emitFile({
					fileName: "package.json",
					source: '{"type":"module"}',
					type: "asset",
				});
			},
		},
	],
};

export default config;
