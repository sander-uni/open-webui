import { performance } from 'node:perf_hooks';
import {
	buildOutputDisplayItems,
	type OutputItem
} from '../../src/lib/components/chat/Messages/structuredOutput';
import {
	selectOutputWindow,
	snapshotResponseMessage,
	buildWindowDisplayItems
} from '../../src/lib/components/chat/Messages/outputWindow';

let sink: unknown;
function median(fn: () => unknown) {
	for (let i = 0; i < 3; i++) sink = fn();
	const samples: number[] = [];
	for (let i = 0; i < 11; i++) {
		const start = performance.now();
		sink = fn();
		samples.push(performance.now() - start);
	}
	samples.sort((a, b) => a - b);
	return Number(samples[5].toFixed(3));
}

for (const calls of [200, 2000]) {
	const output: OutputItem[] = Array.from({ length: calls }, (_, index) => [
		{
			type: 'reasoning',
			id: `r${index}`,
			status: 'completed',
			content: [{ text: 'Inspect output.\n'.repeat(128) }]
		},
		{
			type: 'function_call',
			id: `c${index}`,
			call_id: `c${index}`,
			name: 'run_command',
			status: 'completed',
			arguments: '{}'
		},
		{
			type: 'function_call_output',
			id: `o${index}`,
			call_id: `c${index}`,
			output: [{ text: JSON.stringify({ success: true, stdout: 'x'.repeat(65536) }) }]
		}
	]).flat();
	const message = { id: 'm', content: 'live', output };
	const before = median(() => buildOutputDisplayItems(structuredClone(message).output));
	const after = median(() =>
		buildWindowDisplayItems(selectOutputWindow(snapshotResponseMessage(message).output).output)
	);
	console.log(
		JSON.stringify({
			calls,
			resultBytes: 65536,
			beforeMs: before,
			afterMs: after,
			speedup: Number((before / after).toFixed(1)),
			retainedItems: output.length
		})
	);
}
