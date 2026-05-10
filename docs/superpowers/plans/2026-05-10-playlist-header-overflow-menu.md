# Playlist Header Overflow Menu — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce the visible button count in `PlaylistHeader` by moving Share, AutoPlay, Compare, Compact/Full view, and Public/Private into a reusable "⋯" overflow dropdown menu.

**Architecture:** Build one small generic `OverflowMenu` component in `frontend/src/components/ui/`. Modify `PlaylistHeader.js` to consume it. No state management or third-party libraries — local `useState` + document-level mousedown/Escape listeners. JSX is kept flat by passing items with `hidden: true` flags rather than nested conditionals.

**Tech Stack:** React 18, Next.js App Router (client components), Tailwind CSS 3.4, JavaScript (no TypeScript).

**Spec:** [`docs/superpowers/specs/2026-05-10-playlist-header-overflow-menu-design.md`](../specs/2026-05-10-playlist-header-overflow-menu-design.md)

---

## File Structure

- **Create** `frontend/src/components/ui/OverflowMenu.js` — generic dropdown menu. One responsibility: render a "⋯" trigger that toggles a small dropdown of clickable items. Handles outside-click + Escape + click-to-close. No knowledge of playlist concepts; receives a plain `items` array.
- **Modify** `frontend/src/components/playlist/PlaylistHeader.js` — remove the inline Share, AutoPlay, Compare, Compact, Public/Private buttons; import `OverflowMenu`; build an `overflowItems` array with `hidden` flags based on `playlist.isOwner`, `isAdmin`, `editMode`; render the menu at the end of row 1 after the Copy button.

The new file follows the existing `frontend/src/components/ui/` convention used by `RichText` (visible in `PlaylistHeader.js` imports).

