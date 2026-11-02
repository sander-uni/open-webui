<script lang="ts">
	// fork: the pictures, videos and audio a tool made, right after its step.
	import { getContext } from 'svelte';
	import { WEBUI_BASE_URL } from '$lib/constants';
	import Image from '$lib/components/common/Image.svelte';
	import FileItem from '$lib/components/common/FileItem.svelte';
	import type { ToolFile } from './structuredOutput';
	import { localMediaPath } from './toolCallExtras';

	const i18n = getContext<any>('i18n');
	export let files: ToolFile[] = [];

	const isKind = (file: ToolFile, kind: string) => (file.content_type ?? '').startsWith(`${kind}/`);
	// Media that cannot load (deleted, no access, connection lost) says so and can try again.
	let failed = new Set<string>();
	const failureKey = (file: ToolFile) => JSON.stringify([file.id ?? '', file.url ?? '']);
	const markFailed = (file: ToolFile) => {
		failed = new Set(failed).add(failureKey(file));
	};
	const retry = (file: ToolFile) => {
		const next = new Set(failed);
		next.delete(failureKey(file));
		failed = next;
	};
	const localUrl = (file: ToolFile) => {
		const path = localMediaPath(file.url, window.location.origin);
		return path ? `${WEBUI_BASE_URL}${path}` : '';
	};
</script>

<svelte:window on:online={() => (failed = new Set())} />

<div class="tool-media my-2 flex flex-wrap gap-2 w-full" dir="auto">
	{#each files as file (file.id ?? file.url)}
		{#if failed.has(failureKey(file))}
			<button
				type="button"
				class="inline-flex h-[1.6875rem] items-center gap-1.5 rounded-lg border border-gray-100/50 bg-gray-50/40 px-2 text-xs text-gray-500 hover:text-gray-700 dark:border-white/[0.04] dark:bg-white/[0.03] dark:text-gray-400 dark:hover:text-gray-300"
				data-cy="media-unavailable"
				on:click={() => retry(file)}
			>
				{file.name || $i18n.t('File')}: {$i18n.t('Unavailable')} · {$i18n.t('Try Again')}
			</button>
		{:else if file.url && (file.type === 'image' || isKind(file, 'image'))}
			<Image
				src={file.url}
				alt={file.name || $i18n.t('Generated Image')}
				imageClassName="rounded-lg max-h-[75vh] max-w-full"
				onError={() => markFailed(file)}
			/>
		{:else if isKind(file, 'video') && localUrl(file)}
			<!-- svelte-ignore a11y-media-has-caption -->
			<video
				class="w-full max-h-[75vh] rounded-lg"
				src={localUrl(file)}
				title={file.name || $i18n.t('Video player')}
				controls
				playsinline
				preload="metadata"
				on:error={() => markFailed(file)}
			></video>
		{:else if isKind(file, 'audio') && localUrl(file)}
			<!-- svelte-ignore a11y-media-has-caption -->
			<audio
				class="w-full"
				src={localUrl(file)}
				title={file.name || $i18n.t('Audio player')}
				controls
				preload="metadata"
				on:error={() => markFailed(file)}
			></audio>
		{:else}
			<FileItem
				item={file}
				url={file.url ?? ''}
				name={file.name ?? ''}
				type={file.type ?? 'file'}
				size={file.size ?? 0}
				small={true}
			/>
		{/if}
	{/each}
</div>
