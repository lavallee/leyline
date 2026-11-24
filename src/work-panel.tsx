import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { ExternalLinkIcon, LoaderCircleIcon, RefreshCwIcon, SendIcon } from 'lucide-react'
import { Button } from './ui/button'
import { Textarea } from './ui/textarea'
import { PanelError, SidePanel } from './side-panel'
import { cn } from 'cn'

// The work a document sent elsewhere (docs/dispatch.md), the same panel in every host: what
// was sent, to where, and what the runner last said, with Send for an item waiting on the
// owner and Cancel for one under way. Opened with a passage (`compose`), it starts with the
// form for sending one. The host supplies the calls; this never fetches a URL itself.

export type WorkItem = {
	id: string
	destination: string
	title: string
	brief: string
	from?: { document?: string; file?: string; quote?: string }
	by: 'person' | 'agent'
	status: 'held' | 'sending' | 'queued' | 'running' | 'needs-review' | 'done' | 'failed' | 'cancelled'
	link?: string
	summary?: string
	result?: { message?: string; links?: { label: string; url: string }[]; files?: { path: string; change: string }[] }
	error?: string
	createdAt: string
	updatedAt: string
}
export type WorkDestination = { name: string; label: string; approval: 'owner' | 'none' }
export type WorkCompose = { quote?: string; file?: string; hint?: string }

const LABELS: Record<WorkItem['status'], string> = { held: 'Waiting for you', sending: 'Sending', queued: 'Queued', running: 'Running', 'needs-review': 'Needs review', done: 'Done', failed: 'Failed', cancelled: 'Cancelled' }
const TONE: Record<WorkItem['status'], string> = {
	held: 'bg-amber-100 text-amber-950 dark:bg-amber-950 dark:text-amber-100',
	sending: 'bg-muted text-muted-foreground',
	queued: 'bg-muted text-muted-foreground',
	running: 'bg-sky-100 text-sky-950 dark:bg-sky-950 dark:text-sky-100',
	'needs-review': 'bg-amber-100 text-amber-950 dark:bg-amber-950 dark:text-amber-100',
	done: 'bg-emerald-100 text-emerald-950 dark:bg-emerald-950 dark:text-emerald-100',
	failed: 'bg-destructive/10 text-destructive',
	cancelled: 'bg-muted text-muted-foreground',
}
const OPEN = ['queued', 'running', 'needs-review']
const when = (t: string) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

/** How many items want the owner: waiting to be sent, or needing review. For the strip's count. */
export const workWaiting = (items: WorkItem[]) => items.filter((i) => i.status === 'held' || i.status === 'needs-review').length

