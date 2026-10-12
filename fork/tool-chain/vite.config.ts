import { defineConfig } from 'vite';
import { svelte, vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';

const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
	root: path('./'),
	plugins: [svelte({ configFile: false, preprocess: vitePreprocess() })],
	resolve: {
		alias: {
			$lib: path('../../src/lib'),
			'$app/navigation': path('./navigation.ts'),
			'$app/environment': path('./environment.ts')
		},
		conditions: ['browser', 'onnxruntime-web-use-extern-wasm']
	},
	define: {
		APP_VERSION: JSON.stringify('0.12.0'),
		APP_BUILD_HASH: JSON.stringify('tool-chain-test'),
		APP_BUILD_CHANNEL: JSON.stringify('dev')
	},
	build: { outDir: 'dist', chunkSizeWarningLimit: 10000 },
	css: { postcss: { plugins: [] } },
	worker: { format: 'es' },
	server: { host: '127.0.0.1', port: 5189, fs: { allow: [path('../../')] } }
});
