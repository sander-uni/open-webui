import { readdir, readFile, writeFile } from 'node:fs/promises';

async function files(directory) {
	const entries = await readdir(directory, { withFileTypes: true });
	const result = [];
	for (const entry of entries) {
		const path = `${directory}/${entry.name}`;
		result.push(...(entry.isDirectory() ? await files(path) : [path]));
	}
	return result.sort();
}

const directory = new URL('./', import.meta.url).pathname;
const path = `${directory}demos/requirements.json`;
const catalog = JSON.parse(await readFile(path, 'utf8'));
catalog.artifacts = [
	'src/lib/components/chat/FileNav.svelte',
	'src/lib/components/admin/Settings/CustomSettings.svelte',
	'src/lib/components/admin/Settings/CustomSettings/Filesystem.svelte',
	'src/lib/utils/custom-settings.ts',
	'src/lib/apis/custom-settings/index.ts',
	'src/lib/i18n/locales/en-US/translation.json',
	'backend/open_webui/routers/custom_settings.py',
	'backend/open_webui/models/config.py',
	'fork/tool-chain/backend_fixture.py',
	...(await files(`${directory}dist`)).map((path) => 'fork/filesystem-sort/' + path.slice(directory.length))
];
await writeFile(path, `${JSON.stringify(catalog, null, 2)}\n`);
console.log(`Prepared ${catalog.artifacts.length} source and runtime artifacts.`);
