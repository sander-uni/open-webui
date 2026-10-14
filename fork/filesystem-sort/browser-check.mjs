import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const port = '5196';
const url = `http://127.0.0.1:${port}`;
const server = spawn(
	'python3',
	[
		'fork/filesystem-sort/backend_fixture.py',
		'--port',
		port,
		'--sort',
		process.env.FILESYSTEM_FIXTURE_INITIAL_SORT || 'date_desc'
	],
	{
		stdio: ['ignore', 'pipe', 'pipe']
	}
);
let browser;
let serverLog = '';
server.stderr.on('data', (chunk) => {
	serverLog += chunk;
});
try {
	let ready = false;
	for (let i = 0; i < 100; i++) {
		try {
			ready = (await fetch(url)).ok;
		} catch {}
		if (ready || server.exitCode !== null) break;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	assert(ready, `Fixture server did not start: ${serverLog}`);
	browser = await chromium.launch({
		executablePath: process.env.CHROMIUM_EXECUTABLE,
		headless: true,
		args: [
			'--no-sandbox',
			'--no-zygote',
			'--single-process',
			'--disable-dev-shm-usage',
			'--disable-gpu',
			'--disable-software-rasterizer',
			'--disable-vulkan'
		]
	});
	const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
	const errors = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await page.goto(url);
	const rows = page.locator('[data-file-row] span.truncate');
	const names = () => rows.allTextContents().then((values) => values.map((value) => value.trim()));
	const expectOrder = async (expected) => {
		await page.waitForFunction(
			(expected) =>
				[...document.querySelectorAll('[data-file-row] span.truncate')]
					.map((el) => el.textContent.trim())
					.join('|') === expected.join('|'),
			expected,
			{ timeout: 5000 }
		);
		assert.deepEqual(await names(), expected);
	};
	const dateDesc = ['folder', 'newest.txt', 'middle.txt', 'oldest.txt'];
	const nameAsc = ['folder', 'middle.txt', 'newest.txt', 'oldest.txt'];
	await expectOrder(dateDesc);
	await mkdir('fork/filesystem-sort/demos/browser-check', { recursive: true });
	await page.screenshot({ path: 'fork/filesystem-sort/demos/browser-check/initial.png' });

	const panel = page.getByRole('complementary', { name: 'Admin Custom Settings' });
	const select = panel.getByRole('combobox', { name: 'Filesystem sort default' });
	async function openSettings() {
		await page.getByRole('button', { name: 'Custom Settings', exact: true }).click();
		await panel.getByRole('button', { name: 'Filesystem', exact: true }).click();
		await select.waitFor();
	}
	async function save(value) {
		await select.selectOption(value);
		await panel.getByRole('button', { name: 'Save', exact: true }).click();
		await panel.getByRole('status').waitFor();
		await page.waitForFunction(
			(value) => document.querySelector('#filesystem-sort-default')?.value === value,
			value
		);
	}
	await openSettings();
	assert.equal(await select.inputValue(), 'date_desc');
	await page.screenshot({ path: 'fork/filesystem-sort/demos/browser-check/settings.png' });
	await save('name_asc');
	await expectOrder(nameAsc);
	await page.getByRole('button', { name: 'Reopen filesystem' }).click();
	await expectOrder(nameAsc);
	await page.reload();
	await expectOrder(nameAsc);
	await openSettings();
	assert.equal(await select.inputValue(), 'name_asc');
	await page.screenshot({ path: 'fork/filesystem-sort/demos/browser-check/persisted.png' });

	// Every supported choice uses the actual filesystem's existing comparator.
	for (const [value, order] of [
		['date_asc', ['folder', 'oldest.txt', 'middle.txt', 'newest.txt']],
		['name_desc', ['folder', 'oldest.txt', 'newest.txt', 'middle.txt']],
		['size_desc', ['folder', 'oldest.txt', 'middle.txt', 'newest.txt']],
		['size_asc', dateDesc],
		['date_desc', dateDesc],
		['name_asc', nameAsc]
	]) {
		await save(value);
		await expectOrder(order);
	}
	// A manual choice stays local to this open panel and survives unrelated config updates.
	await page.getByLabel('Sort', { exact: true }).click();
	await page.getByRole('button', { name: 'Date Modified', exact: true }).click();
	await expectOrder(['folder', 'oldest.txt', 'middle.txt', 'newest.txt']);
	await page.getByRole('button', { name: 'Update other config' }).click();
	await expectOrder(['folder', 'oldest.txt', 'middle.txt', 'newest.txt']);
	const stored = await page.request.get(`${url}/api/v1/custom-settings`, {
		headers: { Authorization: 'Bearer fixture-admin' }
	});
	assert.equal((await stored.json()).filesystem_sort_default, 'name_asc');
	await page.getByRole('button', { name: 'Reopen filesystem' }).click();
	await expectOrder(nameAsc);
	await save('date_desc');
	await expectOrder(dateDesc);
	await page.reload();
	await expectOrder(dateDesc);
	assert.deepEqual(errors, [], `Browser errors: ${errors.join('; ')}`);
	console.log(
		'BROWSER CHECK: PASS — newest-first default, existing admin category, all six sort choices, persisted reload/remount, live defaults, folders first, temporary manual override, unrelated config update, no runtime errors'
	);
} finally {
	await browser?.close();
	server.kill('SIGTERM');
	await once(server, 'exit').catch(() => {});
}
