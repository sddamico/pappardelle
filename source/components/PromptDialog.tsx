import React, {useState, useMemo, useEffect} from 'react';
import {Box, Text, useInput, useStdout} from 'ink';
import TextInput from './TextInput.tsx';
import {truncateToWidth} from '../truncate-to-width.ts';
import {
	loadConfig,
	determineProfileForInput,
	type PappardelleConfig,
} from '../config.ts';
import {createIssueTracker} from '../providers/index.ts';
import type {TrackerIssue} from '../providers/types.ts';
import {
	INPUT_INDEX,
	moveSelection,
	resolveSubmission,
	visibleWindow,
} from './ready-picker.ts';

const MAX_VISIBLE_SUGGESTIONS = 8;

interface Props {
	onSubmit: (prompt: string, profileName: string | null) => void;
	onCancel: () => void;
}

export default function PromptDialog({onSubmit, onCancel}: Props) {
	const [prompt, setPrompt] = useState('');
	const [readyIssues, setReadyIssues] = useState<TrackerIssue[]>([]);
	// Resolved up front so trackers without a ready query never flash a loading
	// row on their way to rendering nothing.
	const [loadingReady, setLoadingReady] = useState(() => {
		try {
			return typeof createIssueTracker().listReadyIssues === 'function';
		} catch {
			return false;
		}
	});
	const [selectedIndex, setSelectedIndex] = useState(INPUT_INDEX);
	const {stdout} = useStdout();

	// Load config once
	const config = useMemo((): PappardelleConfig | null => {
		try {
			return loadConfig();
		} catch {
			return null;
		}
	}, []);

	// Trackers that can't answer "what's ready" cheaply leave listReadyIssues
	// undefined, which collapses the picker to nothing and leaves the dialog
	// exactly as it was before.
	useEffect(() => {
		let cancelled = false;

		const load = async () => {
			try {
				const tracker = createIssueTracker();
				const issues = (await tracker.listReadyIssues?.()) ?? [];
				if (!cancelled) setReadyIssues(issues);
			} catch {
				if (!cancelled) setReadyIssues([]);
			} finally {
				if (!cancelled) setLoadingReady(false);
			}
		};

		void load();
		return () => {
			cancelled = true;
		};
	}, []);

	const identifiers = useMemo(
		() => readyIssues.map(issue => issue.identifier),
		[readyIssues],
	);

	const visible = useMemo(
		() =>
			visibleWindow(selectedIndex, readyIssues.length, MAX_VISIBLE_SUGGESTIONS),
		[selectedIndex, readyIssues.length],
	);

	// The dialog's double border plus paddingX={2} eats 6 columns, and the row
	// prefix and issue key eat more; leaving slack keeps a long title from
	// wrapping and shoving the keybinding hint off screen.
	const titleWidth = Math.max(20, (stdout?.columns ?? 80) - 40);

	// What Enter would actually act on right now. Everything downstream — the
	// profile preview and the submit handler — keys off this rather than the
	// raw field, so arrowing into a suggestion updates the previewed profile
	// instead of leaving it describing text the user has moved away from.
	const effectiveInput =
		resolveSubmission(prompt, identifiers, selectedIndex) ?? '';

	// This must stay in lockstep with what we pass to idow — both the display
	// and the spawned command go through determineProfileForInput.
	const profileInfo = useMemo(() => {
		if (!config) return null;
		return determineProfileForInput(config, effectiveInput);
	}, [config, effectiveInput]);

	useInput((_input, key) => {
		if (key.escape) {
			onCancel();
			return;
		}

		if (key.downArrow || key.upArrow) {
			setSelectedIndex(current =>
				moveSelection(
					current,
					identifiers.length,
					key.downArrow ? 'down' : 'up',
				),
			);
		}
	});

	// Editing the field means the user is composing, not picking — drop back to
	// the input so Enter can't submit a suggestion they've scrolled away from.
	const handleChange = (value: string) => {
		setPrompt(value);
		setSelectedIndex(INPUT_INDEX);
	};

	const handleSubmit = (value: string) => {
		const trimmed = resolveSubmission(value, identifiers, selectedIndex);
		if (!trimmed) return;

		// Recompute against the submitted value rather than trusting stale state —
		// profileInfo is derived from the same resolved input, but being explicit
		// keeps the invariant local to this handler.
		// Deferred selections must forward null so idow's tracker_projects lookup runs
		// instead of being short-circuited by a forced --profile flag.
		const chosen = config ? determineProfileForInput(config, trimmed) : null;
		const forwardedName = chosen?.kind === 'resolved' ? chosen.name : null;
		onSubmit(trimmed, forwardedName);
	};

	return (
		<Box
			flexDirection="column"
			borderStyle="double"
			borderColor="green"
			paddingX={2}
			paddingY={1}
		>
			<Box marginBottom={1}>
				<Text bold color="green">
					+ New Session
				</Text>
			</Box>

			<Box marginBottom={1} flexDirection="column">
				<Text dimColor>Enter a prompt or issue key:</Text>
				<Text dimColor>
					- <Text color="cyan">STA-123</Text> or <Text color="cyan">123</Text> =
					open workspace for existing issue
				</Text>
				<Text dimColor>
					- <Text color="cyan">description</Text> = start new workspace with
					Claude
				</Text>
			</Box>

			<Box>
				<Text color="cyan">&gt; </Text>
				<TextInput
					value={prompt}
					onChange={handleChange}
					onSubmit={handleSubmit}
					isShowingCursor={selectedIndex === INPUT_INDEX}
					placeholder="STA-123, 123, or describe the task..."
				/>
			</Box>

			{loadingReady && (
				<Box marginTop={1}>
					<Text dimColor>Loading ready work…</Text>
				</Box>
			)}

			{readyIssues.length > 0 && (
				<Box marginTop={1} flexDirection="column">
					<Text dimColor>
						Ready work ({readyIssues.length}) — <Text color="cyan">↑↓</Text> to
						select:
					</Text>
					{readyIssues
						.slice(visible.start, visible.end)
						.map((issue, offset) => {
							const index = visible.start + offset;
							const isSelected = index === selectedIndex;
							return (
								<Box key={issue.identifier}>
									<Text color="green">{isSelected ? '❯ ' : '  '}</Text>
									<Text color={isSelected ? 'green' : 'cyan'} bold={isSelected}>
										{issue.identifier}
									</Text>
									<Text dimColor={!isSelected}>
										{' '}
										{truncateToWidth(issue.title, titleWidth)}
									</Text>
								</Box>
							);
						})}
					{visible.end < readyIssues.length && (
						<Text dimColor>
							{'  '}…{readyIssues.length - visible.end} more
						</Text>
					)}
				</Box>
			)}

			{profileInfo && (
				<Box marginTop={1}>
					<Text dimColor>Profile: </Text>
					{profileInfo.kind === 'deferred' ? (
						<Text dimColor italic>
							{profileInfo.displayName}
						</Text>
					) : (
						<>
							<Text color="blue">{profileInfo.displayName}</Text>
							{profileInfo.matchedKeywords.length > 0 && (
								<Text dimColor>
									{' '}
									← {profileInfo.matchedKeywords.join(', ')}
								</Text>
							)}
							{profileInfo.enforced && <Text color="magenta"> (enforced)</Text>}
							{profileInfo.isDefault &&
								profileInfo.matchedKeywords.length === 0 && (
									<Text dimColor> (default)</Text>
								)}
						</>
					)}
				</Box>
			)}

			<Box marginTop={1}>
				<Text dimColor>
					Press <Text color="green">Enter</Text> to start
					{selectedIndex === INPUT_INDEX ? '' : ' the selected issue'},{' '}
					<Text color="yellow">Esc</Text> to cancel
				</Text>
			</Box>
		</Box>
	);
}
