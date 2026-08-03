import test from 'ava';
import {
	isBeadsIssueKey,
	issueKeyPrefix,
	isLinearIssueKey,
	isIssueKey,
	isIssueNumber,
	normalizeIssueIdentifier,
} from './issue-utils.ts';

// ============================================================================
// isLinearIssueKey Tests
// ============================================================================

test('isLinearIssueKey returns true for standard format STA-123', t => {
	t.true(isLinearIssueKey('STA-123'));
});

test('isLinearIssueKey returns true for lowercase sta-123', t => {
	t.true(isLinearIssueKey('sta-123'));
});

test('isLinearIssueKey returns true for mixed case Sta-456', t => {
	t.true(isLinearIssueKey('Sta-456'));
});

test('isLinearIssueKey returns true with whitespace padding', t => {
	t.true(isLinearIssueKey('  STA-789  '));
});

test('isLinearIssueKey returns false for bare numbers', t => {
	t.false(isLinearIssueKey('400'));
});

test('isLinearIssueKey returns false for empty string', t => {
	t.false(isLinearIssueKey(''));
});

test('isLinearIssueKey returns true for alphanumeric prefix B2B-100', t => {
	t.true(isLinearIssueKey('B2B-100'));
});

test('isLinearIssueKey returns true for alphanumeric prefix A1-50', t => {
	t.true(isLinearIssueKey('A1-50'));
});

test('isLinearIssueKey returns false for number-only prefix 123-456', t => {
	t.false(isLinearIssueKey('123-456'));
});

test('isLinearIssueKey returns false for descriptions', t => {
	t.false(isLinearIssueKey('fix the bug'));
});

// ============================================================================
// isIssueNumber Tests
// ============================================================================

test('isIssueNumber returns true for bare number 400', t => {
	t.true(isIssueNumber('400'));
});

test('isIssueNumber returns true for bare number with whitespace', t => {
	t.true(isIssueNumber('  123  '));
});

test('isIssueNumber returns true for single digit', t => {
	t.true(isIssueNumber('1'));
});

test('isIssueNumber returns false for STA-123', t => {
	t.false(isIssueNumber('STA-123'));
});

test('isIssueNumber returns false for text', t => {
	t.false(isIssueNumber('abc'));
});

test('isIssueNumber returns false for mixed', t => {
	t.false(isIssueNumber('123abc'));
});

test('isIssueNumber returns false for empty string', t => {
	t.false(isIssueNumber(''));
});

test('isIssueNumber returns false for negative number', t => {
	t.false(isIssueNumber('-123'));
});

test('isIssueNumber returns false for decimal', t => {
	t.false(isIssueNumber('12.3'));
});

// ============================================================================
// normalizeIssueIdentifier Tests
// ============================================================================

test('normalizeIssueIdentifier returns uppercase STA-400 for bare number 400', t => {
	t.is(normalizeIssueIdentifier('400', 'STA'), 'STA-400');
});

test('normalizeIssueIdentifier returns uppercase STA-123 for lowercase sta-123', t => {
	t.is(normalizeIssueIdentifier('sta-123', 'STA'), 'STA-123');
});

test('normalizeIssueIdentifier returns uppercase for mixed case Sta-456', t => {
	t.is(normalizeIssueIdentifier('Sta-456', 'STA'), 'STA-456');
});

test('normalizeIssueIdentifier trims whitespace', t => {
	t.is(normalizeIssueIdentifier('  400  ', 'STA'), 'STA-400');
	t.is(normalizeIssueIdentifier('  STA-400  ', 'STA'), 'STA-400');
});

test('normalizeIssueIdentifier returns null for descriptions', t => {
	t.is(normalizeIssueIdentifier('fix the bug', 'STA'), null);
});

test('normalizeIssueIdentifier returns null for empty string', t => {
	t.is(normalizeIssueIdentifier('', 'STA'), null);
});

test('normalizeIssueIdentifier works with different team prefixes', t => {
	t.is(normalizeIssueIdentifier('100', 'ENG'), 'ENG-100');
	t.is(normalizeIssueIdentifier('eng-100', 'ENG'), 'ENG-100');
});

test('normalizeIssueIdentifier preserves original team prefix when different from default', t => {
	// If user types ENG-100 but default is STA, keep ENG-100
	t.is(normalizeIssueIdentifier('ENG-100', 'STA'), 'ENG-100');
});

test('normalizeIssueIdentifier works with alphanumeric prefixes', t => {
	t.is(normalizeIssueIdentifier('b2b-100', 'B2B'), 'B2B-100');
	t.is(normalizeIssueIdentifier('B2B-200', 'STA'), 'B2B-200');
	t.is(normalizeIssueIdentifier('100', 'B2B'), 'B2B-100');
});

// ============================================================================
// isIssueKey Tests (provider-agnostic alias)
// ============================================================================

test('isIssueKey is an alias for isLinearIssueKey', t => {
	t.is(isIssueKey, isLinearIssueKey);
});

test('isIssueKey works for standard format', t => {
	t.true(isIssueKey('STA-123'));
	t.true(isIssueKey('PROJ-456'));
	t.false(isIssueKey('fix bug'));
	t.false(isIssueKey('400'));
});

// ============================================================================
// issueKeyPrefix Tests
// ============================================================================

