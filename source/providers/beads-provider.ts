// Beads issue tracker provider — wraps the `bd` CLI (git-native, local-first)
import {execFile} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {getMainRepoRoot} from '../config.ts';
import {issueKeyPrefix} from '../issue-utils.ts';
import {createLogger} from '../logger.ts';
import {sanitizeSubprocessError} from '../sanitize-error.ts';
import {displayPopup} from '../tmux.ts';
import {pLimit} from './concurrency.ts';
import {StateColorCache} from './state-color-cache.ts';
import type {IssueTrackerProvider, TrackerIssue} from './types.ts';

const execFileAsync = promisify(execFile);

const log = createLogger('beads-provider');
const CACHE_TTL_MS = 60_000;
export const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 500;

// `bd list`/`bd ready` cap results (50 and 100 respectively) unless told not to.
// The rail and the watchlist both want the complete set.
const NO_LIMIT = ['-n', '0'];

export function isEnoent(err: unknown): boolean {
	return (
		err instanceof Error &&
		'code' in err &&
		(err as NodeJS.ErrnoException).code === 'ENOENT'
	);
}

async function defaultSleep(ms: number): Promise<void> {
	return new Promise(resolve => {
		setTimeout(resolve, ms);
	});
}

interface CacheEntry {
	issue: TrackerIssue | null;
	timestamp: number;
}

/**
 * Beads status → hex color. Beads exposes no per-status color of its own, so
 * these are chosen to read the same way the Linear/Jira palettes do: gray for
 * untouched, blue for active, warm for stuck, green for done.
 */
const BEADS_STATUS_COLORS: Record<string, string> = {
	open: '#95a2b3',
	in_progress: '#4b9fea',
	blocked: '#f2994a',
	deferred: '#8b7fd4',
	closed: '#4caf50',
	pinned: '#e2b203',
	hooked: '#b57edc',
};

const FALLBACK_STATUS_COLOR = '#95a2b3';

/**
 * What `bd ready` can actually return. Its help is explicit: "Excludes
 * in_progress, blocked, deferred, and hooked issues." Both the raw status and
 * the display name are listed so a watchlist configured either way is checked.
 */
const READY_STATUSES = new Set(['open']);

/**
 * Which of the configured watchlist statuses `bd ready` can never return.
 * A watchlist carried over from Linear or Jira ("In Progress") would otherwise
 * sit permanently empty with nothing to explain it.
 */
export function unreachableReadyStatuses(statuses: string[]): string[] {
	return statuses.filter(s => {
		const normalized = s.trim().toLowerCase().replace(/\s+/g, '_');
		return normalized !== '' && !READY_STATUSES.has(normalized);
	});
}

/**
 * `auto_remove_when_done` keys off the Linear-flavored state types in
 * `auto-remove.ts` (`completed`/`canceled`), so beads' terminal status has to
 * be reported under that name. Every other status passes through verbatim —
 * beads supports user-defined statuses via its `status.custom` config key and
 * an unknown one must never throw.
 */
export function beadsStateType(status: string): string {
	return status === 'closed' ? 'completed' : status;
}

export function beadsStateName(status: string): string {
	return status
		.split('_')
		.map(word => (word ? word[0]!.toUpperCase() + word.slice(1) : word))
		.join(' ');
}

/**
 * The issue-source prefix of a beads ID — everything ahead of the hash.
 *
 * Beads IDs are `<prefix>-<hash>` with an optional `.N` suffix per nesting
 * level (`sddamico-hic`, `seatgeek-ticket-management-cli-bqm`, `bd-a3f8e9.1`).
 * One database routinely holds several prefixes, which is what makes prefix
 * matching a usable stand-in for Linear/Jira's project field. Unlike the shared
 * `issueKeyPrefix`, a prefixless ID reports no prefix at all rather than
 * itself, so `mapBeadsIssue` can leave `project` null.
 */
export function beadsIssuePrefix(issueId: string): string {
	const prefix = issueKeyPrefix(issueId);
	return prefix === issueId.split('.')[0] ? '' : prefix;
}

/**
 * Pull the payload out of `bd`'s JSON, tolerating every shape it ships.
 *
 * Current releases print the bare value; `BD_JSON_ENVELOPE=1` (and beads 2.0 by
 * default) wraps it as `{schema_version, data}`. Single-issue commands like
 * `bd show` return a one-element *array*, not an object, despite what the
 * schema doc says. Callers get a list either way.
 */