export function WorkPanel({ loadWork, createWork, sendWork, cancelWork, refreshWork, destinations, compose, onComposed, onClose, pollMs = 8000, placement = 'stage' }: {
	loadWork: () => Promise<{ items: WorkItem[] }>
	createWork: (parts: { destination: string; brief: string; quote?: string; file?: string }) => Promise<unknown>
	sendWork: (id: string) => Promise<unknown>
	cancelWork: (id: string) => Promise<unknown>
	/** Asks the runners for news of open items. */
	refreshWork: () => Promise<unknown>
	destinations: WorkDestination[]
	/** Open with the form, about this passage. */
	compose?: WorkCompose | null
	/** The form was sent or put away. */
	onComposed?: () => void
	onClose: () => void
	pollMs?: number
	placement?: 'stage' | 'page'
}) {
	const [items, setItems] = useState<WorkItem[] | null>(null)
	const [error, setError] = useState('')
	const [busy, setBusy] = useState('')
	const [brief, setBrief] = useState('')
	const [destination, setDestination] = useState(destinations[0]?.name ?? '')
	const fail = (e: any) => setError(String(e?.message ?? e))

	const load = useCallback(() => loadWork().then((r) => setItems(r.items), fail), [loadWork])
	const refresh = useCallback(() => refreshWork().then(load, fail), [refreshWork, load])
	// While anything is under way the runners are asked for news; otherwise the list is read again.
	const anyOpen = !!items?.some((i) => OPEN.includes(i.status))
	useEffect(() => {
		refresh()
	}, [refresh])
	useEffect(() => {
		if (!pollMs) return
		const t = setInterval(() => (anyOpen ? refresh() : load()), pollMs)
		return () => clearInterval(t)
	}, [anyOpen, refresh, load, pollMs])
	useEffect(() => {
		if (compose) setBrief(compose.hint ?? '')
	}, [compose])

	const act = async (label: string, fn: () => Promise<unknown>) => {
		setBusy(label)
		setError('')
		try {
			await fn()
		} catch (e) {
			fail(e)
		}
		setBusy('')
		load()
	}
	async function submit(e: FormEvent) {
		e.preventDefault()
		if (!brief.trim() || !destination) return
		await act('create', () => createWork({ destination, brief: brief.trim(), quote: compose?.quote, file: compose?.file }))
		setBrief('')
		onComposed?.()
	}
	const chosen = destinations.find((d) => d.name === destination)

	return (
		<SidePanel
			icon={SendIcon}
			title="Work"
			label="Work sent from this document"
			closeLabel="Close work"
			onClose={onClose}
			placement={placement}
			controls={
				<Button variant="ghost" size="icon-sm" aria-label="Ask for news" title="Ask the runners for news" disabled={!!busy} onClick={() => act('refresh', refreshWork)}>
					<RefreshCwIcon className={cn(busy === 'refresh' && 'animate-spin')} />
				</Button>
			}
		>
			{compose && (
				<form onSubmit={submit} className="space-y-2 border-b p-3" aria-label="Send as work">
					{compose.quote && <blockquote className="max-h-24 overflow-auto border-l-2 pl-2 text-xs whitespace-pre-wrap text-muted-foreground">{compose.quote}</blockquote>}
					<Textarea value={brief} onChange={(e) => setBrief(e.target.value)} onKeyDown={(e) => e.stopPropagation()} placeholder="What should happen, and where" aria-label="What should happen" className="min-h-20 text-sm" autoFocus />
					{destinations.length > 1 && (
						<select value={destination} onChange={(e) => setDestination(e.target.value)} aria-label="Send to" className="h-8 w-full rounded-md border bg-background px-2 text-sm">
							{destinations.map((d) => (
								<option key={d.name} value={d.name}>
									{d.label}
								</option>
							))}
						</select>
					)}
					<div className="flex items-center gap-2">
						<p className="flex-1 text-xs text-muted-foreground">{chosen ? (chosen.approval === 'none' ? `Goes to ${chosen.label} at once.` : `Waits here until you send it to ${chosen.label}.`) : 'No destination is set up.'}</p>
						<Button type="button" variant="ghost" size="sm" onClick={() => onComposed?.()}>
							Cancel
						</Button>
						<Button type="submit" size="sm" disabled={!brief.trim() || !chosen || !!busy}>
							{busy === 'create' ? <LoaderCircleIcon className="animate-spin" /> : null} Add
						</Button>
					</div>
				</form>
			)}
			<PanelError onDismiss={() => setError('')}>{error}</PanelError>
			<ol className="min-h-0 flex-1 divide-y overflow-y-auto">
				{items === null && <li className="px-3 py-2 text-xs text-muted-foreground">Loading…</li>}
				{items?.length === 0 && !compose && <li className="px-3 py-2 text-xs text-muted-foreground">Nothing sent from here yet. Select a passage, or use a comment, and choose Send as work.</li>}
				{items?.map((item) => (
					<li key={item.id} className="space-y-1.5 px-3 py-2.5" data-work={item.status}>
						<div className="flex items-start gap-2">
							<span className="min-w-0 flex-1 font-medium break-words">{item.title}</span>
							<span className={cn('shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium', TONE[item.status])}>{LABELS[item.status]}</span>
						</div>
						<p className="text-xs text-muted-foreground">
							{destinations.find((d) => d.name === item.destination)?.label ?? item.destination} · {item.by === 'agent' ? 'from the agent' : 'from you'} · {when(item.createdAt)}
						</p>
						{item.from?.quote && <blockquote className="line-clamp-2 border-l-2 pl-2 text-xs text-muted-foreground">{item.from.quote}</blockquote>}
						{item.summary && <p className="text-xs whitespace-pre-wrap">{item.summary}</p>}
						{item.error && <p className="text-xs text-destructive">{item.error}</p>}
						{item.result?.message && item.result.message !== item.summary && (
							<details className="text-xs">
								<summary className="cursor-pointer text-muted-foreground select-none">What came back</summary>
								<p className="mt-1 whitespace-pre-wrap">{item.result.message}</p>
								{!!item.result.files?.length && (
									<ul className="mt-1 list-inside list-disc text-muted-foreground">
										{item.result.files.map((f) => (
											<li key={f.path}>
												<code>{f.path}</code> {f.change}
											</li>
										))}
									</ul>
								)}
							</details>
						)}
						<div className="flex flex-wrap items-center gap-1.5">
							{item.status === 'held' && (
								<Button size="xs" disabled={!!busy} onClick={() => act(item.id, () => sendWork(item.id))}>
									{busy === item.id ? <LoaderCircleIcon className="animate-spin" /> : <SendIcon />} Send
								</Button>
							)}
							{(item.status === 'held' || OPEN.includes(item.status)) && (
								<Button size="xs" variant="ghost" disabled={!!busy} onClick={() => act(item.id, () => cancelWork(item.id))}>
									{item.status === 'held' ? 'Discard' : 'Cancel'}
								</Button>
							)}
							{[...(item.link ? [{ label: 'Open', url: item.link }] : []), ...(item.result?.links ?? [])].map((l) => (
								<a key={l.url} href={l.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs underline-offset-2 hover:underline">
									<ExternalLinkIcon className="size-3" /> {l.label}
								</a>
							))}
						</div>
					</li>
				))}
			</ol>
		</SidePanel>
	)
}
