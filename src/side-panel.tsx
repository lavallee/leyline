import type { ComponentType, ReactNode } from 'react'
import { XIcon } from 'lucide-react'
import { Button } from './ui/button'
import { cn } from 'cn'

// The one panel at a time on the right that the strip opens (docs/shell.md): a card with a
// header of its icon, title, any controls and a close button. On a narrow screen it is a
// sheet over the lower part of the screen.
//
// `placement="stage"` sits in a positioned box under the strip (Toucan's canvas);
// `placement="page"` is fixed to the window below a 44px strip (Copycat over a page).

export function SidePanel({ icon: Icon, title, label, controls, onClose, closeLabel, placement = 'stage', className, children }: {
	icon?: ComponentType<{ className?: string }>
	title: ReactNode
	/** The panel's accessible name, when the title is not plain text. */
	label?: string
	/** Buttons between the title and the close button (older and newer, a filter). */
	controls?: ReactNode
	onClose: () => void
	closeLabel?: string
	placement?: 'stage' | 'page'
	className?: string
	children: ReactNode
}) {
	const name = label ?? (typeof title === 'string' ? title : undefined)
	return (
		<section
			data-slot="side-panel"
			aria-label={name}
			className={cn(
				'toucan-ui z-[460] flex w-80 max-w-[calc(100%-1rem)] flex-col overflow-hidden rounded-xl border bg-background text-sm shadow-lg max-md:inset-x-2 max-md:top-auto max-md:h-[55%] max-md:w-auto',
				placement === 'stage' ? 'absolute inset-y-2 right-2' : 'fixed top-[3.25rem] right-2 bottom-2 max-md:bottom-[var(--panel-bottom,0.5rem)]',
				className,
			)}
		>
			<header className="flex items-center gap-1 border-b py-1.5 pr-1.5 pl-3">
				{Icon && <Icon className="size-4 text-muted-foreground" />}
				<h2 className="min-w-0 truncate font-medium">{title}</h2>
				<span className="flex-1" />
				{controls}
				<Button variant="ghost" size="icon-sm" aria-label={closeLabel ?? (name ? `Close ${name.toLowerCase()}` : 'Close')} title="Close (Esc)" onClick={onClose}>
					<XIcon />
				</Button>
			</header>
			{children}
		</section>
	)
}

/** A line under a panel's header saying what just happened, with an optional action (Undo). */
export function PanelNotice({ children, action }: { children: ReactNode; action?: ReactNode }) {
	return (
		<div className="flex items-center gap-2 border-b bg-muted/50 px-3 py-1.5 text-xs" role="status">
			<span className="flex-1">{children}</span>
			{action}
		</div>
	)
}

/** A failure under a panel's header; clicking it puts it away. */
export function PanelError({ children, onDismiss }: { children: ReactNode; onDismiss?: () => void }) {
	if (!children) return null
	return (
		<p role="alert" className="border-b bg-destructive/10 px-3 py-1.5 text-xs text-destructive" onClick={onDismiss}>
			{children}
		</p>
	)
}
