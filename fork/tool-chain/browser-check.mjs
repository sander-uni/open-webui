import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const server = spawn('python3', ['fork/tool-chain/backend_fixture.py', '--port', '5192'], {
	stdio: ['ignore', 'pipe', 'pipe']
});
let browser;
const errors = [];
try {
	let ready = false;
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			ready = (await fetch('http://127.0.0.1:5192')).ok;
		} catch {}
		if (ready) break;
		if (server.exitCode !== null) throw new Error('Fixture server exited');
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	assert(ready, 'Fixture server did not start');
	browser = await chromium.launch({
		...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
		headless: true,
		args: process.env.CHROMIUM_EXECUTABLE
			? [
					'--no-sandbox',
					'--no-zygote',
					'--single-process',
					'--disable-dev-shm-usage',
					'--disable-gpu',
					'--disable-software-rasterizer',
					'--disable-vulkan'
				]
			: []
	});
	const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
	page.on('pageerror', (error) => errors.push(error.message));
	await page.goto('http://127.0.0.1:5192');
	const pager = page.locator('.tool-chain-window');
	await pager.waitFor();
	const hidden = () => pager.getAttribute('data-hidden-steps').then(Number);
	const retained = () => page.getByTestId('state').innerText();
	const initial = await hidden();
	assert(initial > 3900, `Expected a recent page, hidden=${initial}`);
	assert((await retained()).includes('Retained output items: 6001'));
	await mkdir('demos/browser-check', { recursive: true });
	await page.screenshot({ path: 'demos/browser-check/recent.png' });
	const oldCall = page.locator('#fixture-detail-0-1-tool-call');
	await oldCall.locator('[role="button"]').first().click();
	await page.getByText('command check-step-1976', { exact: true }).waitFor({ state: 'detached' });
	assert.equal(await page.getByText('command check-step-1976', { exact: true }).count(), 0);

	await page.getByRole('button', { name: 'Load earlier steps' }).click();
	assert((await hidden()) < initial);
	assert((await retained()).includes('Retained output items: 6001'));
	assert.equal(
		await page.getByText('command check-step-1976', { exact: true }).count(),
		0,
		'Paging lost a collapsed tool state'
	);
	const afterClick = await hidden();
	const root = page.locator('#messages-container');
	await root.evaluate((element) => {
		element.scrollTop = 250;
	});
	await page.mouse.move(800, 400);
	await page.mouse.wheel(0, -350);
	await page.waitForFunction(
		(previous) =>
			Number(document.querySelector('.tool-chain-window')?.getAttribute('data-hidden-steps')) <
			previous,
		afterClick
	);
	await page.screenshot({ path: 'demos/browser-check/earlier.png' });

	const loaded = await hidden();
	await page.getByRole('button', { name: 'Append tool round' }).click();
	assert((await hidden()) <= loaded, 'Appending a round discarded loaded history');
	await page.getByRole('button', { name: 'Stream 150 tokens' }).click();
	await page.waitForFunction(() =>
		document.querySelector('[data-testid="state"]')?.textContent?.includes('Streamed tokens: 150')
	);
	assert((await retained()).includes('Retained output items: 6004'));
	await page.getByRole('button', { name: 'Reload saved snapshot' }).click();
	await page.waitForFunction(() =>
		document
			.querySelector('[data-testid="state"]')
			?.textContent?.includes('Snapshot text preserved: true')
	);
	assert((await hidden()) > 3900, 'New snapshot should reset to a recent page');
	await page.screenshot({ path: 'demos/browser-check/snapshot.png' });

	await page.getByRole('button', { name: 'Pin oldest approval' }).click();
	await page.getByRole('button', { name: 'Allow', exact: true }).first().waitFor();
	assert((await hidden()) > 3900, 'Pinning one old approval exposed the whole history');
	await root.evaluate((element) => {
		element.scrollTop = 0;
	});
	await page.screenshot({ path: 'demos/browser-check/approval.png' });

	// Configure through the real admin panel and real router/SQLite fixture.
	const openSettings = () => page.getByRole('button', { name: 'Admin: Custom Settings' }).click();
	await openSettings();
	const panel = page.getByRole('complementary', { name: 'Admin Custom Settings' });
	const pageSize = panel.getByRole('spinbutton', { name: 'Steps per page' });
	await pageSize.waitFor();
	await pageSize.fill('20');
	await panel
		.getByRole('switch', { name: 'Load earlier steps automatically when scrolling up' })
		.click();
	await panel.getByRole('button', { name: 'Save', exact: true }).click();
	await panel.getByRole('status').waitFor();
	assert((await hidden()) >= 3970, 'Saved smaller page size did not apply to existing output');
	await page.screenshot({ path: 'demos/browser-check/custom-settings.png' });
	await panel.getByRole('button', { name: 'Close', exact: true }).click();
	const beforeDisabledScroll = await hidden();
	await root.evaluate((element) => {
		element.scrollTop = 250;
	});
	await page.mouse.move(800, 400);
	await page.mouse.wheel(0, -350);
	await page.waitForTimeout(350);
	assert.equal(await hidden(), beforeDisabledScroll, 'Auto-load still ran while disabled');
	await page.getByRole('button', { name: 'Load earlier steps' }).click();
	assert.equal(
		await hidden(),
		beforeDisabledScroll - 20,
		'Manual loading did not use the configured page size'
	);
	await openSettings();
	assert.equal(await pageSize.inputValue(), '20');
	assert.equal(
		await panel
			.getByRole('switch', { name: 'Load earlier steps automatically when scrolling up' })
			.getAttribute('aria-checked'),
		'false'
	);
	await page.reload();
	await pager.waitFor();
	await page.waitForFunction(
		() =>
			Number(document.querySelector('.tool-chain-window')?.getAttribute('data-hidden-steps')) >=
			3980
	);
	assert((await retained()).includes('Retained output items: 6001'));
	await openSettings();
	assert.equal(await pageSize.inputValue(), '20');
	await panel.getByRole('switch', { name: 'Paginate tool chains' }).click();
	await panel.getByRole('button', { name: 'Save', exact: true }).click();
	await pager.waitFor({ state: 'detached' });
	await page.getByText('command check-step-1', { exact: true }).waitFor();
	assert((await retained()).includes('Retained output items: 6001'));
	await panel.getByRole('switch', { name: 'Paginate tool chains' }).click();
	await panel.getByRole('button', { name: 'Save', exact: true }).click();
	await pager.waitFor();
	assert((await hidden()) >= 3980, 'Re-enabling pagination did not restore a bounded window');
	assert.deepEqual(errors, [], `Browser runtime errors: ${errors.join('; ')}`);
	console.log(
		'BROWSER CHECK: PASS — recent window, manual load, upward scroll, append while browsing, 150 tokens, snapshot reload, old approval, persisted admin settings, configurable page size, auto-load off, manual loading, pagination toggle, no runtime errors'
	);
} finally {
	await browser?.close();
	server.kill('SIGTERM');
	await once(server, 'exit').catch(() => {});
}
