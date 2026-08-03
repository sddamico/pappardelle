/**
 * Selection logic for the ready-work picker shown under the new-session
 * prompt. Kept free of React so the keymap can be unit-tested directly.
 *
 * The text input and the list share one selection cursor: INPUT_INDEX means
 * the caret is in the text field, and 0..count-1 point at a suggestion. That
 * union is what lets the input stay focused the whole time — arrow keys are
 * a no-op inside the field (handleTextInputKey ignores them), so the dialog
 * can claim them for list movement without stealing typing.
 */

export const INPUT_INDEX = -1;

/**
 * Move the shared cursor by one row. Deliberately does not wrap: the list is
 * anchored below a text field, so wrapping from the last suggestion back to
 * the input reads as a glitch rather than a shortcut.
 */
export function moveSelection(
	current: number,
	count: number,
	direction: 'up' | 'down',
): number {
	if (count <= 0) return INPUT_INDEX;

	const next = direction === 'down' ? current + 1 : current - 1;
	if (next < INPUT_INDEX) return INPUT_INDEX;
	if (next > count - 1) return count - 1;
	return next;
}

/**
 * What Enter should submit. A highlighted suggestion wins over whatever is in
 * the text field, so a user who typed a few characters and then arrowed into
 * the list gets the issue they are looking at.
 *
 * Returns null when there is nothing to submit — an empty field with no
 * selection — and the caller should ignore the keypress.
 */
export function resolveSubmission(
	typed: string,
	identifiers: readonly string[],
	selectedIndex: number,
): string | null {
	if (selectedIndex >= 0) {
		return identifiers[selectedIndex] ?? null;
	}

	const trimmed = typed.trim();
	return trimmed.length > 0 ? trimmed : null;
}

/**
 * Which slice of the suggestions to render so the highlighted row stays on
 * screen. The dialog floats over the space list, so an unbounded list would
 * push the prompt off the top of short terminals.
 */
export function visibleWindow(
	selectedIndex: number,
	count: number,
	maxVisible: number,
): {start: number; end: number} {
	if (count <= maxVisible) return {start: 0, end: count};

	// A cursor in the text field shows the head of the list, not a window
	// scrolled to wherever the user last was.
	const anchor = Math.max(0, selectedIndex);
	const start = Math.min(
		Math.max(0, anchor - Math.floor(maxVisible / 2)),
		count - maxVisible,
	);
	return {start, end: start + maxVisible};
}
