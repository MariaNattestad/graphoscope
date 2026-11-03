<script lang="ts">
	// The layout-mode list in the options panel: every mode of the current family
	// as a row with a thumbnail sketch of what it draws, its name and its
	// description, so the choice can be made before trying each one. The list
	// scrolls when it outgrows the panel and behaves as a radio group (arrow keys
	// move the selection).
	import type { LayoutMode, LayoutModeConfig } from './layoutModes';

	let {
		modes,
		mode = $bindable()
	}: {
		modes: LayoutModeConfig[];
		mode: LayoutMode;
	} = $props();

	let list = $state<HTMLDivElement>();

	function onKeydown(e: KeyboardEvent) {
		const step =
			e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
		if (!step) return;
		e.preventDefault();
		const i = modes.findIndex((m) => m.id === mode);
		const next = modes[(i + step + modes.length) % modes.length];
		mode = next.id;
		list?.querySelector<HTMLButtonElement>(`[data-mode="${next.id}"]`)?.focus();
	}
</script>

<!-- Focus moves between the radios (roving tabindex), never to the group itself. -->
<div class="mode-list" role="radiogroup" aria-label="Layout mode" tabindex="-1" bind:this={list} onkeydown={onKeydown}>
	{#each modes as m (m.id)}
		<button
			type="button"
			role="radio"
			aria-checked={m.id === mode}
			tabindex={m.id === mode ? 0 : -1}
			class="mode-item"
			class:active={m.id === mode}
			data-mode={m.id}
			onclick={() => (mode = m.id)}
		>
			<svg class="thumb" viewBox="0 0 64 40" aria-hidden="true">
				{#if m.family === 'anchored'}
					<line class="ref" x1="3" y1="35" x2="61" y2="35" />
				{/if}
				{#if m.id === 'classic'}
					<!-- Bubbles as horizontal lanes, each centred over its anchor. -->
					<path class="link" d="M14 35 L9 25 M14 35 L19 25" />
					<path class="alt" d="M9 25 H19" />
					<path class="link" d="M32 35 L28 25 M32 35 L36 25 M31 35 L29 16 M33 35 L35 16" />
					<path class="alt" d="M28 25 H36 M29 16 H35" />
					<path class="link" d="M46 35 L46 25 M55 35 L55 25" />
					<path class="alt" d="M46 25 H55" />
				{:else if m.id === 'stacked'}
					<!-- Bubbles pulled into wobbly columns over their anchors. -->
					<path class="alt" d="M30 35 C 25 28, 36 25, 31 18 S 27 9, 33 5" />
					<circle class="dot" cx="31" cy="18" r="1.6" />
					<circle class="dot" cx="33" cy="5" r="1.6" />
					<circle class="dot" cx="28.5" cy="27" r="1.6" />
					<path class="alt" d="M50 35 C 46 29, 54 27, 50 20" />
					<circle class="dot" cx="50" cy="20" r="1.6" />
					<path class="alt" d="M14 35 C 11 30, 17 29, 14 25" />
					<circle class="dot" cx="14" cy="25" r="1.6" />
				{:else if m.id === 'assembly'}
					<!-- A wavy rainbow backbone with a big loop and a dashed deletion arc. -->
					<path d="M4 26 C 14 22, 18 30, 28 26" stroke="#ef4444" stroke-width="2.6" fill="none" />
					<path d="M28 26 C 36 22, 42 30, 50 26" stroke="#22c55e" stroke-width="2.6" fill="none" />
					<path d="M50 26 C 54 24, 57 27, 61 25" stroke="#8b5cf6" stroke-width="2.6" fill="none" />
					<path class="alt" d="M24 25 C 20 6, 40 4, 36 24" />
					<path class="link" d="M44 27 C 47 38, 56 38, 58 27" stroke-dasharray="2 2" />
				{:else if m.id === 'naive'}
					<!-- A plain force layout pinned only along the reference line. -->
					<path class="alt" d="M10 35 C 16 18, 26 46, 34 30 S 50 14, 54 35" />
					<circle class="dot" cx="20" cy="29" r="1.6" />
					<circle class="dot" cx="34" cy="30" r="1.6" />
					<circle class="dot" cx="46" cy="22" r="1.6" />
				{:else if m.id === 'fm3'}
					<!-- An untangled ribbon with its bubbles opened out. -->
					<path class="alt" d="M5 26 C 14 10, 24 10, 32 20 S 50 30, 59 14" />
					<path class="alt" d="M14 15 C 18 25, 26 24, 30 18" />
					<path class="alt" d="M40 25 C 44 36, 54 32, 55 21" />
					<circle class="dot" cx="5" cy="26" r="1.6" />
					<circle class="dot" cx="59" cy="14" r="1.6" />
				{:else if m.id === 'simple-force'}
					<!-- Nodes and links wherever the forces leave them. -->
					<path class="link" d="M10 28 L20 13 L31 24 L43 9 L53 25 L37 33 L22 32 L10 28 M31 24 L37 33 M20 13 L22 32" />
					{#each [[10, 28], [20, 13], [31, 24], [43, 9], [53, 25], [37, 33], [22, 32]] as [x, y] (`${x},${y}`)}
						<circle class="dot" cx={x} cy={y} r="2" />
					{/each}
				{:else if m.id === 'flow'}
					<!-- Left to right by graph distance, curves left free. -->
					<path class="link" d="M7 20 C 13 20, 15 11, 21 11 M7 20 C 13 20, 15 29, 21 29 M21 11 C 28 11, 30 20, 36 20 M21 29 C 28 29, 30 20, 36 20 M36 20 C 42 20, 44 10, 51 12 M36 20 C 42 20, 44 30, 51 28 M51 12 L58 20 M51 28 L58 20" />
					{#each [[7, 20], [21, 11], [21, 29], [36, 20], [51, 12], [51, 28], [58, 20]] as [x, y] (`${x},${y}`)}
						<circle class="dot" cx={x} cy={y} r="2" />
					{/each}
				{:else if m.id === 'layered'}
					<!-- Ranked columns, rows ordered to keep edges from crossing. -->
					<path class="link" d="M7 20 L21 10 M7 20 L21 20 M7 20 L21 30 M21 10 L36 15 M21 20 L36 15 M21 30 L36 28 M36 15 L51 20 M36 28 L51 20 M51 20 L58 20" />
					{#each [[7, 20], [21, 10], [21, 20], [21, 30], [36, 15], [36, 28], [51, 20], [58, 20]] as [x, y] (`${x},${y}`)}
						<circle class="dot" cx={x} cy={y} r="2" />
					{/each}
				{:else if m.id === 'radial'}
					<!-- Rings of graph depth around a central node. -->
					<circle class="ring" cx="32" cy="20" r="9" />
					<circle class="ring" cx="32" cy="20" r="17" />
					<path class="link" d="M32 20 L32 11 L32 3 M32 20 L41 20 L49 20 M32 20 L23 20 L15 20 M32 20 L32 29 L32 37 M32 11 L44 8 M23 20 L20 32" />
					{#each [[32, 20], [32, 11], [41, 20], [23, 20], [32, 29], [32, 3], [49, 20], [15, 20], [32, 37], [44, 8], [20, 32]] as [x, y] (`${x},${y}`)}
						<circle class="dot" cx={x} cy={y} r="1.8" />
					{/each}
				{/if}
			</svg>
			<span class="text">
				<span class="label">{m.label}</span>
				<span class="blurb">{m.blurb}</span>
			</span>
		</button>
	{/each}
</div>

<style>
	.mode-list {
		display: flex;
		flex-direction: column;
		gap: 4px;
		max-height: 300px;
		overflow-y: auto;
		padding: 2px;
		margin: -2px;
	}
	.mode-item {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		width: 100%;
		padding: 0.4rem;
		font: inherit;
		text-align: left;
		background: #fff;
		border: 1px solid #e3e6eb;
		border-radius: 8px;
		cursor: pointer;
	}
	.mode-item:hover {
		border-color: #cbd0d8;
	}
	.mode-item.active {
		border-color: #2563eb;
		background: #eff5ff;
		box-shadow: inset 0 0 0 1px #2563eb;
	}
	.mode-item:focus-visible {
		outline: 2px solid #2563eb;
		outline-offset: 1px;
	}
	.thumb {
		flex: 0 0 auto;
		width: 52px;
		height: 33px;
		background: #111317;
		border-radius: 5px;
	}
	.text {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}
	.label {
		font-size: 0.76rem;
		font-weight: 600;
		color: #1a1a1a;
	}
	.blurb {
		font-size: 0.68rem;
		line-height: 1.3;
		color: #6b7280;
	}
	.ref {
		stroke: #e5e7eb;
		stroke-width: 2;
	}
	.alt {
		fill: none;
		stroke: #f5b82e;
		stroke-width: 2.2;
		stroke-linecap: round;
	}
	.link {
		fill: none;
		stroke: #8b919c;
		stroke-width: 0.9;
		stroke-linejoin: round;
	}
	.dot {
		fill: #f5b82e;
	}
	.ring {
		fill: none;
		stroke: #3a3f48;
		stroke-width: 0.8;
	}
</style>
