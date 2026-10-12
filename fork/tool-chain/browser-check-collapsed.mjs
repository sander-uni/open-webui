// Collapsed tool chains (Open WebUI's default) and bounded growth while scrolled away.
// Run like browser-check.mjs: node fork/tool-chain/browser-check-collapsed.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const port = '5193';
const server = spawn('python3', ['fork/tool-chain/backend_fixture.py', '--port', port], {
	stdio: ['ignore', 'pipe', 'pipe']
});
let browser;
const errors = [];
try {
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			if ((await fetch(`http://127.0.0.1:${port}`)).ok) break;
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	browser = await chromium.launch({
		...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
		headless: true,
		args: process.env.CHROMIUM_EXECUTABLE
			? [
					'--no-sandbox',
					'--no-zygote',
					'--single-process',
					'--disable-dev-shm-usage',
					'--disable-gpu'
				]
			: []
	});
	const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
	page.on('pageerror', (error) => errors.push(error.message));
	await page.goto(`http://127.0.0.1:${port}/?collapsed`);
	const toggle = page.getByRole('button', { name: 'Toggle details' }).first();
	await toggle.waitFor();

	// The collapsed header describes the whole chain, not just the recent page.
	assert.match(await toggle.innerText(), /2000 run_command/);
	assert.equal(await page.locator('.tool-chain-window').count(), 0, 'Pager shown while collapsed');

	// Scrolling up past a collapsed chain must not load pages.
	const root = page.locator('#messages-container');
	await root.evaluate((element) => (element.scrollTop = element.scrollHeight));
	await page.mouse.move(800, 400);
	for (let i = 0; i < 5; i++) await page.mouse.wheel(0, -400);
	await page.waitForTimeout(300);
	await toggle.click();
	const pager = page.locator('.tool-chain-window');
	await pager.waitFor();
	const hidden = () => pager.getAttribute('data-hidden-steps').then(Number);
	const total = () => pager.getAttribute('data-total-steps').then(Number);
	// One page (50 steps), plus the reasoning of a call cut at the page edge.
	const base = (await total()) - (await hidden());
	assert(base <= 51, `Collapsed scrolling loaded pages (${base} visible)`);
	assert.match(await toggle.innerText(), /2000 run_command/);

	// While reading above the bottom, new rounds are kept for at most one extra page.
	await root.evaluate((element) => (element.scrollTop = element.scrollHeight));
	await page.waitForTimeout(100);
	await root.evaluate(
		(element) => (element.scrollTop = element.scrollHeight - element.clientHeight - 600)
	);
	await page.waitForTimeout(100);
	for (let i = 0; i < 40; i++)
		await page.getByRole('button', { name: 'Append tool round' }).click();
	assert.equal(
		(await total()) - (await hidden()),
		base + 50,
		'Growth while scrolled away was not capped'
	);
	// The fixture's new rounds follow a text message, so they form their own group.
	assert.match(
		await page.getByRole('button', { name: 'Toggle details' }).last().innerText(),
		/new_round/
	);

	// Back at the bottom the window returns to one page, which now holds only the new
	// rounds. They form a new group, collapsed by default, so the pager is hidden again
	// while its header still counts every round, including those paged out.
	await root.evaluate((element) => (element.scrollTop = element.scrollHeight));
	await pager.waitFor({ state: 'detached' });
	const newGroup = page.getByRole('button', { name: 'Toggle details' }).first();
	assert.match(await newGroup.innerText(), /40 new_round/);
	await newGroup.click();
	await pager.waitFor();
	assert((await total()) - (await hidden()) <= 51, 'Window did not return to one page');
	await newGroup.click();
	await pager.waitFor({ state: 'detached' });
	assert.match(await newGroup.innerText(), /40 new_round/);
	assert.deepEqual(errors, [], `Browser runtime errors: ${errors.join('; ')}`);
	console.log(
		'COLLAPSED CHECK: PASS — full-chain header counts, no pager or loading while collapsed, capped growth while scrolled away, reset at bottom'
	);
} finally {
	await browser?.close();
	server.kill('SIGTERM');
	await once(server, 'exit').catch(() => {});
}
