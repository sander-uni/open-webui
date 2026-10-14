import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const servers = [
	spawn(
		'python3',
		['fork/filesystem-sort/backend_fixture.py', '--port', '5197', '--missing-metadata'],
		{ stdio: ['ignore', 'pipe', 'pipe'] }
	),
	spawn('python3', ['fork/tool-chain/backend_fixture.py', '--port', '5198'], {
		stdio: ['ignore', 'pipe', 'pipe']
	})
];
let browser;
try {
	for (const port of [5197, 5198]) {
		let ready = false;
		for (let n = 0; n < 100; n++) {
			try {
				ready = (await fetch(`http://127.0.0.1:${port}`)).ok;
			} catch {}
			if (ready) break;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		assert(ready, `Fixture ${port} unavailable`);
	}
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
	page.on('pageerror', (e) => errors.push(e.message));
	await page.goto('http://127.0.0.1:5197/?review');
	await page.waitForFunction(() => document.querySelectorAll('[data-file-row]').length === 4);
	assert.deepEqual(
		(await page.locator('[data-file-row] span.truncate').allTextContents()).map((s) => s.trim()),
		['folder', 'newest.txt', 'oldest.txt', 'middle.txt']
	);
	await page.getByRole('button', { name: 'Custom Settings', exact: true }).click();
	await page.getByRole('button', { name: 'Filesystem', exact: true }).click();
	await page.getByRole('button', { name: 'Other admin: 100 steps', exact: true }).click();
	await page.getByRole('button', { name: 'Other admin saved 100 steps', exact: true }).waitFor();
	await page.getByRole('combobox', { name: 'Filesystem sort default' }).selectOption('name_asc');
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await page.getByRole('status').waitFor();
	await page.getByRole('button', { name: 'Tool-chain display', exact: true }).click();
	assert.equal(await page.getByRole('spinbutton', { name: 'Steps per page' }).inputValue(), '100');
	await page.getByRole('switch', { name: 'Paginate tool chains', exact: true }).click();
	assert.equal(await page.getByRole('status').count(), 0, 'Saved status remained after a toggle');
	await page.getByRole('switch', { name: 'Paginate tool chains', exact: true }).click();
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await page.getByRole('status').waitFor();
	await page.getByRole('spinbutton', { name: 'Steps per page' }).fill('150');
	assert.equal(
		await page.getByRole('status').count(),
		0,
		'Saved status remained visible after editing'
	);
	// Invalid page size in an inactive tab must not be silently defaulted on save.
	await page.getByRole('spinbutton', { name: 'Steps per page' }).fill('');
	await page.getByRole('button', { name: 'Filesystem', exact: true }).click();
	await page.getByRole('combobox', { name: 'Filesystem sort default' }).selectOption('date_desc');
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	const value = await page.request.get('http://127.0.0.1:5197/api/v1/custom-settings', {
		headers: { Authorization: 'Bearer fixture-admin' }
	});
	const stored = await value.json();
	assert.equal(stored.tool_chain_display.page_size, 100);
	assert.equal(stored.filesystem_sort_default, 'name_asc');
	await page.goto('http://127.0.0.1:5198/?collapsed&collision');
	await page.getByText('Collision test message', { exact: true }).waitFor();
	await mkdir('demos/browser-check', { recursive: true });
	await page.screenshot({ path: 'demos/browser-check/collision-before.png' });
	await page.getByRole('button', { name: 'Toggle details', exact: true }).first().click();
	const pager = page.locator('.tool-chain-window');
	await pager.waitFor();
	const initial = Number(await pager.getAttribute('data-hidden-steps'));
	await page.screenshot({ path: 'demos/browser-check/collision-after.png' });
	await page.getByRole('button', { name: /^Load [\d,]+ earlier steps$/ }).click();
	assert(Number(await pager.getAttribute('data-hidden-steps')) < initial);
	await page.screenshot({ path: 'demos/browser-check/collision-paged.png' });
	assert.equal(await page.getByText('Collision test message', { exact: true }).count(), 1);
	assert.deepEqual(errors, []);
	console.log(
		'REVIEW BROWSER: PASS — missing timestamps, concurrent category writes, dirty save status, invalid inactive inputs, colliding rendering ids, working paging, no runtime errors'
	);
} finally {
	await browser?.close();
	for (const server of servers) {
		server.kill('SIGTERM');
		await once(server, 'exit').catch(() => {});
	}
}
