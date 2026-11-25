import { createContext, useContext, useState, type ComponentProps, type ComponentType, type ReactNode } from 'react'
import { EllipsisIcon } from 'lucide-react'
import { Button } from './ui/button'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { cn } from 'cn'

// The strip across the top of every tool: the product, the document and whether it is live,
// then the actions. One look for all hosts (docs/shell.md). A host supplies the actions as
// children, usually AppBarButton; anything else (a popover's trigger) fits as long as it is
// a ghost button of size sm.

type Icon = ComponentType<{ className?: string }>

/** Inside AppBarMore: actions render as full-width rows with their label always shown. */
const InMore = createContext(false)

export function AppBar({ product, productHref, productTitle, title, titleHint, live, liveLabel, tag, status, container, className, children }: {
	product: ReactNode
	productHref?: string
	productTitle?: string
	title: ReactNode
	titleHint?: string
	/** true: green, synced. false: red, offline. null or absent: no dot. */
	live?: boolean | null
	liveLabel?: string
	/** A small monospaced tag after the dot (an engine, "sandbox"). Hidden on a phone. */
	tag?: ReactNode
	/** Anything to show between the title and the actions (a notice, an agent at work). */
	status?: ReactNode
	/** Where popovers opened from the strip render; a host in a shadow root passes a node inside it. */
	container?: HTMLElement | null
	className?: string
	children?: ReactNode
}) {
	const label = liveLabel ?? (live ? 'synced' : 'offline')
	return (
		<header data-slot="app-bar" className={cn('toucan-ui z-[700] flex h-11 shrink-0 items-center gap-1.5 border-b bg-background px-3 text-sm', className)}>
			<ContainerContext.Provider value={container ?? null}>
				{productHref ? (
					<a href={productHref} className="font-semibold tracking-tight outline-none hover:opacity-70 focus-visible:underline max-sm:hidden" title={productTitle}>
						{product}
					</a>
				) : (
					<span className="font-semibold tracking-tight max-sm:hidden" title={productTitle}>
						{product}
					</span>
				)}
				<span aria-hidden className="text-muted-foreground/60 max-sm:hidden">
					/
				</span>
				<span className="min-w-0 truncate font-medium" title={titleHint}>
					{title}
				</span>
				{live != null && <span className={cn('size-2 shrink-0 rounded-full', live ? 'bg-emerald-500' : 'bg-destructive')} role="status" aria-label={label} title={label} />}
				{tag && <span className="shrink-0 rounded bg-muted px-1 font-mono text-[10px] text-muted-foreground max-sm:hidden">{tag}</span>}
				{status}
				<span className="flex-1" />
				{children}
			</ContainerContext.Provider>
		</header>
	)
}

const ContainerContext = createContext<HTMLElement | null>(null)
/** The node popovers opened from the strip should portal into (null: the document's body). */
export const useAppBarContainer = () => useContext(ContainerContext)

/**
 * One action in the strip: an icon and a label that hides below 1024px. `pressed` is for a
 * panel the action toggles; `count` is a number in a pill after the label (open threads,
 * unsaved edits), amber when `attention` is set (something is waiting on this person);
 * `attention` with no count is an amber dot. `variant="outline"` is for the chat toggle,
 * which comes last; `variant="default"` for the one action the page is for (Review).
 * `collapse` moves it into AppBarMore on a phone.
 * On a touch screen every action is at least 36px square, and the primary action keeps its
 * label at any width, so a phone shows the same strip as a desk with nothing to learn again.
 */
export function AppBarButton({ icon: Icon, label, pressed, count, attention, collapse, variant = 'ghost', className, title, children, ...rest }: Omit<ComponentProps<typeof Button>, 'size'> & {
	icon?: Icon
	label: string
	pressed?: boolean
	count?: number | null
	attention?: boolean
	collapse?: boolean
}) {
	const inMore = useContext(InMore)
	if (inMore && !collapse) return null
	const badge = count ? (
		<span className={cn('rounded-full px-1.5 text-[11px] font-semibold tabular-nums', attention ? 'bg-amber-400 text-amber-950' : variant === 'default' ? 'bg-primary-foreground/20' : 'bg-muted text-muted-foreground')}>{count}</span>
	) : attention ? (
		<span aria-hidden className={cn('size-1.5 rounded-full bg-amber-500', !inMore && 'absolute top-0.5 right-0.5')} />
	) : null
	if (inMore)
		return (
			<Button variant="ghost" size="sm" className={cn('w-full justify-start pointer-coarse:h-11 pointer-coarse:text-sm', pressed && 'bg-muted', className)} aria-pressed={rest["aria-expanded"] === undefined ? pressed : undefined} title={title ?? label} {...rest}>
				{Icon && <Icon />}
				<span className="flex-1 text-left">{label}</span>
				{badge}
				{children}
			</Button>
		)
	return (
		<Button data-attention={attention || undefined} variant={variant} size="sm" aria-pressed={rest["aria-expanded"] === undefined ? pressed : undefined} aria-label={count ? `${label}, ${count}` : label} title={title ?? label} className={cn('relative pointer-coarse:h-9 pointer-coarse:min-w-9', variant === 'outline' && 'ml-1', pressed && variant === 'ghost' && 'bg-muted', collapse && 'max-sm:hidden', className)} {...rest}>
			{Icon && <Icon />}
			<span className={cn(Icon && variant !== 'default' && 'max-lg:hidden')}>{label}</span>
			{badge}
			{children}
		</Button>
	)
}

/**
 * On a phone, the actions marked `collapse`, under one button. Pass the same children as the
 * strip: those without `collapse` are left out here, and those with it are hidden from the
 * strip below 640px, so each action is in one place at a time.
 */
export function AppBarMore({ label = 'More', children }: { label?: string; children: ReactNode }) {
	const [open, setOpen] = useState(false)
	const container = useAppBarContainer()
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button variant="ghost" size="icon-sm" aria-label={label} title={label} className="pointer-coarse:size-9 sm:hidden">
					<EllipsisIcon />
				</Button>
			</PopoverTrigger>
			<PopoverContent container={container} className="w-56 max-w-[calc(100vw-1rem)] p-1" onClick={(e) => (e.target as HTMLElement).closest('button') && setOpen(false)}>
				<InMore.Provider value={true}>
					<div className="flex flex-col">{children}</div>
				</InMore.Provider>
			</PopoverContent>
		</Popover>
	)
}
