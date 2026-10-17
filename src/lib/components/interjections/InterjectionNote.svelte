<script lang="ts">
	// Fork addition (0.3.3): in a reply, where the user's messages reached the model.
	import { WEBUI_API_BASE_URL, WEBUI_BASE_URL } from '$lib/constants';

	export let entries: { id: string; text: string; files?: any[] }[] = [];
	export let held = false;

	const src = (f: any) =>
		f?.id
			? `${WEBUI_API_BASE_URL}/files/${f.id}/content`
			: typeof f?.url === 'string' && f.url.startsWith('/')
				? `${WEBUI_BASE_URL}${f.url}`
				: (f?.url ?? '');
</script>

<div class="my-2 flex w-full justify-end">
	<div class="max-w-[90%] rounded-2xl bg-gray-50 px-3.5 py-2 text-sm dark:bg-gray-850">
		<p class="mb-1 text-xs text-gray-500 dark:text-gray-400">
			{held ? 'You added (its next call waited so it could read this)' : 'You added'}
		</p>
		{#each entries as entry (entry.id)}
			{#if entry.text?.trim()}
				<p class="whitespace-pre-wrap break-words">{entry.text}</p>
			{/if}
			{#if entry.files?.length}
				<div class="mt-1 flex flex-wrap gap-1.5">
					{#each entry.files as f}
						{#if f.type === 'image'}
							<img src={src(f)} alt={f.name || 'image'} class="max-h-32 rounded-lg" loading="lazy" />
						{:else}
							<span
								class="rounded-lg border border-gray-200 px-2 py-0.5 text-xs text-gray-600 dark:border-gray-700 dark:text-gray-300"
								title={f.path ?? f.name}>{f.name || f.path}</span
							>
						{/if}
					{/each}
				</div>
			{/if}
		{/each}
	</div>
</div>
