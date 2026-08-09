/**
 * Regression for the narrow-sidebar bug: rows rendered nothing but the profile
 * emoji, the selected row was indistinguishable, and the title vanished when a
 * row was highlighted.
 *
 * The layout half is a Yoga shrink problem. `SpaceListItem` is handed the pane
 * width pappardelle *believes* it has; when that overshoots the pane Ink really
 * renders into (a stale tmux query, a mid-resize frame), Yoga's default
 * `flexShrink: 1` squeezes every cell on the row at once — status icon gone,
 * separators collapsed, issue key chopped mid-string with the tail spilling
 * onto extra lines. The fix pins the identity cluster at `flexShrink={0}` and
 * clips the row with `overflowX="hidden"` so the title is the only thing that
 * gives and a row is always exactly one line.
 *
 * ava runs under `--experimental-strip-types`, which can't transform the JSX in
 * `SpaceListItem.tsx`, so — as in `space-list-item-emoji.test.ts` — these tests
 * mirror the component's box structure through real Ink rather than importing
 * the component.
 */
import test from 'ava';
import React from 'react';
import {Box, Text} from 'ink';
import {render} from 'ink-testing-library';

const EMOJI = '🍝';
const STATUS_ICON = '●';
const ISSUE_KEY = 'pappardelle-akv';
const TITLE = 'Workspace sidebar rows render no title';

/**
 * Mirror of SpaceListItem's row: a non-shrinking identity cluster (emoji,
 * separator, status icon, separator, issue key, separator), a shrinkable title,
 * and a right-aligned rail. `laidOutWidth` is what the component is told the
 * pane is; `renderWidth` is what Ink actually renders into.
 */
function renderRow(options: {
	laidOutWidth: number;
	renderWidth: number;
	shrinkIdentity: boolean;
	clip: boolean;
}): string {
	const {laidOutWidth, renderWidth, shrinkIdentity, clip} = options;
	const railTokens = ['(3)', '✓'];
	const fixedCells =
		2 + 1 + STATUS_ICON.length + 1 + ISSUE_KEY.length + 1 + 1 + 3 + 1 + 1;
	const titleBudget = Math.max(0, laidOutWidth - fixedCells);

	const frame = render(
		React.createElement(
			Box,
			{width: renderWidth},
			React.createElement(
				Box,
				{width: laidOutWidth, overflowX: clip ? 'hidden' : 'visible'},
				React.createElement(
					Box,
					{flexShrink: shrinkIdentity ? 1 : 0},
					React.createElement(Text, {key: 'e'}, EMOJI),
					React.createElement(Text, {key: 'e-sep'}, ' '),
					React.createElement(Text, {key: 'i'}, STATUS_ICON),
					React.createElement(Text, {key: 'i-sep'}, ' '),
					React.createElement(Text, {key: 'k'}, ISSUE_KEY),
					React.createElement(Text, {key: 'k-sep'}, ' '),
				),
				React.createElement(
					Box,
					{flexShrink: 1, minWidth: 0},
					React.createElement(
						Text,
						{wrap: 'truncate'},
						TITLE.slice(0, titleBudget),
					),
				),
				React.createElement(
					Box,
					{flexGrow: 1, flexShrink: 0, justifyContent: 'flex-end'},
					...railTokens.map((token, i) =>
						React.createElement(Text, {key: i}, ` ${token}`),
					),
				),
			),
		),
	).lastFrame();

	return frame ?? '';
}

/** The pane is 40 wide; a stale tmux query claims 90. */
const OVERSHOT = {laidOutWidth: 90, renderWidth: 40};

test('bug reproduces when the identity cluster is allowed to shrink', t => {
	const row = renderRow({...OVERSHOT, shrinkIdentity: true, clip: false});
	// The whole point: with shrink on, the key is mangled and the row is no
	// longer a single line. If this ever passes cleanly, Yoga stopped shrinking
	// and the guards below are no longer load-bearing.
	t.false(
		row.includes(ISSUE_KEY) && row.split('\n').length === 1,
		`expected a mangled multi-line row, got:\n${row}`,
	);
});

test('the issue key survives intact when the row is laid out too wide', t => {
	for (let laidOutWidth = 40; laidOutWidth <= 120; laidOutWidth += 10) {
		const row = renderRow({
			laidOutWidth,
			renderWidth: 40,
			shrinkIdentity: false,
			clip: true,
		});
		t.true(row.includes(ISSUE_KEY), `laid out at ${laidOutWidth}:\n${row}`);
	}
});

test('the key keeps its separator — the title never welds onto it', t => {
	const row = renderRow({...OVERSHOT, shrinkIdentity: false, clip: true});
	t.notRegex(row, /pappardelle-akv\S/, `title ran into the issue key:\n${row}`);
});

test('a row is always exactly one line, however badly the width overshoots', t => {
	for (const renderWidth of [16, 20, 24, 30, 40]) {
		for (const laidOutWidth of [renderWidth, 60, 90, 120]) {
			const row = renderRow({
				laidOutWidth,
				renderWidth,
				shrinkIdentity: false,
				clip: true,
			});
			t.is(
				row.split('\n').length,
				1,
				`render ${renderWidth}, laid out ${laidOutWidth}:\n${row}`,
			);
		}
	}
});

test('no row is ever wider than the pane it renders into', t => {
	for (const renderWidth of [16, 20, 24, 30, 40]) {
		const row = renderRow({
			laidOutWidth: 90,
			renderWidth,
			shrinkIdentity: false,
			clip: true,
		});
		t.true(
			row.length <= renderWidth,
			`row of ${row.length} cells in a ${renderWidth}-wide pane:\n${row}`,
		);
	}
});
