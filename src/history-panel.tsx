import { useCallback, useEffect, useMemo, useState, type ComponentType, type FormEvent } from 'react'
import { BookmarkIcon, BotIcon, ChevronLeftIcon, ChevronRightIcon, FlagIcon, HistoryIcon, RotateCcwIcon } from 'lucide-react'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { PanelError, PanelNotice, SidePanel } from './side-panel'
import { cn } from 'cn'

// The evolution of a document, for every host (docs/shell.md): every saved version, newest
// first and grouped by day. Choosing one shows it read-only, either in `Preview` over the
// host's stage or wherever the host draws it from `onPreview`; restoring puts it back after
// saving the present, so it can always be undone from this list. The rows are what
// ./server/history lists; the host supplies the calls, so this never fetches a URL itself.

export type VersionRow = { n: number; t: string; source: string; label?: string; named?: boolean; request?: string; count: number; added: number; updated: number; removed: number; keys: string[] }
export type VersionPreview = ComponentType<{ data: any; version: VersionRow }>
export type RestoreResult = { unchanged?: boolean; undo?: number | null; note?: string } | void

const day = (t: string) => new Date(t).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
const time = (t: string) => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
const plural = (n: number, s: string) => `${n} ${s}${n === 1 ? '' : 's'}`

function stepTitle(v: VersionRow) {
	if (v.label) return v.label
	return v.source === 'agent' ? 'Agent edit' : v.source === 'checkpoint' ? 'Before a request' : 'Edits'
}

export type HistoryWords = {
	/** What the document is called: canvas, page. */
	document: string
	/** What its parts are called: shape, section. */
	part: string
	/** After a restore: "for everyone". */
	restoredFor: string
	/** Under the restore button. */
	restoreNote: string
	/** With no versions yet. */
	empty: string
	/** The restore button. */
	restore: (n: number) => string
}
const WORDS: HistoryWords = {
	document: 'canvas',
	part: 'shape',
	restoredFor: 'for everyone',
	restoreNote: "What's there now is saved first.",
	empty: 'No versions yet. One is saved shortly after the next edit, or name this moment above.',
	restore: (n) => `Restore v${n}`,
}

