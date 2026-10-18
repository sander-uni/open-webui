// Collapsed tool chains (Open WebUI's default), generation while scrolled away, paging controls.
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
					'--disable-gpu',
					'--disable-software-rasterizer',
					'--disable-vulkan'
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

	// While reading above the bottom, new rounds are added and nothing is dropped.
	await root.evaluate((element) => (element.scrollTop = element.scrollHeight));
	await page.waitForTimeout(100);
	await root.evaluate(
		(element) => (element.scrollTop = element.scrollHeight - element.clientHeight - 600)
	);
	await page.waitForTimeout(100);
	const hiddenBeforeRounds = await hidden();
	for (let i = 0; i < 40; i++)
		await page.getByRole('button', { name: 'Append tool round' }).click();
	assert.equal(await hidden(), hiddenBeforeRounds, 'Steps were dropped while scrolled away');
	assert.equal((await total()) - (await hidden()), base + 80, 'New rounds were not all added');
	// The fixture's new rounds follow a text message, so they form their own group.
	assert.match(
		await page.getByRole('button', { name: 'Toggle details' }).last().innerText(),
		/new_round/
	);

	// Back at the bottom the window returns to one page, which now holds only the new
	// rounds (behind the fixture's text message). The hidden steps now span more than one
	// group, so the paging line moves above the reply and states the true totals.
	await root.evaluate((element) => (element.scrollTop = element.scrollHeight));
	await page.waitForFunction(() => {
		const el = document.querySelector('.tool-chain-window');
		return Number(el?.dataset.totalSteps) - Number(el?.dataset.hiddenSteps) <= 51;
	});
	const newGroup = page.getByRole('button', { name: 'Toggle details' }).first();
	assert.match(await newGroup.innerText(), /new_round/);
	assert.match(
		await page.locator('.tool-chain-hidden-summary').innerText(),
		/^Hidden above: 2,0\d\d tool calls \(2,000 run_command(, \d+ new_round)?\) · 1 message · 2,0\d\d thoughts$/
	);

	// A text line after every round splits the chain into thousands of groups. The
	// paging line sits above the reply and states the true hidden totals.
	await page.goto(`http://127.0.0.1:${port}/?collapsed&notes`);
	const summary = page.locator('.tool-chain-hidden-summary');
	await summary.waitFor();
	const text = await summary.innerText();
	const windowTotals = await page.locator('.tool-chain-window').evaluate((el) => ({
		total: Number(el.dataset.totalSteps),
		hidden: Number(el.dataset.hiddenSteps)
	}));
	const visibleCalls = await page.getByRole('button', { name: 'Toggle details' }).count();
	assert.match(text, /Hidden above: 1,9\d\d tool calls \(1,9\d\d run_command\)/, text);
	assert.match(text, /1,9\d\d messages · 1,9\d\d thoughts/, text);
	assert(windowTotals.hidden > 5800, `hidden=${windowTotals.hidden}`);
	assert(visibleCalls < 30, `visible groups=${visibleCalls}`);
	// Not inside a collapsed group: the line is visible without expanding anything.
	assert(await summary.isVisible());
	console.log(`NOTES SUMMARY: ${text}`);

	// Scrolling back up after loading a page must not chain through every page: auto-load
	// waits for scrolling to rest and loads one page per stop. (Before: 100 -> 1,000.)
	const visibleNow = () =>
		page
			.locator('.tool-chain-window')
			.evaluate((el) => Number(el.dataset.totalSteps) - Number(el.dataset.hiddenSteps));
	await page.getByRole('button', { name: /^Load [\d,]+ earlier steps$/ }).click();
	await page.waitForTimeout(300);
	const afterManual = await visibleNow();
	await page.mouse.move(500, 400);
	for (let i = 0; i < 10; i++) {
		await page.mouse.wheel(0, 600);
		await page.waitForTimeout(30);
	}
	await page.waitForTimeout(300);
	for (let i = 0; i < 60; i++) {
		await page.mouse.wheel(0, -400);
		await page.waitForTimeout(30);
	}
	await page.waitForTimeout(800);
	const afterFling = await visibleNow();
	assert(
		afterFling - afterManual <= 6 * 50,
		`Scrolling up chained loads: ${afterManual} -> ${afterFling}`
	);

	// The paging line's numbers match what is rendered: hidden calls plus the calls counted
	// by the visible dropdown headers equal every call in the reply.
	const consistency = await page.evaluate(() => {
		const line = document.querySelector('.tool-chain-page-boundary')?.innerText ?? '';
		const hidden = Number(
			(line.match(/Hidden above: ([\d,]+) tool call/) ?? [0, '0'])[1].replace(/,/g, '')
		);
		let shown = 0;
		document.querySelectorAll('[aria-label="Toggle details"]').forEach((el) => {
			const text = el.innerText.replace(/^(Explored|Exploring)\s*/, '');
			for (const part of text.split(',')) {
				const count = part.trim().match(/^([\d,]+)\s/);
				shown += count ? Number(count[1].replace(/,/g, '')) : part.trim() ? 1 : 0;
			}
		});
		return { hidden, shown };
	});
	assert.equal(consistency.hidden + consistency.shown, 2000, JSON.stringify(consistency));

	// iPad Safari: no scroll anchoring, and position corrections are lost during momentum.
	// Even then, one stop loads at most one page.
	await page.goto(`http://127.0.0.1:${port}/?collapsed&notes`);
	await page.locator('.tool-chain-window').waitFor();
	await page.locator('#messages-container').evaluate((el) => {
		el.style.overflowAnchor = 'none';
		const native = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
		Object.defineProperty(el, 'scrollTop', {
			get() {
				return native.get.call(this);
			},
			set() {},
			configurable: true
		});
	});
	await page.getByRole('button', { name: /^Load [\d,]+ earlier steps$/ }).click();
	await page.waitForTimeout(300);
	const safariStart = await visibleNow();
	for (let i = 0; i < 10; i++) {
		await page.mouse.wheel(0, 600);
		await page.waitForTimeout(30);
	}
	await page.waitForTimeout(300);
	for (let i = 0; i < 60; i++) {
		await page.mouse.wheel(0, -400);
		await page.waitForTimeout(30);
	}
	await page.waitForTimeout(800);
	const safariEnd = await visibleNow();
	assert(
		safariEnd - safariStart <= 2 * 50,
		`Safari-like scrolling chained loads: ${safariStart} -> ${safariEnd}`
	);
	console.log(
		`SCROLL-UP: ${afterManual} -> ${afterFling} steps (Chromium), ${safariStart} -> ${safariEnd} (Safari-like); counts consistent`
	);

	// Generating while you read: load a page, rest near the boundary, 60 rounds arrive.
	// Nothing you loaded is dropped and, even without scroll anchoring (Safari), the row
	// you are reading stays where it is. (Before: 69 loaded steps dropped, content jumped.)
	for (const safari of [false, true]) {
		await page.goto(`http://127.0.0.1:${port}/?notes`);
		await page.locator('.tool-chain-window').waitFor();
		if (safari) {
			await page
				.locator('#messages-container')
				.evaluate((el) => (el.style.overflowAnchor = 'none'));
		}
		await page.getByRole('button', { name: /^Load [\d,]+ earlier steps$/ }).click();
		await page.waitForTimeout(400);
		await page
			.locator('.tool-chain-window')
			.evaluate((el) => el.scrollIntoView({ block: 'start' }));
		await page.mouse.move(500, 400);
		await page.mouse.wheel(0, 120);
		await page.waitForTimeout(500);
		const reading = () =>
			page.evaluate(() => {
				const w = document.querySelector('.tool-chain-window');
				const root = document.getElementById('messages-container');
				const rootTop = root.getBoundingClientRect().top;
				const rows = [
					...document.querySelectorAll('[aria-label="Toggle details"], .whitespace-pre-wrap')
				];
				const row = rows.find((r) => r.getBoundingClientRect().top >= rootTop + 60);
				return {
					hidden: Number(w.dataset.hiddenSteps),
					text: row?.innerText.slice(0, 30),
					y: Math.round(row?.getBoundingClientRect().top ?? -1)
				};
			});
		const before = await reading();
		for (let i = 0; i < 60; i++) {
			await page.getByRole('button', { name: 'Append tool round' }).click();
			await page.waitForTimeout(20);
		}
		await page.waitForTimeout(600);
		const after = await reading();
		assert.equal(after.hidden, before.hidden, `Generation dropped loaded steps (safari=${safari})`);
		assert.deepEqual(after, before, `Reading position moved during generation (safari=${safari})`);
	}

	// Two ways to reveal: one page, or everything.
	await page.goto(`http://127.0.0.1:${port}/?notes`);
	await page.locator('.tool-chain-window').waitFor();
	const showAll = page.getByRole('button', { name: /^Show all [\d,]+ steps$/ });
	assert.equal(await showAll.innerText(), 'Show all 6,001 steps');
	assert.equal(
		await page.getByRole('button', { name: /^Load [\d,]+ earlier steps$/ }).innerText(),
		'Load 50 earlier steps'
	);
	await showAll.click();
	await page.waitForFunction(
		() => document.querySelector('.tool-chain-window')?.dataset.hiddenSteps === '0'
	);
	assert.equal(await page.locator('[id$="-tool-call"]').count(), 2000);
	assert.equal(await page.locator('.tool-chain-hidden-summary').count(), 0);
	assert.equal(await showAll.count(), 0, 'Show all still offered with nothing hidden');
	// New rounds keep everything visible; "Show recent steps" goes back to one page.
	await page.getByRole('button', { name: 'Append tool round' }).click();
	await page.waitForFunction(
		() => document.querySelector('.tool-chain-window')?.dataset.hiddenSteps === '0'
	);
	await page.getByRole('button', { name: 'Show recent steps' }).click();
	await page.waitForFunction(
		() => Number(document.querySelector('.tool-chain-window')?.dataset.hiddenSteps) > 5900
	);

	assert.deepEqual(errors, [], `Browser runtime errors: ${errors.join('; ')}`);
	console.log(
		'COLLAPSED CHECK: PASS — full-chain header counts, no pager or loading while collapsed, nothing dropped while scrolled away, reset at bottom, true hidden totals with text between calls, no chained loads when scrolling back up, counts match rendered content, stable while generating, load 50 / show all'
	);
} finally {
	await browser?.close();
	server.kill('SIGTERM');
	await once(server, 'exit').catch(() => {});
}
