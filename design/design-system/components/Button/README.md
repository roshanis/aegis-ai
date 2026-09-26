# Button

Button runs one action and says exactly what that action is.

## Variants

- **Primary**: `action` fill with `on-action` text. Use one per view, for the step that moves the case forward ("Sign with 2 conditions", "Continue", "Search").
- **Secondary**: transparent with a 1px `border-control` border and `ink` text.
- **Segmented**: a `surface-raised` track with `space-1` gaps. The selected option is filled `ink` with `surface-page` text, and each option sets `aria-pressed`.
- **Pill**: `radius-pill`, used for filters and suggested searches.

## Rules

- Every button is at least `target` (44px) high, with `radius-md` corners (12px on 48px+ primaries).
- Focus shows a 3px `focus` outline with a 2px offset.
- Labels are verbs plus objects. Don't use "Submit", "OK" or "Confirm" on their own.
- Only show actions the current person can take, as reported by `lifecycle.available()`. Hide an unavailable action; don't disable it without saying why.