export function unwrapBeadsJson(
	stdout: string,
): Array<Record<string, unknown>> {
	const parsed = JSON.parse(stdout) as unknown;
	const payload =
		parsed !== null &&
		typeof parsed === 'object' &&
		!Array.isArray(parsed) &&
		'data' in parsed
			? (parsed as {data: unknown}).data
			: parsed;

	if (Array.isArray(payload)) {
		return payload.filter(
			(item): item is Record<string, unknown> =>
				item !== null && typeof item === 'object',
		);
	}

	if (payload !== null && typeof payload === 'object') {
		return [payload as Record<string, unknown>];
	}

	return [];
}

export function mapBeadsIssue(raw: Record<string, unknown>): TrackerIssue {
	const identifier = (raw['id'] as string) ?? '';
	const status = (raw['status'] as string) ?? 'open';
	const prefix = beadsIssuePrefix(identifier);

	const rawLabels = raw['labels'];
	const labels = Array.isArray(rawLabels)
		? (rawLabels as unknown[]).filter((l): l is string => typeof l === 'string')
		: undefined;

	return {
		identifier,
		title: (raw['title'] as string) ?? '',
		state: {
			name: beadsStateName(status),
			type: beadsStateType(status),
			color: BEADS_STATUS_COLORS[status] ?? FALLBACK_STATUS_COLOR,
		},
		// Beads has no project field; the ID prefix is its issue-source
		// partition, so it fills both slots that `tracker_projects` matches on.
		project: prefix ? {name: prefix, key: prefix} : null,
		labels,
	};
}

export type CliExecutor = (
	command: string,
	args: string[],
	options: {
		encoding: BufferEncoding;
		timeout: number;
		cwd: string;
		env: NodeJS.ProcessEnv;
	},
) => Promise<string>;

export type SleepFn = (ms: number) => Promise<void>;

export class BeadsProvider implements IssueTrackerProvider {
	get name() {
		return 'beads';
	}

	private readonly issueCache = new Map<string, CacheEntry>();
	private readonly stateColors: StateColorCache;
	private readonly execCli: CliExecutor;
	private readonly sleepFn: SleepFn;
	private readonly resolveCwd: () => string;
	private bdMissing = false;

	constructor(
		execCli?: CliExecutor,
		sleepFn?: SleepFn,
		stateColorCache?: StateColorCache,
		resolveCwd?: () => string,
	) {
		this.execCli =
			execCli ??
			(async (cmd, args, opts) => {
				const {stdout} = await execFileAsync(cmd, args, opts);
				return stdout;
			});
		this.sleepFn = sleepFn ?? defaultSleep;
		this.stateColors = stateColorCache ?? new StateColorCache();
		this.resolveCwd = resolveCwd ?? getMainRepoRoot;
	}

	/**
	 * Every `bd` call runs from the main repo root — not the worktree, which
	 * carries its own checked-out `.beads/` that bd would auto-discover — so
	 * all workspaces read and write the one canonical database. Asks for the
	 * enveloped JSON so the shape stays stable across the 2.0 default flip.
	 * Only stdout is parsed: pre-2.0 releases put a deprecation notice for
	 * bare `--json` on stderr.
	 */
	private async runBd(args: string[], timeout: number): Promise<string> {
		return this.execCli('bd', args, {
			encoding: 'utf-8',
			timeout,
			cwd: this.resolveCwd(),
			env: {...process.env, BD_JSON_ENVELOPE: '1'},
		});
	}

	private cache(issue: TrackerIssue): void {
		this.issueCache.set(issue.identifier, {issue, timestamp: Date.now()});
		this.stateColors.update(issue.state.name, issue.state.color);
	}

	private noteMissing(action: string): void {
		this.bdMissing = true;
		log.warn(
			`bd binary not found on PATH — beads ${action} disabled. Install beads or check your PATH.`,
		);
	}

	async getIssue(issueKey: string): Promise<TrackerIssue | null> {
		if (this.bdMissing) {
			return this.issueCache.get(issueKey)?.issue ?? null;
		}

		const cached = this.issueCache.get(issueKey);
		if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
			if (cached.issue) {
				this.stateColors.update(
					cached.issue.state.name,
					cached.issue.state.color,
				);
			}

			return cached.issue;
		}

