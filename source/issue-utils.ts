// Pure utility functions for issue identification
// These have no side effects and can be easily tested

/**
 * Check if a string looks like a Linear issue key (e.g., STA-123, ENG-456)
 */
export function isLinearIssueKey(input: string): boolean {
	return /^[A-Z][A-Z0-9]*-\d+$/i.test(input.trim());
}

/**
 * Provider-agnostic alias for isLinearIssueKey.
 * The pattern (PREFIX-NUMBER) is shared by Linear, Jira, and most trackers.
 */
export const isIssueKey = isLinearIssueKey;

/**
 * Check if a string is a bare issue number (e.g., 400, 123)
 */
export function isIssueNumber(input: string): boolean {
	return /^\d+$/.test(input.trim());
}

const LINEAR_URL_ISSUE_KEY =
	/^https:\/\/linear\.app\/[^/]+\/issue\/([A-Z][A-Z0-9]*)-\d+/i;

/**
 * Extract the team prefix an issue identifier belongs to (e.g. 'STA' for
 * 'STA-123'), uppercased. Accepts a bare key or a Linear issue URL.
 *
 * Returns null when the input carries no prefix of its own — bare numbers
 * borrow one from config, and prose has none — which is the signal callers
 * use to fall back to prefix-independent behavior.
 */
export function issueKeyPrefix(input: string): string | null {
	const trimmed = input.trim();

	const url = trimmed.match(LINEAR_URL_ISSUE_KEY);
	if (url) return url[1]!.toUpperCase();

	if (!isLinearIssueKey(trimmed)) return null;
	return trimmed.split('-')[0]!.toUpperCase();
}

/**
 * Normalize an issue identifier to uppercase format (e.g., STA-400)
 * Accepts:
 *   - Bare numbers: '400' -> 'STA-400' (uses teamPrefix)
 *   - Lowercase keys: 'sta-123' -> 'STA-123'
 *   - Mixed case: 'Sta-456' -> 'STA-456'
 * Returns null if input is not a valid issue identifier
 */
export function normalizeIssueIdentifier(
	input: string,
	teamPrefix: string,
): string | null {
	const trimmed = input.trim();

	// Bare number: expand with team prefix
	if (isIssueNumber(trimmed)) {
		return `${teamPrefix.toUpperCase()}-${trimmed}`;
	}

	// Full issue key: normalize to uppercase
	if (isLinearIssueKey(trimmed)) {
		return trimmed.toUpperCase();
	}

	// Not an issue identifier
	return null;
}
