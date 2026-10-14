<script lang="ts">
	import { onMount, setContext, tick } from 'svelte';
	import { writable } from 'svelte/store';
	import english from '../../src/lib/i18n/locales/en-US/translation.json';
	import FileNav from '../../src/lib/components/chat/FileNav.svelte';
	import CustomSettings from '../../src/lib/components/admin/Settings/CustomSettings.svelte';
	import { getCustomSettings } from '../../src/lib/apis/custom-settings';
	import {
		config,
		settings,
		user,
		terminalServers,
		selectedTerminalId
	} from '../../src/lib/stores';
	import '../../src/tailwind.css';
	import '../../src/app.css';

	setContext(
		'i18n',
		writable({
			language: 'en-US',
			resolvedLanguage: 'en-US',
			t: (key: string, values: Record<string, unknown> = {}) =>
				((english as Record<string, string>)[key] || key).replace(/\{\{(\w+)\}\}/g, (_, name) =>
					String(values[name] ?? name)
				)
		})
	);
	let ready = false;
	let showSettings = false;
	let instance = 0;
	let order = '';
	let error = '';
	let browserPanel: HTMLElement;

	function unrelatedConfigChange() {
		config.update((current) => (current ? { ...current, name: `${current.name}!` } : current));
	}

	onMount(() => {
		localStorage.token = 'fixture-admin';
		settings.set({});
		user.set({ id: 'fixture', name: 'Fixture', role: 'admin' } as any);
		terminalServers.set([
			{ id: 'fixture', name: 'Fixture terminal', url: `${location.origin}/terminal` }
		]);
		selectedTerminalId.set('fixture');
		void (async () => {
			try {
				const custom_settings = await getCustomSettings(localStorage.token);
				config.set({
					name: 'Filesystem fixture',
					features: { enable_tool_servers: true },
					custom_settings
				} as any);
				ready = true;
				await tick();
				const update = () => {
					order = [...browserPanel.querySelectorAll('[data-file-row]')]
						.map(
							(row) =>
								row.querySelector('[data-filename]')?.getAttribute('data-filename') ??
								row.textContent?.trim().split(/\s+/)[0]
						)
						.join(' → ');
				};
				const observer = new MutationObserver(update);
				observer.observe(browserPanel, { childList: true, subtree: true });
				await new Promise<void>((resolve, reject) => {
					const timer = setInterval(() => {
						if (browserPanel.querySelectorAll('[data-file-row]').length === 4) {
							clearInterval(timer);
							resolve();
						}
					}, 50);
					setTimeout(() => {
						clearInterval(timer);
						reject(new Error('Filesystem did not load'));
					}, 20000);
				});
				update();
				if (new URLSearchParams(location.search).has('record')) {
					await new Promise<void>((resolve) =>
						requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
					);
					await fetch('/__demo_mark', { method: 'POST', body: 'ready' });
				}
			} catch (cause) {
				error = String(cause);
			}
		})();
	});
</script>

<main>
	<header>
		<div>
			<h1>OpenWebUI · Filesystem sort default</h1>
			<p>Production filesystem and admin settings · synthetic terminal data</p>
		</div>
		<div class="actions">
			<button on:click={() => (showSettings = !showSettings)}>Custom Settings</button>
			<button on:click={() => instance++}>Reopen filesystem</button>
			<button on:click={() => location.reload()}>Reload page</button>
			<button on:click={unrelatedConfigChange}>Update other config</button>
		</div>
	</header>
	{#if error}<p role="alert">{error}</p>{/if}
	<div class="columns">
		<section aria-label="Terminal filesystem" class="panel" bind:this={browserPanel}>
			{#if ready}{#key instance}<FileNav />{/key}{/if}
		</section>
		<aside aria-label="Admin Custom Settings" class="panel settings-panel">
			{#if showSettings}<CustomSettings />{:else}<p>
					Open Custom Settings to configure the filesystem default.
				</p>{/if}
		</aside>
	</div>
	<p class="order" data-testid="rendered-order">Rendered order: {order}</p>
</main>

<style>
	:global(body) {
		margin: 0;
		background: #f8fafc;
		color: #111827;
	}
	main {
		padding: 24px;
	}
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 20px;
		margin-bottom: 20px;
	}
	h1 {
		font-size: 20px;
		font-weight: 600;
		margin: 0 0 5px;
	}
	header p,
	.order {
		font-size: 12px;
		color: #475569;
	}
	.actions {
		display: flex;
		gap: 7px;
		flex-wrap: wrap;
		max-width: 460px;
		justify-content: flex-end;
	}
	.actions button {
		border: 1px solid #cbd5e1;
		border-radius: 7px;
		padding: 7px 10px;
		background: white;
		font-size: 12px;
	}
	.columns {
		display: grid;
		grid-template-columns: 1fr 460px;
		gap: 24px;
	}
	.panel {
		height: 530px;
		border: 1px solid #cbd5e1;
		border-radius: 12px;
		background: white;
		overflow: hidden;
	}
	.settings-panel {
		padding: 18px;
	}
	.order {
		margin-top: 12px;
	}
</style>
