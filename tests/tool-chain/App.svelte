<script lang="ts">
	import { onMount, setContext, tick } from 'svelte';
	import { writable } from 'svelte/store';
	import StructuredOutputRenderer from '../../src/lib/components/chat/Messages/StructuredOutputRenderer.svelte';
	import { settings, user, config } from '../../src/lib/stores';
	import {
		applyResponseStreamEvent,
		getOutputText,
		type OutputItem
	} from '../../src/lib/components/chat/Messages/structuredOutput';

	setContext(
		'i18n',
		writable({
			language: 'en-US',
			t: (key: string, values: Record<string, unknown> = {}) =>
				key.replace(/\{\{(\w+)\}\}/g, (_, name) => String(values[name] ?? name))
		})
	);
	settings.set({
		expandDetails: true,
		detectArtifacts: false,
		renderMarkdownInAssistantMessages: false
	});
	user.set({ id: 'fixture', name: 'Fixture', role: 'admin' } as any);
	config.set({ features: {} } as any);

	const count = 2000;
	let output: OutputItem[] = Array.from({ length: count }, (_, index) => [
		{
			type: 'reasoning',
			id: `r${index}`,
			status: 'completed',
			duration: 1,
			content: [{ text: `Verify tool step ${index + 1}.` }]
		},
		{
			type: 'function_call',
			id: `c${index}`,
			call_id: `c${index}`,
			name: 'run_command',
			status: 'completed',
			arguments: JSON.stringify({ step: index + 1, command: `check-step-${index + 1}` })
		},
		{
			type: 'function_call_output',
			id: `o${index}`,
			call_id: `c${index}`,
			output: [
				{
					type: 'input_text',
					text: JSON.stringify({ success: true, stdout: `Result for step ${index + 1}.` })
				}
			]
		}
	]).flat();
	output.push({
		type: 'message',
		id: 'live',
		content: [{ type: 'output_text', text: 'Live response: ' }],
		status: 'in_progress'
	});
	let messageId = 'fixture-message';
	let tokens = 0;
	let streaming = false;
	let interval: ReturnType<typeof setInterval>;
	let scrollContainer: HTMLDivElement;
	let savedHash = '';
	let shownSteps = 0;
	let hiddenSteps = 0;

	async function refreshSnapshot() {
		savedHash = getOutputText(output);
		output = JSON.parse(JSON.stringify(output));
		messageId += '-refresh';
		await tick();
	}

	function pinApproval() {
		output = output
			.filter((item) => item.id !== 'o0')
			.map((item) => (item.id === 'c0' ? { ...item, status: 'pending' } : item));
	}

	function appendTokens() {
		if (streaming) return;
		streaming = true;
		interval = setInterval(() => {
			output = applyResponseStreamEvent(output, {
				type: 'response.output_text.delta',
				item_id: 'live',
				content_index: 0,
				delta: `token-${tokens++} `
			});
			if (tokens >= 150) {
				clearInterval(interval);
				streaming = false;
			}
		}, 1000 / 150);
	}

	function appendRound() {
		const index = output.length;
		output = [
			...output,
			{
				type: 'reasoning',
				id: `new-r${index}`,
				status: 'completed',
				content: [{ text: 'New round after paging.' }]
			},
			{
				type: 'function_call',
				id: `new-c${index}`,
				call_id: `new-c${index}`,
				name: 'new_round',
				status: 'completed',
				arguments: '{}'
			},
			{
				type: 'function_call_output',
				call_id: `new-c${index}`,
				output: [{ text: 'New round retained.' }]
			}
		];
	}

	async function mark(label: string) {
		if (!new URLSearchParams(location.search).has('record')) return;
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
		);
		const response = await fetch('/__demo_mark', { method: 'POST', body: label });
		if (!response.ok) throw new Error(`Mark ${label} failed`);
	}

	onMount(() => {
		const updateStats = () => {
			const pager = document.querySelector<HTMLElement>('.tool-chain-window');
			const total = Number(pager?.dataset.totalSteps ?? 0);
			hiddenSteps = Number(pager?.dataset.hiddenSteps ?? 0);
			shownSteps = total - hiddenSteps;
		};
		const observer = new MutationObserver(updateStats);
		observer.observe(scrollContainer, { childList: true, subtree: true, attributes: true });
		updateStats();
		void mark('ready');
		return () => {
			observer.disconnect();
			clearInterval(interval);
		};
	});
</script>

<main>
	<header>
		<h1>OpenWebUI · tool-chain paging</h1>
		<p>
			Production renderer · 2,000 retained tool calls · {shownSteps} displayed steps · {hiddenSteps} earlier
			steps hidden
		</p>
		<div class="controls">
			<button on:click={appendTokens}>Stream 150 tokens</button>
			<button on:click={appendRound}>Append tool round</button>
			<button on:click={pinApproval}>Pin oldest approval</button>
			<button on:click={refreshSnapshot}>Reload saved snapshot</button>
		</div>
		<p data-testid="state">
			Retained output items: {output.length} · Streamed tokens: {tokens} · Snapshot text preserved: {savedHash
				? getOutputText(output) === savedHash
				: 'not checked'}
		</p>
	</header>
	<div class="scroll-container" id="messages-container" bind:this={scrollContainer}>
		<StructuredOutputRenderer
			id="fixture"
			chatId="fixture-chat"
			{messageId}
			{output}
			done={false}
			save={true}
			renderMarkdown={false}
			allowEmbeds={false}
		/>
	</div>
</main>

<style>
	:global(body) {
		margin: 0;
		background: #f7f8fa;
		color: #171717;
		font-family: Arial, sans-serif;
	}
	main {
		padding: 24px;
		max-width: 1100px;
		margin: auto;
	}
	h1 {
		font-size: 22px;
		font-weight: 600;
		margin-bottom: 8px;
	}
	p {
		font-size: 14px;
		margin: 8px 0;
	}
	.controls {
		display: flex;
		gap: 10px;
		margin: 14px 0;
	}
	.controls button {
		border: 1px solid #cbd5e1;
		padding: 8px 12px;
		border-radius: 6px;
		background: white;
		font-size: 13px;
	}
	.scroll-container {
		height: 450px;
		overflow-y: auto;
		border: 1px solid #cbd5e1;
		border-radius: 10px;
		background: white;
		padding: 18px;
		margin-top: 15px;
	}
	:global(.tool-chain-page-boundary button) {
		margin: 8px;
		padding: 6px;
		cursor: pointer;
	}
	:global(.tool-chain-page-boundary span) {
		margin-right: 14px;
	}
	:global(svg) {
		width: 16px;
		height: 16px;
		display: inline-block;
	}
	:global(.shimmer) {
		color: #2563eb;
	}
	:global([class*='text-red']) {
		color: #dc2626;
	}
	:global([class*='text-emerald']) {
		color: #059669;
	}
	:global(.scroll-container button),
	:global(.scroll-container [role='button']) {
		cursor: pointer;
	}
	:global(.scroll-container pre) {
		white-space: pre-wrap;
		font-size: 12px;
	}
	:global(.scroll-container [class*='space-y']) {
		margin: 10px 0;
	}
</style>
