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
 * The issue-source prefix of an issue key: everything ahead of the last hyphen,
 * with any `.N` child suffix dropped first. `STA-123` -> `STA`,
 * `seatgeek-ticket-management-cli-bqm` -> `seatgeek-ticket-management-cli`.
 *
 * Splitting on the last hyphen rather than the first is what admits beads
 * prefixes, which may contain hyphens of their own. An identifier with no
 * hyphen yields itself.
 */
export function issueKeyPrefix(identifier: string): string {
	const root = identifier.split('.')[0] ?? identifier;
	const lastDash = root.lastIndexOf('-');
	return lastDash === -1 ? root : root.slice(0, lastDash);
}

/**
 * Check if a string is a beads issue ID belonging to one of `prefixes`
 * (e.g. bd-a1b2, bd-a3f8e9.1, seatgeek-ticket-management-cli-bqm).
 *
 * A beads suffix is a content hash and can be pure letters, so shape alone
 * cannot tell `dark-mode` from an ID. The prefix allowlist is what does; with
 * no known prefixes, nothing matches.
 */
export function isBeadsIssueKey(input: string, prefixes: string[]): boolean {
	const trimmed = input.trim();
	if (!/^[a-z\d_]+(-[a-z\d_]+)+(\.\d+){0,3}$/i.test(trimmed)) return false;
	const prefix = issueKeyPrefix(trimmed).toLowerCase();
	return prefixes.some(p => p.trim().toLowerCase() === prefix);
}

/**
 * Check if a string is a bare issue number (e.g., 400, 123)
 */
export function isIssueNumber(input: string): boolean {
	return /^\d+$/.test(input.trim());
}

/**
 * Normalize an issue identifier to the form its tracker uses.
 * Accepts:
 *   - Bare numbers: '400' -> 'STA-400' (uses teamPrefix)
 *   - Lowercase keys: 'sta-123' -> 'STA-123'
 *   - Mixed case: 'Sta-456' -> 'STA-456'
 * Returns null if input is not a valid issue identifier
 *
 * `provider` selects the key grammar. Beads IDs fold to lowercase rather than
 * uppercase, since that is the only casing `bd` can resolve. `beadsPrefixes` is
 * the allowlist from `getBeadsPrefixes`; anything outside it is prose, not a key.
 */
export function normalizeIssueIdentifier(
	input: string,
	teamPrefix: string,
	provider?: string,
	beadsPrefixes?: string[],
): string | null {
	const trimmed = input.trim();

	if (provider === 'beads') {
		// A bare number only names an issue in databases old enough to have
		// sequential IDs. Hash-based ones never match, and the input falls
		// through to being treated as a description.
		if (isIssueNumber(trimmed)) {
			return `${teamPrefix.toLowerCase()}-${trimmed}`;
		}

		return isBeadsIssueKey(trimmed, beadsPrefixes ?? [teamPrefix])
			? trimmed.toLowerCase()
			: null;
	}

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
