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

const path = 'demos/requirements.json';
const catalog = JSON.parse(await readFile(path, 'utf8'));
catalog.artifacts = await files('fork/tool-chain/dist');
await writeFile(path, `${JSON.stringify(catalog, null, 2)}\n`);
console.log(`Prepared ${catalog.artifacts.length} runtime artifacts for recording.`);
