<script lang="ts">
	// Fork addition, round 4. Presentation comes from the manager; no scheduling rules here.
	export let operation: any = null;
	export let problem: any = null;
	export let admin = false;
	export let technical = '';
	const elapsed = (s: number) => s < 60 ? `${s} s elapsed` : `${Math.floor(s / 60)} min ${s % 60} s elapsed`;
</script>

<div class="min-w-0 max-w-full break-words text-xs text-gray-600 dark:text-gray-300">
	{#if operation}<p class="mb-1 break-all font-medium">{operation.model}</p>{/if}
	<!-- Announce phase/cause changes, not the clock on every poll. -->
	<div role="status" aria-live="polite" aria-atomic="true">
		{#if problem}
			<p class="font-medium text-red-600 dark:text-red-400">{problem.primary}</p>
			<p>{problem.why}</p>
			<p>{admin ? problem.admin_action : problem.user_action}</p>
		{:else if operation}
			<p class="font-medium">{operation.primary}</p>
			<p>{operation.why}</p>
			<p>{operation.estimate_text}</p>
		{/if}
	</div>
	{#if operation}
		<p class="mt-1 tabular-nums">{elapsed(operation.elapsed_s)}</p>
		<details class="mt-1">
			<summary class="cursor-pointer">Steps and times</summary>
			<ol class="mt-1 space-y-2 pl-4 list-decimal">
				{#each operation.steps as step (step.id)}
					<li aria-current={step.status === 'active' ? 'step' : undefined}>
						<span class="font-medium">{step.label}</span> · {step.status_text ?? step.status}
						<p>{step.why}</p>
						<p class="tabular-nums">{elapsed(step.elapsed_s)} · {step.time_text}</p>
					</li>
				{/each}
			</ol>
		</details>
	{/if}
	{#if admin && (technical || problem?.details)}
		<details class="mt-2">
			<summary class="cursor-pointer">Technical details for the admin</summary>
			<pre class="mt-1 whitespace-pre-wrap break-all font-mono text-[0.6875rem]">{problem?.details ?? technical}</pre>
		</details>
	{/if}
</div>