test('issueKeyPrefix splits on the last hyphen', t => {
	t.is(issueKeyPrefix('STA-123'), 'STA');
	t.is(issueKeyPrefix('bd-a1b2'), 'bd');
});

test('issueKeyPrefix keeps hyphens inside a beads prefix', t => {
	// Splitting on the first hyphen instead silently broke watchlist filtering
	// for these repos.
	t.is(
		issueKeyPrefix('seatgeek-ticket-management-cli-bqm'),
		'seatgeek-ticket-management-cli',
	);
});

test('issueKeyPrefix drops a hierarchical child suffix', t => {
	t.is(issueKeyPrefix('bd-a3f8e9.1'), 'bd');
	t.is(issueKeyPrefix('bd-a3f8e9.1.2'), 'bd');
});

test('issueKeyPrefix yields the whole string when there is no hyphen', t => {
	// Allowlist callers then exclude it rather than matching everything.
	t.is(issueKeyPrefix('nohyphen'), 'nohyphen');
});

// ============================================================================
// isBeadsIssueKey Tests
// ============================================================================

test('isBeadsIssueKey accepts hash-suffixed IDs of a known prefix', t => {
	t.true(isBeadsIssueKey('bd-a1b2', ['bd']));
	t.true(isBeadsIssueKey('sddamico-hic', ['sddamico']));
});

test('isBeadsIssueKey accepts a prefix containing hyphens', t => {
	// The prefix defaults to the repo directory name.
	t.true(
		isBeadsIssueKey('seatgeek-ticket-management-cli-bqm', [
			'seatgeek-ticket-management-cli',
		]),
	);
});

test('isBeadsIssueKey accepts hierarchical child IDs', t => {
	t.true(isBeadsIssueKey('bd-a3f8e9.1', ['bd']));
	t.true(isBeadsIssueKey('bd-a3f8e9.1.2.3', ['bd']));
});

test('isBeadsIssueKey rejects nesting deeper than beads allows', t => {
	t.false(isBeadsIssueKey('bd-a3f8e9.1.2.3.4', ['bd']));
});

test('isBeadsIssueKey rejects a hyphenated phrase that is not a known prefix', t => {
	// A beads hash can be pure letters, so shape alone cannot tell 'dark-mode'
	// from an ID — without the prefix anchor these would be sent to idow as
	// existing keys and die on a lookup instead of creating an issue.
	t.false(isBeadsIssueKey('dark-mode', ['bd']));
	t.false(isBeadsIssueKey('fix-crash', ['bd']));
});

test('isBeadsIssueKey matches the prefix case-insensitively', t => {
	t.true(isBeadsIssueKey('BD-A1B2', ['bd']));
	t.true(isBeadsIssueKey('bd-a1b2', ['BD']));
});

test('isBeadsIssueKey rejects everything when no prefixes are known', t => {
	t.false(isBeadsIssueKey('bd-a1b2', []));
});

test('isBeadsIssueKey rejects prose and bare numbers', t => {
	t.false(isBeadsIssueKey('fix the bug', ['bd']));
	t.false(isBeadsIssueKey('400', ['bd']));
	t.false(isBeadsIssueKey('nohyphen', ['bd']));
});

// ============================================================================
// normalizeIssueIdentifier — beads
// ============================================================================

test('normalizeIssueIdentifier keeps beads IDs verbatim', t => {
	// Uppercasing would yield an ID bd cannot resolve and a worktree named
	// unlike its issue.
	t.is(normalizeIssueIdentifier('bd-a1b2', 'bd', 'beads'), 'bd-a1b2');
	t.is(
		normalizeIssueIdentifier('sddamico-hic', 'sddamico', 'beads'),
		'sddamico-hic',
	);
});

test('normalizeIssueIdentifier keeps beads child IDs intact', t => {
	t.is(normalizeIssueIdentifier('bd-a3f8e9.1', 'bd', 'beads'), 'bd-a3f8e9.1');
});

test('normalizeIssueIdentifier accepts a beads ID from any known prefix', t => {
	t.is(
		normalizeIssueIdentifier('vendor-sdk-hic', 'bd', 'beads', [
			'bd',
			'vendor-sdk',
		]),
		'vendor-sdk-hic',
	);
});

test('normalizeIssueIdentifier treats an unknown-prefix phrase as a description', t => {
	t.is(normalizeIssueIdentifier('dark-mode', 'bd', 'beads'), null);
});

test('normalizeIssueIdentifier lowercases the prefix for a bare beads number', t => {
	// Only resolves in databases old enough to have sequential IDs, but the
	// prefix is lowercase either way.
	t.is(normalizeIssueIdentifier('42', 'BD', 'beads'), 'bd-42');
});

test('normalizeIssueIdentifier returns null for beads descriptions', t => {
	t.is(normalizeIssueIdentifier('fix the bug', 'bd', 'beads'), null);
});

test('normalizeIssueIdentifier still uppercases for linear and jira', t => {
	// Regression pin: adding the beads grammar must not touch the others.
	t.is(normalizeIssueIdentifier('sta-123', 'STA', 'linear'), 'STA-123');
	t.is(normalizeIssueIdentifier('sta-123', 'STA', 'jira'), 'STA-123');
	t.is(normalizeIssueIdentifier('sta-123', 'STA'), 'STA-123');
});
