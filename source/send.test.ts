// Tests for `pappardelle send` (pappardelle-tqq): resolving a space's Claude
// session on the inner socket and submitting a prompt to it.
import test from 'ava';
import {resolveSpaceKey} from './issue-utils.ts';
import {
	resolveInnerSessionTarget,
	sendToSpaceAgent,
	type OuterTmuxRunner,
} from './tmux.ts';

function makeRunner(options: {
	sessions?: string[];
	listFails?: boolean;
	failOn?: (args: readonly string[]) => boolean;
}): {runner: OuterTmuxRunner; sendKeysCalls: string[][]} {
	const sendKeysCalls: string[][] = [];
	const runner: OuterTmuxRunner = args => {
		if (args[0] === 'list-sessions') {
			if (options.listFails) {
				return {status: 1, stdout: ''};
			}

			return {status: 0, stdout: (options.sessions ?? []).join('\n') + '\n'};
		}

		sendKeysCalls.push([...args]);
		return {status: options.failOn?.(args) ? 1 : 0, stdout: ''};
	};

	return {runner, sendKeysCalls};
}

test('resolveInnerSessionTarget targets a dotted session with =name: so tmux does not read .17 as a pane', t => {
	const {runner} = makeRunner({sessions: ['claude-r-agc.17']});
	t.is(
		resolveInnerSessionTarget('claude-r-agc.17', runner),
		'=claude-r-agc.17:',
	);
});

test('resolveInnerSessionTarget finds a session whose dot tmux rewrote to _', t => {
	const {runner} = makeRunner({
		sessions: ['claude-r-main', 'claude-r-agc_17'],
	});
	t.is(
		resolveInnerSessionTarget('claude-r-agc.17', runner),
		'=claude-r-agc_17:',
	);
});

test('resolveInnerSessionTarget prefers the exact name over the _ spelling', t => {
	const {runner} = makeRunner({
		sessions: ['claude-r-agc_17', 'claude-r-agc.17'],
	});
	t.is(
		resolveInnerSessionTarget('claude-r-agc.17', runner),
		'=claude-r-agc.17:',
	);
});

test('resolveInnerSessionTarget does not prefix-match a longer session name', t => {
	const {runner} = makeRunner({sessions: ['claude-r-STA-12']});
	t.is(resolveInnerSessionTarget('claude-r-STA-1', runner), null);
});

test('resolveInnerSessionTarget returns null when no inner server is running', t => {
	const {runner} = makeRunner({listFails: true});
	t.is(resolveInnerSessionTarget('claude-r-STA-1', runner), null);
});

test('sendToSpaceAgent clears the line, types the text literally, then sends Enter as its own call', t => {
	const text = `it's "quoted" \`tick\` $HOME \\n; rm -rf nope`;
	const {runner, sendKeysCalls} = makeRunner({
		sessions: ['claude-r-agc.17'],
	});

	t.is(sendToSpaceAgent('agc.17', text, {repoName: 'r', runner}), 'sent');
	t.deepEqual(sendKeysCalls, [
		['send-keys', '-t', '=claude-r-agc.17:', 'C-u'],
		['send-keys', '-t', '=claude-r-agc.17:', '-l', text],
		['send-keys', '-t', '=claude-r-agc.17:', 'Enter'],
	]);
});

test('sendToSpaceAgent never sends Enter when typing the text fails', t => {
	const {runner, sendKeysCalls} = makeRunner({
		sessions: ['claude-r-STA-1'],
		failOn: args => args.includes('-l'),
	});

	t.is(sendToSpaceAgent('STA-1', 'hi', {repoName: 'r', runner}), 'failed');
	t.false(sendKeysCalls.some(args => args.includes('Enter')));
});

test('sendToSpaceAgent reports no-session and sends nothing when the space has no Claude session', t => {
	const {runner, sendKeysCalls} = makeRunner({
		sessions: ['companion-r-STA-1', 'claude-other-STA-1'],
	});

	t.is(sendToSpaceAgent('STA-1', 'hi', {repoName: 'r', runner}), 'no-session');
	t.deepEqual(sendKeysCalls, []);
});

test('resolveSpaceKey expands a bare number with the team prefix', t => {
	t.is(resolveSpaceKey('696', 'sta'), 'STA-696');
});

test('resolveSpaceKey uppercases a tracker key', t => {
	t.is(resolveSpaceKey('sta-696', 'STA'), 'STA-696');
});

test('resolveSpaceKey keeps a lowercase beads key as typed', t => {
	t.is(resolveSpaceKey('sausage-race-agc.17', 'STA'), 'sausage-race-agc.17');
	t.is(resolveSpaceKey(' pappardelle-tqq ', 'STA'), 'pappardelle-tqq');
});