No new translations. No backend changes. No tests (project has no frontend automated test suite — verification is manual per the spec's test plan).

---

## Task 1: Create the `OverflowMenu` component

**Files:**
- Create: `frontend/src/components/ui/OverflowMenu.js`

- [ ] **Step 1: Confirm the target directory exists**

Run from repo root `c:\Projects\web-v1`:

```
ls frontend/src/components/ui
```

Expected: directory exists and contains at least `RichText.js`. (If the directory is missing, stop and report — the codebase has drifted from the assumption.)

- [ ] **Step 2: Create `OverflowMenu.js` with the full component implementation**

Write the following file at `frontend/src/components/ui/OverflowMenu.js`:

```jsx
"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Dropdown overflow menu with a "⋯" trigger.
 *
 * Props:
 *  - items: Array<{ label: string, onClick: () => void, active?: boolean, destructive?: boolean, hidden?: boolean }>
 *  - align: "left" | "right"  (default "right") — which edge of the trigger the panel aligns to
 */
export default function OverflowMenu({ items, align = "right" }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef(null);
  const panelRef = useRef(null);

  useEffect(() => {
    if (!open) return;

    const handleMouseDown = (e) => {
      if (
        triggerRef.current?.contains(e.target) ||
        panelRef.current?.contains(e.target)
      ) {
        return;
      }
      setOpen(false);
    };

    const handleKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };

    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const visibleItems = items.filter((it) => !it.hidden);
  if (visibleItems.length === 0) return null;

  const alignClass = align === "left" ? "left-0" : "right-0";

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        onClick={() => setOpen((v) => !v)}
        aria-label="More actions"
        aria-expanded={open}
        className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-medium transition-colors hover:bg-surface-hover"
        style={{ color: "var(--text)" }}
      >
        ⋯
      </button>

      {open && (
        <div
          ref={panelRef}
          className={`absolute ${alignClass} z-50 mt-1 min-w-[10rem] rounded-lg border border-border bg-surface p-1 shadow-lg`}
        >
          {visibleItems.map((it, i) => {
            const base =
              "w-full rounded-md px-3 py-1.5 text-left text-sm font-medium transition-colors";
            let stateClass;
            if (it.active) {
              stateClass = "bg-primary text-white shadow-sm hover:bg-primary-hover";
            } else if (it.destructive) {
              stateClass = "text-red-400 hover:bg-red-500/10";
            } else {
              stateClass = "hover:bg-surface-hover";
            }
            const style = it.active || it.destructive ? undefined : { color: "var(--text)" };

            return (
              <button
                key={i}
                onClick={() => {
                  it.onClick();
                  setOpen(false);
                }}
                className={`${base} ${stateClass}`}
                style={style}
              >
                {it.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
```

Notes for the implementer:
- The styles reuse Tailwind class names already used elsewhere in `PlaylistHeader.js` (`border-border`, `bg-surface`, `bg-surface-hover`, `bg-primary`, `bg-primary-hover`, `text-red-400`, `hover:bg-red-500/10`). Do not invent new color tokens.
- The `style={{ color: "var(--text)" }}` mirrors the existing button pattern (Tailwind does not own the `--text` CSS variable; the project uses it for theme-aware text color).
- `z-50` ensures the dropdown appears above the playlist content. The header sits at the top of the page so a downward dropdown is safe.
- Listeners are only attached when `open` is `true`, so unmounting the menu while closed has zero global side effects.

- [ ] **Step 3: Verify the dev server compiles the new file**

In the terminal already running `cd frontend && npm run dev`, watch for an HMR recompile after saving. There must be no syntax/lint errors. (No usage yet — the file should compile but exports an unused component until Task 2 imports it.)

- [ ] **Step 4: Commit**

```
git add frontend/src/components/ui/OverflowMenu.js
git commit -m "Add OverflowMenu UI component"
```

---

## Task 2: Wire `OverflowMenu` into `PlaylistHeader`

**Files:**
- Modify: `frontend/src/components/playlist/PlaylistHeader.js`

- [ ] **Step 1: Add the import**

Add this line in the import block at the top of `frontend/src/components/playlist/PlaylistHeader.js`, beneath the `RichText` import:

```js
import OverflowMenu from "@/components/ui/OverflowMenu";
```

The resulting import block (lines 1–8) should read:

```js
"use client";

import { useState } from "react";
import { useLanguage } from "@/components/layout/LanguageProvider";
import RichText from "@/components/ui/RichText";
import OverflowMenu from "@/components/ui/OverflowMenu";
import useAuth from "@/hooks/useAuth";
import usePlayerStore from "@/store/playerStore";
```

- [ ] **Step 2: Build the `overflowItems` array inside the component body**

Insert this block after the existing `handleDescBlur` declaration and before the `return (` statement (around line 52). Place it as the last statement before `return`:

```jsx
  const overflowItems = [
    {
      label: t("share"),
      onClick: () => onShare?.(),
      hidden: !playlist.isOwner,
    },
    {
      label: autoPlayEnabled ? t("autoPlayOn") : t("autoPlayOff"),
      onClick: () => setAutoPlayEnabled(!autoPlayEnabled),
      active: autoPlayEnabled,
      hidden: !isAdmin,
    },
    {
      label: t("comparePlaylist"),
      onClick: () => onCompare?.(),
      hidden: editMode,
    },
    {
      label: compactView ? t("fullView") : t("compactView"),
      onClick: () => onToggleCompact?.(),
      active: compactView,
      hidden: !editMode || !playlist.isOwner,
    },
    {
      label: playlist.isPublic ? t("publicLabel") : t("privateLabel"),
      onClick: () => onTogglePublic?.(),
      active: playlist.isPublic,
      hidden: !editMode || !playlist.isOwner,
    },
  ];
```

Item order mirrors the spec table and matches the visual order the user will see when opening the menu.

- [ ] **Step 3: Remove the now-redundant inline AutoPlay button**

Currently lines 132–144 (inside the row-1 button container) render:

```jsx
            {isAdmin && (
              <button
                onClick={() => setAutoPlayEnabled(!autoPlayEnabled)}
                className={`rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors ${
                  autoPlayEnabled
                    ? "bg-primary text-white shadow-sm hover:bg-primary-hover"
                    : "border border-border bg-surface hover:bg-surface-hover"
                }`}
                style={autoPlayEnabled ? {} : { color: "var(--text)" }}
              >
                {autoPlayEnabled ? t("autoPlayOn") : t("autoPlayOff")}
              </button>
            )}
```

Delete this entire block (the surrounding `{isAdmin && ( ... )}` and contents).

- [ ] **Step 4: Remove the now-redundant inline Compare button**

Currently lines 155–163 render:

```jsx
            {!editMode && (
              <button
                onClick={onCompare}
                className="rounded-lg border border-border bg-surface px-3.5 py-1.5 text-sm font-medium transition-colors hover:bg-surface-hover"
                style={{ color: "var(--text)" }}
              >
                {t("comparePlaylist")}
              </button>
            )}
```

Delete this entire block.

- [ ] **Step 5: Remove the now-redundant inline Share button**

Currently the Share button is rendered inside the owner-only fragment (`{playlist.isOwner && ( <> ... </> )}`) at lines 165–186. The fragment contains both the Share button and the Edit/Done button. Remove only the Share button, leaving the Edit/Done button in place.

Before:

```jsx
            {playlist.isOwner && (
              <>
                <button
                  onClick={onShare}
                  className="rounded-lg border border-border bg-surface px-3.5 py-1.5 text-sm font-medium hover:bg-surface-hover"
                  style={{ color: "var(--text)" }}
                >
                  {t("share")}
                </button>
                <button
                  onClick={onToggleEditMode}
                  className={`rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors ${
                    editMode
                      ? "bg-accent text-black shadow-sm"
                      : "border border-border bg-surface hover:bg-surface-hover"
                  }`}
                  style={editMode ? {} : { color: "var(--text)" }}
                >
                  {editMode ? t("done") : t("edit")}
                </button>
              </>
            )}
```

After (drop the Share `<button>`; the fragment now only wraps the single Edit/Done button, but the fragment syntax stays so the diff is minimal):

```jsx
            {playlist.isOwner && (
              <>
                <button
                  onClick={onToggleEditMode}
                  className={`rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors ${
                    editMode
                      ? "bg-accent text-black shadow-sm"
                      : "border border-border bg-surface hover:bg-surface-hover"
                  }`}
                  style={editMode ? {} : { color: "var(--text)" }}
                >
                  {editMode ? t("done") : t("edit")}
                </button>
              </>
            )}
```

(Keeping the fragment instead of unwrapping the single button is intentional — leaves the diff minimal and easy to roll back. The implementer should NOT remove the fragment.)

- [ ] **Step 6: Render the `OverflowMenu` after the Copy button**

After the existing Copy-button block (lines 188–196), still inside the same `<div className="flex flex-wrap items-center justify-end gap-2">` container, add:

```jsx
            <OverflowMenu items={overflowItems} />
```

The Copy block + new menu trigger should sit as the last two children of row 1.

- [ ] **Step 7: Remove the now-redundant Compact toggle and Public/Private toggle from the edit-mode row**

The edit-mode toolbar (the second flex row inside `<div className="flex min-w-0 flex-col items-end gap-1.5">`) currently renders, in order: Compact toggle, Batch toggle, Public/Private toggle, Add Clip, Delete (lines 199–246).

Remove the Compact toggle and the Public/Private toggle. Keep the Batch toggle, Add Clip, Delete in place. The result should be:

```jsx
          {editMode && playlist.isOwner && (
            <div className="flex flex-wrap items-center justify-end gap-2">
              <button
                onClick={onToggleBatch}
                className={`rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors ${
                  batchMode
                    ? "bg-purple-600 text-white shadow-sm"
                    : "border border-border bg-surface hover:bg-surface-hover"
                }`}
                style={batchMode ? {} : { color: "var(--text)" }}
              >
                {t("batch")}
              </button>
              <button
                onClick={onAddClip}
                className="rounded-lg bg-primary px-3.5 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-primary-hover"
              >
                {t("addClip")}
              </button>
              <button
                onClick={onDelete}
                className="rounded-lg border border-red-500/30 px-3.5 py-1.5 text-sm font-medium text-red-400 transition-colors hover:bg-red-500/10"
              >
                {t("delete")}
              </button>
            </div>
          )}
```

(Specifically: delete the Compact `<button>` block at the top of the edit-mode container, and delete the Public/Private `<button>` block that sat between Batch and Add Clip. Do not change the Batch, Add Clip, or Delete blocks.)

- [ ] **Step 8: Verify the dev server compiles cleanly**

Watch the frontend dev server terminal for a successful HMR recompile. No errors or warnings expected.

- [ ] **Step 9: Manual UI test — view mode, owner**

In the browser, log in as a playlist owner. Open one of your playlists (not in edit mode).

Expected on row 1: **Return, Unlike All, Edit, Copy Playlist, ⋯**.

Click the ⋯ button. Expected menu contents:
- `Share`
- `Auto-play: ON` or `Auto-play: OFF` (only if logged-in user is admin)
- `Compare`

Click `Share` — the share modal opens, and the menu closes. Re-open ⋯, click `Compare` — the compare flow triggers, menu closes. If admin, click the auto-play item — the label flips between ON/OFF and the active highlight appears when ON.

- [ ] **Step 10: Manual UI test — view mode, non-owner with copy permission**

Log in as a different user (or use a private window) who has copy permission on a playlist but is not its owner. Open that playlist.

Expected on row 1: **Return, Copy Playlist, ⋯** (no Unlike All, no Edit).

Open ⋯. Expected contents: `Compare` only (no Share — that's owner-only; no AutoPlay unless this user is also admin).

- [ ] **Step 11: Manual UI test — view mode, non-owner without copy permission**

Log in as a user who has neither owner nor copy permission on some playlist. Open it.

Expected on row 1: **Return, ⋯**.

Open ⋯. Expected: `Compare` only (or `Compare` + `Auto-play: ...` if admin).

- [ ] **Step 12: Manual UI test — edit mode, owner**

Log in as a playlist owner, open a playlist, click Edit.

Expected row 1: **Return, Unlike All, Done, Copy Playlist, ⋯**.

Expected row 2: **Batch, Add Clip, Delete**.

Open ⋯. Expected menu contents:
- `Share`
- `Auto-play: ON/OFF` (admin only)
- `Cards` or `List` (whichever toggles `compactView`)
- `Public` or `Private` (whichever toggles `playlist.isPublic`)

`Compare` should NOT appear in edit mode.

Click each item and verify it does what the corresponding pre-refactor button did (Share modal opens; Compact toggle flips between Cards/List; Public toggle flips between Public/Private with the active highlight).

- [ ] **Step 13: Manual UI test — close behaviors**

With the menu open: press `Escape` — the menu closes. Re-open and click outside the menu (e.g. on the playlist title) — the menu closes. Re-open and click any item — the menu closes after the action.

- [ ] **Step 14: Commit**

```
git add frontend/src/components/playlist/PlaylistHeader.js
git commit -m "Move Share/AutoPlay/Compare/Compact/Public-toggle into header overflow menu"
```

---

## Self-Review

**1. Spec coverage**

- Goal "reduce visible button count via overflow menu": covered by Tasks 1 (component) + 2 (wiring).
- Spec table "View mode visible": Return, Unlike All, Edit, Copy — unchanged in plan (Task 2 only removes overflow targets).
- Spec table "Edit mode row 1 visible": Return, Unlike All, Done, Copy — unchanged in plan.
- Spec table "Edit mode row 2 visible": Add Clip, Batch, Delete — Task 2 Step 7 removes only Compact and Public/Private; Batch + Add Clip + Delete stay.
- Spec table "Overflow menu items + when shown": Share (owner), AutoPlay (admin), Compare (not editMode), Compact (editMode + owner), Public/Private (editMode + owner) — all five items in Task 2 Step 2's `overflowItems` array, with `hidden` flags matching each row of the table.
- Spec "Trigger at end of row 1 after Copy" — Task 2 Step 6 places `<OverflowMenu>` there.
- Spec "Closes on outside click / Escape / item click" — Task 1 component code implements all three.
- Spec "active style for toggles" — Task 1 component applies primary-highlight when `it.active`; Task 2 sets `active: autoPlayEnabled`, `active: compactView`, `active: playlist.isPublic`.
- Spec "destructive style reserved" — supported in component, no item uses it initially (intentional, matches spec).
- Spec "no new i18n strings" — Task 2 uses only existing keys (`share`, `autoPlayOn`, `autoPlayOff`, `comparePlaylist`, `compactView`, `fullView`, `publicLabel`, `privateLabel`), verified against `frontend/src/i18n/en.js` lines 103–104, 125–126, 139–140, 196.
- Spec "no third-party library, no focus trap, no ARIA `role=menu`" — confirmed; component uses plain button + div with `aria-label` and `aria-expanded` only.
- Spec "mobile uses same anchored dropdown" — confirmed; component has no breakpoint-specific code.
- Spec manual test plan items 1–7 — covered by Task 2 Steps 9–13.

**2. Placeholder scan**

No "TBD", "TODO", "implement later", "add appropriate X", "similar to Task N", or undefined references. Every code block is complete.

**3. Type / name consistency**

- `OverflowMenu` default export — matches import in Task 2 Step 1.
- Prop name `items` — matches usage in Task 1 component and Task 2 Step 6 (`<OverflowMenu items={overflowItems} />`).
- Item field names `label`, `onClick`, `active`, `destructive`, `hidden` — matches between component code and array entries.
- `align` prop defaults to `"right"`; not passed in Task 2 (uses default). Consistent.
- Existing handlers `onShare`, `onCompare`, `onToggleCompact`, `onTogglePublic` are still destructured from props at the top of `PlaylistHeader` (lines 11–31 of current file) — not changed by this plan. The new `overflowItems` array calls them via optional-chaining (`onShare?.()` etc.) to match the safety pattern already used by `onUpdatePlaylist?.()` in `handleNameBlur`.
- `setAutoPlayEnabled` and `autoPlayEnabled` come from `usePlayerStore` at lines 34–35 of the current file — unchanged.
- `isAdmin` from `useAuth` at line 33 — unchanged.
- All five i18n keys referenced in `overflowItems` are confirmed to exist in `frontend/src/i18n/en.js` (lines 103, 104, 125, 126, 139, 140, 196).

No inconsistencies.