export function HistoryPanel({ loadVersions, readVersion, restoreVersion, saveVersion, Preview, onPreview, onClose, words, pollMs = 6000, placement = 'stage' }: {
	loadVersions: () => Promise<{ versions: VersionRow[]; current: boolean }>
	readVersion: (n: number) => Promise<{ data: any }>
	/** Puts version n back. Return `undo` (the version to go back to) to offer an Undo, `note` to say something else. */
	restoreVersion: (n: number) => Promise<RestoreResult>
	/** Names the present moment. Leave out to hide the field. */
	saveVersion?: (label: string) => Promise<unknown>
	/** Drawn over the host's stage, read-only, beside the panel. */
	Preview?: VersionPreview
	/** For a host that shows a version itself: called with the version and its data, and with null to go back to the live document. */
	onPreview?: (shown: { version: VersionRow; data: any } | null) => void
	onClose: () => void
	words?: Partial<HistoryWords>
	pollMs?: number
	placement?: 'stage' | 'page'
}) {
	const w = { ...WORDS, ...words }
	const [versions, setVersions] = useState<VersionRow[] | null>(null)
	const [current, setCurrent] = useState(true)
	const [selected, setSelected] = useState<number | null>(null) // null: the live document
	const [data, setData] = useState<{ n: number; data: any } | null>(null)
	const [name, setName] = useState('')
	const [error, setError] = useState('')
	const [restored, setRestored] = useState<{ n: number; undo: number | null; note?: string } | null>(null)
	const fail = (e: any) => setError(String(e?.message ?? e))

	const load = useCallback(() => loadVersions().then((r) => (setVersions(r.versions), setCurrent(r.current)), fail), [loadVersions])
	useEffect(() => {
		load()
		if (!pollMs) return
		const t = setInterval(load, pollMs)
		return () => clearInterval(t)
	}, [load, pollMs])

	useEffect(() => {
		if (selected === null) return setData(null)
		let stale = false
		readVersion(selected).then((v) => !stale && setData({ n: selected, data: v.data }), (e) => !stale && fail(e))
		return () => {
			stale = true
		}
	}, [selected])

	const shown = versions?.find((v) => v.n === selected)
	useEffect(() => {
		if (!onPreview) return
		onPreview(shown && data && data.n === shown.n ? { version: shown, data: data.data } : null)
	}, [shown, data])
	useEffect(() => () => onPreview?.(null), [])

	// Stepping: older and newer, where "newer" from the newest version comes back to the live document.
	const index = versions && selected !== null ? versions.findIndex((v) => v.n === selected) : -1
	const older = () => versions?.length && setSelected(versions[Math.min(index + 1, versions.length - 1)].n)
	const newer = () => versions && setSelected(index > 0 ? versions[index - 1].n : null)
	useEffect(() => {
		const typing = (e: Event) => !!(e.composedPath()[0] as HTMLElement)?.closest?.('input, textarea, [contenteditable]')
		const onKey = (e: KeyboardEvent) => {
			if (typing(e)) return
			if (e.key === 'Escape') selected === null ? onClose() : setSelected(null)
			else if (e.key === 'ArrowLeft') older()
			else if (e.key === 'ArrowRight') newer()
			else {
				// Read-only means it: with a version on screen, no shortcut reaches the live editor beneath.
				if (selected !== null) e.stopPropagation()
				return
			}
			e.preventDefault()
			e.stopPropagation()
		}
		const shield = (e: Event) => {
			if (selected !== null && !typing(e)) e.stopPropagation()
		}
		window.addEventListener('keydown', onKey, true)
		for (const type of ['keyup', 'paste', 'cut', 'copy']) window.addEventListener(type, shield, true)
		return () => {
			window.removeEventListener('keydown', onKey, true)
			for (const type of ['keyup', 'paste', 'cut', 'copy']) window.removeEventListener(type, shield, true)
		}
	})

	async function save(e: FormEvent) {
		e.preventDefault()
		if (!name.trim() || !saveVersion) return
		try {
			await saveVersion(name.trim())
			setName('')
			load()
		} catch (err) {
			fail(err)
		}
	}
	async function restore(n: number) {
		try {
			const v = (await restoreVersion(n)) || {}
			await load()
			setSelected(null)
			setRestored(v.unchanged ? null : { n, undo: v.undo ?? null, note: v.note })
		} catch (err) {
			fail(err)
		}
	}

	const rows = useMemo(() => {
		const out: ({ day: string } | VersionRow)[] = []
		for (const v of versions ?? []) {
			const d = day(v.t)
			if (!out.some((r) => 'day' in r && r.day === d)) out.push({ day: d })
			out.push(v)
		}
		return out
	}, [versions])

	return (
		<>
			{Preview && selected !== null && (
				<div className="absolute inset-0 z-[450] bg-background">
					{/* Beside the panel on a wide screen, above it on a narrow one, so a fitted version is all in view. */}
					<div className="absolute inset-y-0 left-0 right-0 max-md:bottom-[55%] md:right-[336px]">{data && shown && <Preview data={data.data} version={shown} />}</div>
					<div aria-hidden className="pointer-events-none absolute inset-0 z-10 border-2 border-amber-500/70" />
					<div className="toucan-ui absolute top-2 left-1/2 z-20 -translate-x-1/2 rounded-md border whitespace-nowrap md:left-[calc((100%-336px)/2)] border-amber-500/40 bg-amber-100 px-2 py-1 text-xs font-medium text-amber-950 dark:bg-amber-950 dark:text-amber-100">
						Viewing v{selected}, read-only
					</div>
				</div>
			)}
			<SidePanel
				icon={HistoryIcon}
				title="History"
				label="Version history"
				closeLabel="Close history"
				onClose={onClose}
				placement={placement}
				controls={
					<>
						<Button variant="ghost" size="icon-sm" aria-label="Older version" title="Older (←)" disabled={!versions?.length || index === versions.length - 1} onClick={older}>
							<ChevronLeftIcon />
						</Button>
						<Button variant="ghost" size="icon-sm" aria-label="Newer version" title="Newer (→)" disabled={selected === null} onClick={newer}>
							<ChevronRightIcon />
						</Button>
					</>
				}
			>
				{saveVersion && (
					<form onSubmit={save} className="flex gap-1.5 border-b p-2">
						<Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name this moment…" aria-label="Version name" className="h-7 text-xs" onKeyDown={(e) => e.stopPropagation()} />
						<Button type="submit" variant="outline" size="sm" disabled={!name.trim()}>
							Save
						</Button>
					</form>
				)}

				{restored && (
					<PanelNotice
						action={
							restored.undo !== null && (
								<Button variant="outline" size="xs" onClick={() => restored.undo !== null && restore(restored.undo).then(() => setRestored(null))}>
									Undo
								</Button>
							)
						}
					>
						{restored.note ?? `Restored v${restored.n} ${w.restoredFor}.`}
					</PanelNotice>
				)}
				<PanelError onDismiss={() => setError('')}>{error}</PanelError>

				<ol className="min-h-0 flex-1 overflow-y-auto py-1">
					<li>
						<button type="button" onClick={() => setSelected(null)} aria-current={selected === null} className={cn('flex w-full items-baseline gap-2 px-3 py-1.5 text-left outline-none hover:bg-muted focus-visible:bg-muted', selected === null && 'bg-muted')}>
							<span className="font-medium">Now</span>
							<span className="text-xs text-muted-foreground">{current ? `the live ${w.document}` : `the live ${w.document}, with unsaved edits`}</span>
						</button>
					</li>
					{versions === null && <li className="px-3 py-2 text-xs text-muted-foreground">Loading…</li>}
					{versions?.length === 0 && <li className="px-3 py-2 text-xs text-muted-foreground">{w.empty}</li>}
					{rows.map((r) =>
						'day' in r ? (
							<li key={r.day} className="px-3 pt-3 pb-0.5 text-xs font-medium text-muted-foreground">
								{r.day}
							</li>
						) : (
							<li key={r.n}>
								<button type="button" onClick={() => setSelected(r.n)} aria-current={selected === r.n} title={r.keys.length ? r.keys.join(', ') : undefined} className={cn('flex w-full items-start gap-2 px-3 py-1.5 text-left outline-none hover:bg-muted focus-visible:bg-muted', selected === r.n && 'bg-amber-100 hover:bg-amber-100 dark:bg-amber-950 dark:hover:bg-amber-950')}>
									<span className="w-14 shrink-0 pt-px text-xs text-muted-foreground tabular-nums">{time(r.t)}</span>
									<span className="min-w-0 flex-1">
										<span className={cn('flex items-center gap-1 break-words', r.named && 'font-medium')}>
											{r.named && <BookmarkIcon className="size-3 shrink-0" />}
											{r.source === 'agent' && !r.named && <BotIcon className="size-3 shrink-0 text-violet-500" aria-label="agent" />}
											{r.source === 'checkpoint' && !r.named && <FlagIcon className="size-3 shrink-0 text-violet-500" aria-label="before a request" />}
											{r.source === 'restore' && <RotateCcwIcon className="size-3 shrink-0 text-muted-foreground" />}
											<span className="line-clamp-2 min-w-0">{stepTitle(r)}</span>
										</span>
										<span className="block text-xs text-muted-foreground tabular-nums">
											{[r.added && `+${r.added}`, r.updated && `~${r.updated}`, r.removed && `−${r.removed}`].filter(Boolean).join(' ') || `no ${w.part} changes`} · {plural(r.count, w.part)}
										</span>
									</span>
								</button>
							</li>
						),
					)}
				</ol>

				{shown && (
					<footer className="space-y-1.5 border-t p-2">
						<Button className="w-full" onClick={() => restore(shown.n)}>
							<RotateCcwIcon /> {w.restore(shown.n)}
						</Button>
						<p className="text-center text-xs text-muted-foreground">{w.restoreNote}</p>
					</footer>
				)}
			</SidePanel>
		</>
	)
}
