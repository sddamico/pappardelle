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
 * The issue-source prefix of an issue key — everything ahead of the final
 * segment. `STA-123` → `STA`, `bd-a1b2` → `bd`,
 * `seatgeek-ticket-management-cli-bqm` → `seatgeek-ticket-management-cli`.
 *
 * The split is on the *last* hyphen because a beads prefix may contain hyphens
 * of its own (it defaults to the repo directory name). That is equivalent to a
 * first-hyphen split for Linear and Jira, whose project keys cannot contain
 * one. A hierarchical `.N` child suffix is dropped first. An identifier with no
 * hyphen at all yields itself, so allowlist callers exclude it rather than
 * matching everything.
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
 * Beads breaks the PREFIX-NUMBER convention three ways: the suffix is a content
 * hash rather than a counter, the prefix itself may contain hyphens, and
 * hierarchical children append a `.N` segment per level, up to three deep.
 *
 * Because a hash can be pure letters (`sddamico-hic`), nothing about the shape
 * of `dark-mode` distinguishes it from an ID — so the match is anchored to the
 * prefixes the repo actually uses. Without that anchor, `pappardelle
 * "fix-crash"` would be sent to idow as an existing key and die on a lookup
 * instead of creating an issue. `hooks/tracker_config.py` anchors the same way.
 * With no known prefixes, nothing matches.
 */
export function isBeadsIssueKey(input: string, prefixes: string[]): boolean {
	const trimmed = input.trim();
	if (!/^[a-z\d]+(-[a-z\d]+)+(\.\d+){0,3}$/i.test(trimmed)) return false;
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
 * `provider` selects the key grammar. Beads IDs pass through verbatim: they are
 * lowercase by construction, and the uppercasing every other tracker wants
 * would yield an ID `bd` cannot resolve plus a worktree named unlike its issue.
 * `beadsPrefixes` are the ID prefixes this repo uses (see `getBeadsPrefixes`);
 * anything outside them is prose, not a key.
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
			? trimmed
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
