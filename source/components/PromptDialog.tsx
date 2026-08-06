import React, {useState, useMemo, useEffect} from 'react';
import {Box, Text, useInput, useStdout} from 'ink';
import TextInput from './TextInput.tsx';
import TitledBox from './TitledBox.tsx';
import ConfirmDialog from './ConfirmDialog.tsx';
import {dialogWidth} from './dialog-width.ts';
import {resolveEmojiSlot} from '../emoji-rail-width.ts';
import {truncateToWidth} from '../truncate-to-width.ts';
import {
	loadConfig,
	determineProfileForInput,
	type PappardelleConfig,
	type ProfileSelection,
} from '../config.ts';
import {createIssueTracker} from '../providers/index.ts';
import type {TrackerIssue} from '../providers/types.ts';
import {
	buildProfileOptions,
	computePickerWindow,
	focusFrame,
	handleProfilePickerKey,
	resolvePromptSubmit,
	PICKER_MAX_VISIBLE,
	type ProfileOption,
} from '../profile-picker.ts';
import {
	INPUT_INDEX,
	moveSelection,
	resolveSubmission,
	selectionAfterRemoval,
	visibleWindow,
} from './ready-picker.ts';

const MAX_VISIBLE_SUGGESTIONS = 8;

const CLOSE_KEY = 'x';

interface Props {
	onSubmit: (prompt: string, profileName: string | null) => void;
	onCancel: () => void;
	/**
	 * Columns available to the dialog. Callers inside tmux should pass the pane
	 * width — `stdout.columns` can be a full terminal-width stale value right
	 * after a split, which would run the hand-drawn top border past the pane
	 * edge and wrap it onto its own line.
	 */
	availableWidth?: number;
}

