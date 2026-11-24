# The shell: one strip, one set of panels, every host

Written 2026-11-24. The owner's decision, the same day: Leyline is where the visible
conventions of our tools live, not only their server parts. Toucan, Copycat and Skein are
its first customers, and none of them keeps its own copy of these visuals. Anyone else may
use the package at whichever level suits them.

## Levels

The package is opinionated at the top and plain underneath. A host can stop at any level.

| Level | What | Entry points |
| --- | --- | --- |
| Server | Stores and the agent's plumbing, no UI | `./server/*` |
| Primitives | Buttons, inputs, popovers, message bubbles | `./ui/*`, `./theme.css` |
| Components | The strip, the side panel, routines, history, the chat and its dock | `./app-bar`, `./side-panel`, `./routine-menu`, `./history-panel`, `.`, `./dock` |
| Shell | The strip, routines and history described as plain data, for a page that is not React | `./shell` (`Shell`, `mountShell`) |

A component takes the host's data and actions as props (`loadVersions`, `runRoutine` and
so on) and never fetches a URL of its own. That is what lets Toucan's canvas and
Copycat's live page sit behind the same History panel.

## The conventions

- **The strip** is 44px at the top: the product's name and a `/` (both hidden on a phone), the document's title and a
  live dot (green synced, red offline), then a spacer, then actions. Each action is a
  ghost button with a lucide icon and a label that hides below 1024px; the chat toggle
  comes last, outlined. On a phone actions that do not fit go into a More menu.
- **One panel at a time** on the right, opened from the strip: comments, history,
  references. Opening one puts the others away. On a narrow screen a panel is a sheet
  over the lower part of the screen.
- **Chat** is a dock: right, left, bottom or floating. Hosts choose the default; Copycat
  floats it over the page.
- **Routines** are one menu everywhere: search, groups by kind, a run's outcome inline,
  habits the agent noticed offered for banking, and banking by hand or by asking the agent.
- **History** is one panel everywhere: versions newest first, grouped by day, an agent's
  versions marked, a version shown read-only beside the panel, restore that saves the
  present first, and naming the present moment.

## Order of work

1. Leyline: `./app-bar`, `./side-panel`, `./history-panel`, Toucan's richer routine menu
   folded into `./routine-menu`, and `./shell` for hosts that are not React.
2. Toucan onto them; its `CanvasFrame.tsx`, `History.tsx` and `Routines.tsx` become
   configuration.
3. Copycat: the strip at the top of served pages, pushing the page down; the chat
   floating; Proofread inside Routines; History over `./server/history`, a version at each
   save and a checkpoint at each agent request, a restore becoming a draft to review. The
   extension loads the same committed bundle. Its old bottom bar stays only as the
   fallback for a host that does not supply the shell.
4. Skein, when it next changes its chrome.

The first three each end with the host's own tests and a look in a browser.

## A host in a shadow root

Copycat draws the shell and the chat inside shadow roots, so a page's styles cannot reach
them. Tailwind v4 gives its utilities' variables their starting values with `@property`,
which browsers ignore inside a shadow root: `border-b` then has no border style and
`shadow-lg` no shadow. Such a host applies Tailwind's own fallback block (the one under
`@supports` in `@layer properties`) unconditionally, to `:host` and every element; see
Copycat's `scripts/build-chat.js`. Popovers opened from the strip render in the node the
host passes as `container`.
