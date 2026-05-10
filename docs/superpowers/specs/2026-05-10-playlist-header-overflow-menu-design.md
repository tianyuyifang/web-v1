# Playlist header overflow menu — design

## Goal

Reduce the visible button count in `PlaylistHeader.js` from up to 11 (admin owner in edit mode) to at most 6 + an overflow trigger, by moving lower-frequency actions into a "⋯" dropdown menu.

## Grouping

### View mode — visible (max 4)

- Return
- Unlike All *(owner)*
- Edit *(owner)*
- Copy *(owner or `canCopy`)*

### Edit mode — visible row 1 (max 4)

- Return
- Unlike All *(owner)*
- Done *(owner)*
- Copy *(owner)*

### Edit mode — visible row 2 (max 3, the active-edit toolbar)

- Add Clip *(primary blue, owner)*
- Batch *(owner)*
- Delete *(owner, red)*

### Overflow menu (mode- and role-conditional)

| Item | Shown when |
|---|---|
| Share | owner |
| AutoPlay toggle | admin |
| Compare | not edit mode (matches current behavior) |
| Compact / Full view | edit mode, owner |
| Public / Private toggle | edit mode, owner |

The "⋯" trigger appears at the **end of the existing row 1**, after the Copy button, in both modes.

## Component

New file: [frontend/src/components/ui/OverflowMenu.js](../../../frontend/src/components/ui/OverflowMenu.js)

### Props

```js
{
  items: [
    {
      label,       // string — visible text
      onClick,     // () => void
      active,      // boolean — apply primary highlight (e.g. AutoPlay on)
      destructive, // boolean — apply red text/hover (reserved; not used initially)
      hidden,      // boolean — skip rendering this item
    },
    ...
  ],
  align,           // 'left' | 'right' (default 'right')
}
```

### Behavior

- A square "⋯" button matches the existing border/surface style used by other header buttons.
- Click toggles a dropdown panel anchored to the chosen edge (default right), opening downward beneath the trigger.
- Items render as full-width buttons inside the panel.
- `active: true` applies the primary-highlight style (matches today's `bg-primary text-white`).
- `destructive: true` applies red text and hover (matches today's `text-red-400 hover:bg-red-500/10`).
- `hidden: true` skips the item — keeps the calling JSX flat and conditional-free.
- Closes on: outside click (document `mousedown` listener), Escape key, or after any item click.
- Local state (`useState`) for open/closed. Refs for trigger and panel. Listeners attached only while open.
- No focus trap, no `role="menu"`, no arrow-key navigation. Tab moves through items naturally as buttons.

### Mobile

The panel uses the same anchored dropdown on all viewport sizes. The existing button row already uses `flex-wrap`, so the "⋯" trigger wraps with the rest on narrow screens. No mobile-specific code path.

## PlaylistHeader.js changes

- Import `OverflowMenu`.
- Build an `overflowItems` array inside the component body. Each entry includes a `hidden` flag that incorporates `playlist.isOwner`, `isAdmin`, and `editMode`. Order matches the table above.
- Remove the inline buttons for: Share, AutoPlay, Compare, Compact toggle, Public/Private toggle.
- Render `<OverflowMenu items={overflowItems} />` at the end of row 1, after the Copy button.

Leave in place: Return, Unlike All, Edit/Done, Copy, Add Clip, Batch, Delete. Their props and handlers are unchanged.

The existing handlers (`onShare`, `onCompare`, `onToggleCompact`, `onTogglePublic`, `setAutoPlayEnabled`) and state (`compactView`, `batchMode`, `playlist.isPublic`, `autoPlayEnabled`) still flow into `PlaylistHeader` — only the render location changes.

## i18n

No new strings. Menu items reuse existing translations: `share`, `autoPlayOn` / `autoPlayOff`, `comparePlaylist`, `compactView` / `fullView`, `publicLabel` / `privateLabel`.

## Out of scope

- Third-party dropdown library (Radix, Headless UI, Floating UI).
- Keyboard menu semantics — arrow keys, focus trap, ARIA `role="menu"`.
- Mobile bottom-sheet variant.
- Changes to the visual style of buttons that remain visible.
- Persisting `compactView` / `autoPlayEnabled` differently than today.

## Manual test plan

1. **View mode, owner:** Row shows Return + Unlike All + Edit + Copy + ⋯. Open ⋯ — see Share, AutoPlay (if admin), Compare. Click each; menu closes after each click.
2. **View mode, non-owner with copy permission:** Row shows Return + Copy + ⋯. ⋯ shows Compare only (no Share, no AutoPlay unless admin).
3. **View mode, non-owner without copy permission:** Row shows Return + ⋯. ⋯ shows Compare only.
4. **Edit mode, owner:** Row 1 shows Return + Unlike All + Done + Copy + ⋯. Row 2 shows Add Clip + Batch + Delete. ⋯ shows Share + (AutoPlay if admin) + Compact/Full view + Public/Private. Compare is hidden in edit mode.
5. **Escape** closes the menu. **Outside-click** closes the menu. Clicking any item closes the menu.
6. **AutoPlay toggle** inside the menu reflects current state (`autoPlayEnabled` styles the item with the active highlight) and toggles correctly.
7. **Public/Private toggle** inside the menu reflects current state and toggles correctly.