export default function PromptDialog({
	onSubmit,
	onCancel,
	availableWidth,
}: Props) {
	const [prompt, setPrompt] = useState('');
	// Both boxes are always on screen; this is purely which one has focus.
	const [isPicking, setIsPicking] = useState(false);
	const [selectedIndex, setSelectedIndex] = useState(0);

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
	// The prompt field and the ready list share one cursor: INPUT_INDEX means the
	// caret is in the text field, 0..n-1 point at a suggestion.
	const [readyIndex, setReadyIndex] = useState(INPUT_INDEX);
	// Trackers that can't close an issue locally leave closeIssue undefined; the
	// keybinding and its hint disappear rather than failing on the keystroke.
	const canClose = useMemo(() => {
		try {
			return typeof createIssueTracker().closeIssue === 'function';
		} catch {
			return false;
		}
	}, []);
	const [closeTarget, setCloseTarget] = useState<{
		issue: TrackerIssue;
		index: number;
	} | null>(null);
	const [closeError, setCloseError] = useState<string | null>(null);

	const {stdout} = useStdout();
	const width = dialogWidth(availableWidth, stdout?.columns);

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

	// What Enter would act on right now. Everything downstream — the profile
	// preview and the option list — keys off this rather than the raw field, so
	// arrowing into a suggestion re-aims them at the issue you are looking at.
	const effectiveInput =
		resolveSubmission(prompt, identifiers, readyIndex) ?? '';

	// Live preview of what the first Enter will do. Deferred inputs (issue keys)
	// still say so and still spawn on that one Enter; everything else advertises
	// the profile the picker will preselect.
	const preview = useMemo((): ProfileSelection | null => {
		if (!config) return null;
		return determineProfileForInput(config, effectiveInput);
	}, [config, effectiveInput]);
	const opensPicker = preview?.kind === 'resolved';

	// Derived from the current prompt rather than snapshotted on Enter, because
	// the list is visible while you type and has to re-rank as you go. Once the
	// picker takes focus the text input is frozen, so the list is stable for as
	// long as a selection can move within it.
	const options = useMemo(
		() => (config ? buildProfileOptions(config, effectiveInput) : []),
		[config, effectiveInput],
	);

	// While typing, the preselected row IS the answer the old "Profile:" line
	// used to spell out, so it always tracks the top of the list; the stored
	// index only matters once the picker has focus.
	const activeIndex = isPicking ? selectedIndex : 0;

	const visibleReady = useMemo(
		() =>
			visibleWindow(readyIndex, readyIssues.length, MAX_VISIBLE_SUGGESTIONS),
		[readyIndex, readyIssues.length],
	);

	// The frame and its padding eat columns, and the caret and issue key eat
	// more; leaving slack keeps a long title from wrapping past the border.
	const titleWidth = Math.max(20, width - 40);

	const isPromptStage = !isPicking && closeTarget === null;

	useInput(
		(input, key) => {
			if (key.escape) {
				onCancel();
				return;
			}

			if (key.downArrow || key.upArrow) {
				setReadyIndex(current =>
					moveSelection(
						current,
						identifiers.length,
						key.downArrow ? 'down' : 'up',
					),
				);
				return;
			}

			if (
				canClose &&
				input === CLOSE_KEY &&
				!key.ctrl &&
				!key.meta &&
				readyIndex >= 0
			) {
				const issue = readyIssues[readyIndex];
				if (issue) {
					setCloseError(null);
					setCloseTarget({issue, index: readyIndex});
				}
			}
		},
		{isActive: isPromptStage},
	);

	useInput(
		(input, key) => {
			const result = handleProfilePickerKey(
				input,
				key,
				selectedIndex,
				options.length,
			);
			switch (result.action) {
				case 'move': {
					setSelectedIndex(result.index);
					break;
				}

				case 'submit': {
					const chosen = options[result.index];
					if (chosen) onSubmit(effectiveInput.trim(), chosen.name);
					break;
				}

				case 'back': {
					// First Esc hands focus back to the prompt; a second one (handled by
					// the other useInput, now re-armed) cancels the dialog.
					setIsPicking(false);
					setSelectedIndex(0);
					break;
				}

				case 'ignore': {
					break;
				}
			}
		},
		{isActive: isPicking && closeTarget === null},
	);

	// Editing the field means the user is composing, not picking — drop back to
	// the input so Enter can't submit a suggestion they've scrolled away from.
	const handleChange = (value: string) => {
		setPrompt(value);
		setReadyIndex(INPUT_INDEX);
	};

	const handlePromptSubmit = (value: string) => {
		// A highlighted suggestion wins over whatever is in the field. It is
		// always an issue key, so resolvePromptSubmit routes it straight to
		// 'spawn' and the profile stays deferred to the fetched issue.
		const resolved = resolveSubmission(value, identifiers, readyIndex);
		if (resolved === null) return;

		const decision = resolvePromptSubmit(config, resolved);
		switch (decision.kind) {
			case 'none': {
				break;
			}

			case 'spawn': {
				onSubmit(resolved, decision.profileName);
				break;
			}

			case 'pick': {
				setIsPicking(true);
				setSelectedIndex(0);
				break;
			}
		}
	};

	const handleCloseConfirmed = async () => {
		if (!closeTarget) return;
		const {issue, index} = closeTarget;

		let closed = false;
		try {
			closed =
				(await createIssueTracker().closeIssue?.(issue.identifier)) ?? false;
		} catch {
			closed = false;
		}

		if (closed) {
			const remaining = readyIssues.filter(
				candidate => candidate.identifier !== issue.identifier,
			);
			setReadyIssues(remaining);
			setReadyIndex(selectionAfterRemoval(index, remaining.length));
		} else {
			setCloseError(`Could not close ${issue.identifier}`);
		}

		setCloseTarget(null);
	};

	if (closeTarget) {
		return (
			<ConfirmDialog
				title="Close Issue"
				message={`Close ${closeTarget.issue.identifier}?`}
				detail={closeTarget.issue.title}
				processingMessage={`Closing ${closeTarget.issue.identifier}…`}
				onConfirm={handleCloseConfirmed}
				onCancel={() => setCloseTarget(null)}
			/>
		);
	}

	// Three stacked frames now share the dialog, so the outline has to track the
	// cursor within the prompt stage too — arrowing into the ready list moves it
	// off the text field even though Enter still belongs to the same stage.
	const promptFrame = focusFrame(!isPicking && readyIndex === INPUT_INDEX);
	const readyFrame = focusFrame(!isPicking && readyIndex >= 0);
	const pickerFrame = focusFrame(isPicking);

	return (
		<Box flexDirection="column">
			<TitledBox
				title="+ New Session"
				borderColor="green"
				titleColor="greenBright"
				borderStyle={promptFrame.borderStyle}
				isDim={promptFrame.isDim}
				width={width}
			>
				<Box marginBottom={1} flexDirection="column">
					<Text dimColor>Enter a prompt or issue key:</Text>
					<Text dimColor>
						- <Text color="cyan">STA-123</Text> or <Text color="cyan">123</Text>{' '}
						= open workspace for existing issue
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
						onSubmit={handlePromptSubmit}
						placeholder="STA-123, 123, or describe the task..."
						isFocused={!isPicking}
						isShowingCursor={readyIndex === INPUT_INDEX}
						reservedChars={
							canClose && readyIndex >= 0 ? [CLOSE_KEY] : undefined
						}
					/>
				</Box>

				{closeError && (
					<Box marginTop={1}>
						<Text color="red">{closeError}</Text>
					</Box>
				)}

				{!isPicking && (
					<Box marginTop={1}>
						<Text dimColor>
							Press <Text color="green">Enter</Text> to{' '}
							{opensPicker ? 'choose a profile' : 'start'},{' '}
							<Text color="yellow">Esc</Text> to cancel
						</Text>
					</Box>
				)}
			</TitledBox>

			{loadingReady && (
				<Box paddingX={2}>
					<Text dimColor>Loading ready work…</Text>
				</Box>
			)}

			{readyIssues.length > 0 && (
				<TitledBox
					title={`Ready work (${readyIssues.length})`}
					borderColor="green"
					titleColor="greenBright"
					borderStyle={readyFrame.borderStyle}
					isDim={readyFrame.isDim}
					width={width}
					paddingY={0}
				>
					{visibleReady.start > 0 && (
						<Text dimColor>↑ {visibleReady.start} more</Text>
					)}
					{readyIssues
						.slice(visibleReady.start, visibleReady.end)
						.map((issue, offset) => {
							const index = visibleReady.start + offset;
							const isSelected = index === readyIndex;
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
					{visibleReady.end < readyIssues.length && (
						<Text dimColor>↓ {readyIssues.length - visibleReady.end} more</Text>
					)}
				</TitledBox>
			)}

			{readyIssues.length > 0 && !isPicking && (
				<Box paddingX={2}>
					<Text dimColor>
						<Text color="green">↑/↓</Text> pick up ready work
						{canClose && (
							<>
								{' · '}
								<Text color="green">x</Text> close
							</>
						)}
					</Text>
				</Box>
			)}

			<ProfilePicker
				options={options}
				selectedIndex={activeIndex}
				width={width}
				frame={pickerFrame}
				isFocused={isPicking}
				deferredLabel={
					preview?.kind === 'deferred' ? preview.displayName : undefined
				}
			/>
		</Box>
	);
}

function ProfilePicker({
	options,
	selectedIndex,
	width,
	frame,
	isFocused,
	deferredLabel,
}: {
	options: ProfileOption[];
	selectedIndex: number;
	width: number;
	frame: {borderStyle: 'double' | 'round'; isDim: boolean};
	isFocused: boolean;
	/**
	 * Set for issue-key / bare-number / Linear-URL inputs, where there is no
	 * choice to make — the profile comes from the fetched issue's tracker
	 * project. The box stays on screen (it always does) but shows a single
	 * inert row instead of a list, so it's visibly not somewhere Enter stops.
	 */
	deferredLabel?: string;
}) {
	const {start, end, above, below} = computePickerWindow(
		options.length,
		selectedIndex,
		PICKER_MAX_VISIBLE,
	);

	return (
		<Box flexDirection="column">
			<TitledBox
				title="Profile"
				borderColor="green"
				titleColor="greenBright"
				borderStyle={frame.borderStyle}
				isDim={frame.isDim}
				width={width}
				paddingY={0}
			>
				{deferredLabel ? (
					<Box>
						<Text dimColor>{'  '}</Text>
						<Text dimColor italic>
							{deferredLabel}
						</Text>
					</Box>
				) : null}
				{!deferredLabel && above > 0 && <Text dimColor>↑ {above} more</Text>}
				{!deferredLabel &&
					options.slice(start, end).map((option, offset) => {
						const index = start + offset;
						const isSelected = index === selectedIndex;
						// Same slot the ticket rail uses, so a profile wears the same
						// glyph wherever it appears. Sits right of the selection caret
						// (which owns column 0 for every row) and left of the label.
						const slot = resolveEmojiSlot(option.emoji);
						return (
							<Box key={option.name}>
								<Text
									color={isSelected ? 'green' : undefined}
									bold={isSelected}
								>
									{isSelected ? '❯ ' : '  '}
								</Text>
								{slot ? (
									<>
										<Text>{slot.text}</Text>
										{slot.needsSeparator ? <Text> </Text> : null}
									</>
								) : null}
								<Text
									color={isSelected ? 'green' : undefined}
									bold={isSelected}
								>
									{option.displayName}
								</Text>
								{option.matchedKeywords.length > 0 && (
									<Text dimColor> ← {option.matchedKeywords.join(', ')}</Text>
								)}
								{option.enforced && <Text color="magenta"> (enforced)</Text>}
								{option.isDefault && option.matchedKeywords.length === 0 && (
									<Text dimColor> (default)</Text>
								)}
							</Box>
						);
					})}
				{!deferredLabel && below > 0 && <Text dimColor>↓ {below} more</Text>}
			</TitledBox>

			{isFocused ? (
				<Box paddingX={2}>
					<Text dimColor>
						<Text color="green">↑/↓</Text> select ·{' '}
						<Text color="green">Enter</Text> start ·{' '}
						<Text color="yellow">Esc</Text> back
					</Text>
				</Box>
			) : null}
		</Box>
	);
}
