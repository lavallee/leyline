import { type ComponentProps, type ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import { AppBar, AppBarButton, AppBarMore } from './app-bar'
import { HistoryPanel } from './history-panel'
import { RoutineMenu } from './routine-menu'

// The shell for a host that is not React (docs/shell.md): the strip, the routine menu and the
// History panel, described as plain data and callbacks. Copycat's editor is one: it is plain
// DOM, and calls update() with a new description whenever its state changes.
//
// The host passes its icons (lucide components, by name) so this module carries none it
// does not use, and an action names one with `icon`.

type Icon = ComponentType<{ className?: string }>

export type ShellAction = {
	id: string
	label: string
	icon?: string
	title?: string
	/** A panel this action toggles is open. */
	pressed?: boolean
	/** Report aria-expanded rather than aria-pressed (an action that opens a panel or popover). */
	expands?: boolean
	count?: number | null
	attention?: boolean
	disabled?: boolean
	variant?: 'ghost' | 'outline' | 'default'
	/** On a phone, under More. */
	collapse?: boolean
	/** `routines`: the routine menu goes here, built from `routines`. */
	kind?: 'button' | 'routines'
}

export type ShellProps = {
	product: string
	productHref?: string
	productTitle?: string
	title: string
	titleHint?: string
	live?: boolean | null
	liveLabel?: string
	tag?: string | null
	/** A line of status after the title (saving, the agent at work). Hidden on a phone. */
	status?: string
	actions: ShellAction[]
	icons: Record<string, Icon>
	onAction: (id: string) => void
	routines?: Omit<ComponentProps<typeof RoutineMenu>, 'container'> | null
	/** Shown while set: the History panel, fixed under the strip. */
	history?: Omit<ComponentProps<typeof HistoryPanel>, 'placement'> | null
	/** Where popovers render (inside the host's shadow root). */
	container?: HTMLElement | null
}

export function Shell(props: ShellProps) {
	const { actions, icons, onAction, routines, history, container } = props
	const buttons = (list: ShellAction[]) =>
		list.map((a) =>
			a.kind === 'routines' ? (
				routines ? <RoutineMenu key={a.id} {...routines} container={container} /> : null
			) : (
				<AppBarButton
					key={a.id}
					data-action={a.id}
					icon={a.icon ? icons[a.icon] : undefined}
					label={a.label}
					title={a.title}
					pressed={a.pressed}
					{...(a.expands ? { 'aria-expanded': !!a.pressed } : {})}
					count={a.count}
					attention={a.attention}
					disabled={a.disabled}
					variant={a.variant}
					collapse={a.collapse}
					onClick={() => onAction(a.id)}
				/>
			),
		)
	const collapsed = actions.filter((a) => a.collapse && a.kind !== 'routines')
	return (
		<>
			<AppBar
				product={props.product}
				productHref={props.productHref}
				productTitle={props.productTitle}
				title={props.title}
				titleHint={props.titleHint}
				live={props.live}
				liveLabel={props.liveLabel}
				tag={props.tag}
				container={container}
				status={props.status ? <span className="min-w-0 truncate text-xs text-muted-foreground max-md:hidden" role="status" aria-live="polite">{props.status}</span> : null}
				className="pointer-events-auto"
			>
				{buttons(actions)}
				{collapsed.length > 0 && <AppBarMore>{buttons(collapsed)}</AppBarMore>}
			</AppBar>
			{history && (
				<div className="pointer-events-auto">
					<HistoryPanel {...history} placement="page" />
				</div>
			)}
		</>
	)
}

/** Renders the shell into `node` (which the host has put where it wants it). */
export function mountShell(node: HTMLElement, props: ShellProps) {
	const root = createRoot(node)
	root.render(<Shell {...props} />)
	return { update: (next: ShellProps) => root.render(<Shell {...next} />), unmount: () => root.unmount() }
}
