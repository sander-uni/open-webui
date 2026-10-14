import { defineConfig, mergeConfig } from 'vite';
import base from '../tool-chain/vite.config';
import { fileURLToPath } from 'node:url';

export default mergeConfig(
	base,
	defineConfig({
		root: fileURLToPath(new URL('./', import.meta.url)),
		css: { postcss: fileURLToPath(new URL('../../', import.meta.url)) },
		server: { port: 5194 }
	})
);
