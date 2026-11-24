import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ChevronRightIcon, LoaderCircleIcon, PlayIcon, Trash2Icon, WandSparklesIcon } from 'lucide-react'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { Textarea } from './ui/textarea'
import { AppBarButton, useAppBarContainer } from './app-bar'
import { cn } from 'cn'


export type Routine = { name: string; title: string; description: string; engines: string[]; source: 'shipped' | 'banked'; code: string; kind?: string; when?: string; args?: string }
export type RoutineKind = { id: string; label: string; about: string }
/** Work agents keep doing by hand that no routine covers yet (./server/worklog). */
export type RoutineSuggestion = { id: string; runs: number; canvases: string[]; labels: string[]; coveredBy: string[]; example: string }
type Outcome = { name: string; ok: boolean; text: string }

const slug = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
/** What a run returned, for a person: its `summary` if it has one. */
const describe = (result: any) => (typeof result === 'string' ? result : result?.summary ?? 'Done')

/**
 * The bank of routines, the same menu in every host (docs/shell.md): chores saved once and
 * run with one click, grouped by kind when the host has kinds, searchable once there are
 * more than six, with habits the agent noticed offered for banking.
 */
export function RoutineMenu({ engine, onAskAgent, loadRoutines, runRoutine, saveRoutine, removeRoutine, loadSuggestions, suggestionRequest, container: given, scopeLabel = 'canvas', productName = 'toucan', askLabel = 'Ask the agent to bank one', namePlaceholder = 'Name, like Colour the blocked boxes red', bodyLabel = 'Routine code', bodyPlaceholder = '// editor, tl, toucan and args are in scope', description = 'Chores banked once, for every canvas. A run is one undo step.', label = 'Routines', running: busy }: {
	engine: string
	/** Opens the chat with a request drafted: none for "help me bank one", or the text to send. */
	onAskAgent: (text?: string) => void
	loadRoutines: () => Promise<{ routines: Routine[]; kinds?: RoutineKind[] }>
	runRoutine: (name: string) => Promise<any>
	saveRoutine: (name: string, parts: any) => Promise<any>
	removeRoutine: (name: string) => Promise<any>
	/** Habits not banked yet. Leave out to hide "From your work". */
	loadSuggestions?: () => Promise<RoutineSuggestion[]>
	/** What the agent is asked when a person banks a suggestion. */
	suggestionRequest?: (s: RoutineSuggestion) => string
	container?: HTMLElement | null
	scopeLabel?: string
	productName?: string
	askLabel?: string
	namePlaceholder?: string
	bodyLabel?: string
	bodyPlaceholder?: string
	description?: string
	/** The trigger's label. */
	label?: string
	/** A routine the host is running on its own (from a slash command, say): shown on the trigger. */
	running?: string
}) {
	const container = given ?? useAppBarContainer()
	const [open, setOpen] = useState(false)
	const [routines, setRoutines] = useState<Routine[] | null>(null)
	const [kinds, setKinds] = useState<RoutineKind[]>([])
	const [suggestions, setSuggestions] = useState<RoutineSuggestion[]>([])
	const [q, setQ] = useState('')
	const [running, setRunning] = useState('')
	const [outcome, setOutcome] = useState<Outcome | null>(null)
	const [codeOf, setCodeOf] = useState('')
	const [banking, setBanking] = useState(false)
	const [draft, setDraft] = useState({ title: '', description: '', code: '' })
	const [error, setError] = useState('')
	const asking = useRef(false) // leaving for the chat: focus goes to its input, not back to this button

	const load = () => loadRoutines().then((r) => (setRoutines(r.routines), setKinds(r.kinds ?? [])), (e) => setError(String(e.message ?? e)))
	useEffect(() => {
		if (!open) return
		load()
		loadSuggestions?.().then((list) => setSuggestions(list.filter((s) => !s.coveredBy.length).slice(0, 3)), () => {})
	}, [open])

	async function run(r: Routine) {
		setRunning(r.name)
		setOutcome(null)
		try {
			const res = await runRoutine(r.name)
			setOutcome({ name: r.name, ok: res.ok, text: res.ok ? describe(res.result) : res.error })
		} catch (e: any) {
			setOutcome({ name: r.name, ok: false, text: e.message })
		}
		setRunning('')
	}
	async function bank(e: FormEvent) {
		e.preventDefault()
		const name = slug(draft.title)
		if (!name || !draft.code.trim()) return
		try {
			await saveRoutine(name, { ...draft, engines: [engine] })
			setDraft({ title: '', description: '', code: '' })
			setBanking(false)
			load()
		} catch (err: any) {
			setError(err.message)
		}
	}
	async function remove(r: Routine) {
		if (!confirm(`Remove "${r.title}" from the bank? Every ${scopeLabel} loses it.`)) return
		try {
			await removeRoutine(r.name)
			load()
		} catch (err: any) {
			setError(err.message)
		}
	}

	const forHere = routines?.filter((r) => r.engines.includes(engine))
	const matches = (r: Routine) => !q || `${r.title} ${r.description} ${r.when ?? ''} ${r.kind ?? ''}`.toLowerCase().includes(q.toLowerCase())
	const usable = forHere?.filter(matches)
	const elsewhere = (routines?.length ?? 0) - (forHere?.length ?? 0)
	const groups = (kinds.length ? kinds : [{ id: '', label: '', about: '' }]).map((k) => ({ ...k, list: usable?.filter((r) => (kinds.length ? r.kind === k.id : true)) ?? [] })).filter((g) => g.list.length)
	const ask = (text?: string) => {
		asking.current = true
		setOpen(false)
		onAskAgent(text)
	}
	const heading = 'sticky top-0 z-10 border-b bg-background px-3 pt-1.5 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase'
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<AppBarButton icon={busy ? LoaderCircleIcon : WandSparklesIcon} label={busy ? `${busy}…` : label} aria-label={label} className={cn(busy && '[&_svg]:animate-spin')} />
			</PopoverTrigger>
			<PopoverContent
				className="w-96 p-0"
				container={container}
				onCloseAutoFocus={(e) => {
					if (asking.current) e.preventDefault()
					asking.current = false
				}}
			>
				<header className="border-b px-3 py-2">
					<h2 className="font-medium">Routines</h2>
					<p className="text-xs text-muted-foreground">{description}</p>
				</header>
				{error && (
					<p role="alert" className="border-b bg-destructive/10 px-3 py-1.5 text-xs text-destructive" onClick={() => setError('')}>
						{error}
					</p>
				)}
				{(forHere?.length ?? 0) > 6 && (
					<div className="border-b p-2">
						<Input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} placeholder="Find a routine" aria-label="Find a routine" className="h-7 text-xs" />
					</div>
				)}
				<ul className="max-h-[min(28rem,60vh)] overflow-y-auto">
					{routines === null && <li className="px-3 py-2 text-xs text-muted-foreground">Loading…</li>}
					{forHere?.length === 0 && <li className="px-3 py-2 text-xs text-muted-foreground">Nothing banked for {engine} yet.</li>}
					{forHere && forHere.length > 0 && usable?.length === 0 && <li className="px-3 py-2 text-xs text-muted-foreground">No routine matches.</li>}
					{groups.map((g) => (
						<li key={g.id}>
							{g.label && (
								<h3 className={heading} title={g.about}>
									{g.label}
								</h3>
							)}
							<ul className="divide-y">
								{g.list.map((r) => (
						<li key={r.name} className="px-3 py-2">
							<div className="flex items-start gap-2">
								<div className="min-w-0 flex-1">
									<p className="font-medium">{r.title}</p>
									{r.description && <p className="text-xs text-muted-foreground">{r.description}</p>}
								</div>
								<Button size="sm" variant="outline" disabled={!!running} onClick={() => run(r)} aria-label={`Run ${r.title}`}>
									{running === r.name ? <LoaderCircleIcon className="animate-spin" /> : <PlayIcon />} Run
								</Button>
							</div>
							{outcome?.name === r.name && (
								<p role="status" className={cn('mt-1 text-xs', outcome.ok ? 'text-muted-foreground' : 'text-destructive')}>
									{outcome.text}
								</p>
							)}
							<div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
								<button type="button" className="flex items-center gap-0.5 rounded outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50" aria-expanded={codeOf === r.name} onClick={() => setCodeOf((c) => (c === r.name ? '' : r.name))}>
									<ChevronRightIcon className={cn('size-3 transition-transform', codeOf === r.name && 'rotate-90')} /> {bodyLabel === 'Routine code' ? 'Code' : 'Prompt'}
								</button>
								<span>{r.source === 'shipped' ? `ships with ${productName}` : 'banked here'}</span>
								{r.source === 'banked' && (
									<button type="button" className="ml-auto rounded p-0.5 outline-none hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring/50" aria-label={`Remove ${r.title}`} title="Remove from the bank" onClick={() => remove(r)}>
										<Trash2Icon className="size-3.5" />
									</button>
								)}
							</div>
							{codeOf === r.name && <pre className="mt-1 max-h-48 overflow-auto rounded-md bg-muted p-2 font-mono text-[11px] leading-snug">{r.code}</pre>}
						</li>
								))}
							</ul>
						</li>
					))}
					{suggestions.length > 0 && !q && (
						<li>
							<h3 className={heading} title="Work agents keep doing by hand, which no routine does yet">
								From your work
							</h3>
							<ul className="divide-y">
								{suggestions.map((s) => (
									<li key={s.id} className="flex items-start gap-2 px-3 py-2">
										<div className="min-w-0 flex-1">
											<p className="truncate text-sm font-medium">{s.labels[0] ?? 'A chore done by hand'}</p>
											<p className="text-xs text-muted-foreground">
												Done {s.runs} times{s.canvases.length > 1 ? ` on ${s.canvases.length} ${scopeLabel}s` : ''}, by hand.
											</p>
										</div>
										<Button size="sm" variant="outline" onClick={() => ask(suggestionRequest ? suggestionRequest(s) : `Bank this as a routine: ${s.labels[0] ?? 'the chore I keep doing by hand'}.`)}>
											Bank it
										</Button>
									</li>
								))}
							</ul>
						</li>
					)}
				</ul>
				{elsewhere > 0 && <p className="border-t px-3 py-1.5 text-xs text-muted-foreground">{elsewhere} more for other engines.</p>}
				<footer className="border-t p-2">
					{banking ? (
						<form onSubmit={bank} className="space-y-1.5">
							<Input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder={namePlaceholder} aria-label="Routine name" className="h-7 text-xs" autoFocus />
							<Input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="What it does" aria-label="What it does" className="h-7 text-xs" />
							<Textarea value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value })} placeholder={bodyPlaceholder} aria-label={bodyLabel} className="h-28 font-mono text-[11px]" />
							<div className="flex justify-end gap-1.5">
								<Button type="button" variant="ghost" size="sm" onClick={() => setBanking(false)}>
									Cancel
								</Button>
								<Button type="submit" size="sm" disabled={!slug(draft.title) || !draft.code.trim()}>
									Bank it
								</Button>
							</div>
						</form>
					) : (
						<div className="flex gap-1.5">
							<Button size="sm" className="flex-1" onClick={() => ask()}>
								{askLabel}
							</Button>
							<Button variant="outline" size="sm" onClick={() => setBanking(true)}>
								{bodyLabel === 'Routine code' ? 'Paste code' : 'Bank a prompt'}
							</Button>
						</div>
					)}
				</footer>
			</PopoverContent>
		</Popover>
	)
}