		let lastError: unknown;
		for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
			try {
				// `--id=` rather than a positional: beads IDs can begin with a
				// character run that the flag parser would claim.
				const output = await this.runBd(
					['show', `--id=${issueKey}`, '--json'],
					20_000,
				);
				const rows = unwrapBeadsJson(output);
				const row =
					rows.find(r => r['id'] === issueKey) ?? rows[0] ?? undefined;
				if (!row) {
					this.issueCache.set(issueKey, {issue: null, timestamp: Date.now()});
					return null;
				}

				const issue = mapBeadsIssue(row);
				this.cache(issue);
				log.debug(`Fetched beads issue ${issueKey}: ${issue.title}`);
				return issue;
			} catch (err) {
				if (isEnoent(err)) {
					this.noteMissing('issue fetching');
					this.issueCache.set(issueKey, {issue: null, timestamp: Date.now()});
					return null;
				}

				lastError = err;
				if (attempt < MAX_RETRIES) {
					log.debug(
						`Fetch beads issue ${issueKey} failed (attempt ${attempt}/${MAX_RETRIES}), retrying…`,
					);
					await this.sleepFn(RETRY_DELAY_MS);
				}
			}
		}

		log.warn(
			`Failed to fetch beads issue ${issueKey} after ${MAX_RETRIES} attempts`,
			sanitizeSubprocessError(lastError),
		);
		this.issueCache.set(issueKey, {issue: null, timestamp: Date.now()});
		return null;
	}

	async getIssues(
		issueKeys: string[],
	): Promise<Map<string, TrackerIssue | null>> {
		const results = new Map<string, TrackerIssue | null>();
		if (issueKeys.length === 0) return results;

		if (this.bdMissing) {
			for (const key of issueKeys) {
				results.set(key, this.issueCache.get(key)?.issue ?? null);
			}

			return results;
		}

		try {
			const output = await this.runBd(
				['list', '--id', issueKeys.join(','), '--json', ...NO_LIMIT],
				30_000,
			);
			const found = new Set<string>();

			for (const row of unwrapBeadsJson(output)) {
				const issue = mapBeadsIssue(row);
				if (!issue.identifier) continue;
				found.add(issue.identifier);
				results.set(issue.identifier, issue);
				this.cache(issue);
			}

			const unresolved = issueKeys.filter(key => !found.has(key));
			if (unresolved.length > 0) {
				const fetched = await pLimit(
					unresolved.map(
						key => async () =>
							this.getIssue(key).then(
								issue => [key, issue] as [string, TrackerIssue | null],
							),
					),
					3,
				);
				for (const entry of fetched) {
					if (entry) results.set(entry[0], entry[1]);
				}
			}

			return results;
		} catch (err) {
			if (isEnoent(err)) {
				this.noteMissing('issue fetching');
				for (const key of issueKeys) {
					results.set(key, this.issueCache.get(key)?.issue ?? null);
				}

				return results;
			}

			log.debug('Batch bd list failed, falling back to individual fetches');
		}

		const fetched = await pLimit(
			issueKeys.map(
				key => async () =>
					this.getIssue(key).then(
						issue => [key, issue] as [string, TrackerIssue | null],
					),
			),
			3,
		);
		for (const entry of fetched) {
			if (entry) results.set(entry[0], entry[1]);
		}

		return results;
	}

	getIssueCached(issueKey: string): TrackerIssue | null {
		return this.issueCache.get(issueKey)?.issue ?? null;
	}

	getWorkflowStateColor(stateName: string): string | null {
		return (
			this.stateColors.get(stateName) ??
			BEADS_STATUS_COLORS[stateName.toLowerCase().replace(/\s+/g, '_')] ??
			null
		);
	}

	clearCache(): void {
		this.issueCache.clear();
	}

	/**
	 * Beads issues are local — there is nothing to open in a browser. The rail's
	 * `o` key goes through `openIssue()` instead; this stays empty so any caller
	 * that still reaches for a URL degrades to "no link" rather than launching a
	 * browser at a bogus address.
	 */
	buildIssueUrl(): string {
		return '';
	}

	openIssue(issueKey: string): boolean {
		return displayPopup(['bd', 'show', `--id=${issueKey}`, '--long']);
	}

	/**
	 * Watchlist source. `bd ready` is beads' own notion of actionable work —
	 * open issues whose blocking dependencies are all closed — which is a
	 * stronger filter than a status query and the reason it's used here instead
	 * of `bd list --status`. A configured `statuses` list narrows further;
	 * omitting it takes every ready issue.
	 */
	async searchAssignedIssues(
		assignee: string | undefined,
		statuses: string[],
	): Promise<TrackerIssue[]> {
		if (this.bdMissing) return [];

		const args = ['ready', '--json', ...NO_LIMIT];
		const who = assignee === 'me' ? this.currentUser() : assignee;
		if (who) args.push('--assignee', who);

		const wanted = new Set(statuses.map(s => s.trim().toLowerCase()));
		log.info(
			`Watchlist query: bd ready${who ? ` --assignee ${who}` : ''}${
				wanted.size > 0 ? ` (statuses: ${statuses.join(', ')})` : ''
			}`,
		);

		const unreachable = unreachableReadyStatuses(statuses);
		if (unreachable.length > 0) {
			log.warn(
				`issue_watchlist.statuses includes ${unreachable.join(', ')}, which \`bd ready\` never returns — it excludes in_progress, blocked, deferred and hooked issues. Those statuses will match nothing.`,
			);
		}

		try {
			const output = await this.runBd(args, 30_000);
			const results: TrackerIssue[] = [];

			for (const row of unwrapBeadsJson(output)) {
				try {
					const issue = mapBeadsIssue(row);
					if (!issue.identifier) continue;
					if (
						wanted.size > 0 &&
						!wanted.has(issue.state.type.toLowerCase()) &&
						!wanted.has(issue.state.name.toLowerCase())
					) {
						continue;
					}

					results.push(issue);
					this.cache(issue);
				} catch {
					// Skip malformed issues, preserve valid ones
				}
			}

			if (results.length > 0) {
				log.info(
					`Watchlist results: ${results.map(i => `${i.identifier} (${i.state.name})`).join(', ')}`,
				);
			} else {
				log.info('Watchlist results: none');
			}

			return results;
		} catch (err) {
			if (isEnoent(err)) {
				this.noteMissing('issue search');
				return [];
			}

			log.warn('Failed to search beads issues', sanitizeSubprocessError(err));
			return [];
		}
	}

	/**
	 * Suggestion source for the new-session prompt. Unlike the watchlist, this
	 * takes no assignee filter: the picker exists to answer "what could I start
	 * next", and beads issues are frequently unassigned until someone claims
	 * them, so filtering by assignee would usually empty the list.
	 */
	async listReadyIssues(): Promise<TrackerIssue[]> {
		if (this.bdMissing) return [];

		try {
			const output = await this.runBd(['ready', '--json', ...NO_LIMIT], 10_000);
			const results: TrackerIssue[] = [];

			for (const row of unwrapBeadsJson(output)) {
				try {
					const issue = mapBeadsIssue(row);
					if (!issue.identifier) continue;
					results.push(issue);
					this.cache(issue);
				} catch {
					// Skip malformed issues, preserve valid ones
				}
			}

			return results;
		} catch (err) {
			if (isEnoent(err)) {
				this.noteMissing('ready issue listing');
				return [];
			}

			log.warn('Failed to list ready beads issues', sanitizeSubprocessError(err));
			return [];
		}
	}

	async createComment(issueKey: string, body: string): Promise<boolean> {
		if (this.bdMissing) return false;

		// Via a file rather than an argv entry: comment bodies are whole Q&A
		// transcripts, well past a comfortable argument length.
		let bodyPath: string | undefined;
		try {
			bodyPath = path.join(
				os.tmpdir(),
				`pappardelle-beads-comment-${process.pid}-${Date.now()}.md`,
			);
			fs.writeFileSync(bodyPath, body);
		} catch (err) {
			log.warn(
				'Failed to stage beads comment body',
				sanitizeSubprocessError(err),
			);
			return false;
		}

		try {
			let lastError: unknown;
			for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
				try {
					await this.runBd(
						['comments', 'add', issueKey, '-f', bodyPath],
						30_000,
					);
					return true;
				} catch (err) {
					if (isEnoent(err)) {
						this.noteMissing('comment posting');
						return false;
					}

					lastError = err;
					if (attempt < MAX_RETRIES) {
						log.debug(
							`Post comment on beads ${issueKey} failed (attempt ${attempt}/${MAX_RETRIES}), retrying…`,
						);
						await this.sleepFn(RETRY_DELAY_MS);
					}
				}
			}

			log.warn(
				`Failed to post comment on beads ${issueKey} after ${MAX_RETRIES} attempts`,
				sanitizeSubprocessError(lastError),
			);
			return false;
		} finally {
			try {
				fs.unlinkSync(bodyPath);
			} catch {
				// Best effort — the temp file is harmless if it survives
			}
		}
	}

	/**
	 * `assignee: me` in the watchlist config. Beads assignees are free text and
	 * default to the git identity, so that's what "me" resolves to.
	 */
	private currentUser(): string | undefined {
		return (
			process.env['BEADS_ACTOR'] ??
			process.env['USER'] ??
			process.env['LOGNAME'] ??
			undefined
		);
	}
}
