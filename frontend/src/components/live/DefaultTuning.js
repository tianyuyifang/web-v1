"use client";

/**
 * The key and tempo a song opens in when it has none of its own.
 *
 * Floating. It belongs to the singer rather than to any one card, and it has
 * to be usable while a card is playing — choosing a default without hearing it
 * is a guess. On a desktop it stays open for that reason: a click between the
 * ear and the adjustment is the wrong way round for something tuned by
 * listening.
 *
 * On a phone it can be folded away, because there the cost runs the other way:
 * five rows of controls pinned over a small screen cover the cards being
 * tuned. Collapsed, it keeps the current key and tempo on the button, so the
 * setting in force is still readable without opening anything.
 *
 * Two rows, laid out the same way: minus, the current value, plus. The value
 * in the middle is what is actually in force, so the row reads as one thing
 * rather than as a control and a separate readout.
 */

import { useEffect, useState } from "react";

import { PITCH_STEPS, SPEED_STEPS, sameValue, stepAlong } from "./ladderStyle";
import LiveVolumeControl, { QUALITY_TIERS } from "./LiveVolumeControl";

/** Remembered so the panel opens the way you left it, per device. */
const COLLAPSE_KEY = "live-tuning-collapsed";

/**
 * Signed, so +2 and −2 are told apart without reading the sign twice.
 *
 * 0 rather than 原调, matching the ladders on the cards: the two are read
 * together and a word among numbers made the column jump.
 */
function pitchLabel(n) {
  const v = typeof n === "number" ? n : 0;
  return v === 0 ? "0" : `${v > 0 ? "+" : "−"}${Math.abs(v)}`;
}

/**
 * Written as the ladder writes it — 1, not 1.00 — since the two are read
 * together. The column has a fixed width, so nothing jumps.
 */
function speedLabel(n) {
  return String(typeof n === "number" ? n : 1);
}

const STEP_BUTTON = "flex h-6 w-6 shrink-0 items-center justify-center rounded-md "
  + "border border-border text-xs leading-none text-muted transition-colors "
  + "hover:border-accent hover:text-theme disabled:opacity-30";

function Stepper({ label, value, onStep, canDown, canUp, disabled }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="w-7 shrink-0 text-[0.65rem] text-muted">{label}</span>
      <button
        type="button"
        disabled={disabled || !canDown}
        onClick={() => onStep(-1)}
        className={STEP_BUTTON}
      >
        −
      </button>
      {/* Fixed width so the buttons hold still as the number changes, and the
          same face the ladders use so the two read as one family. */}
      <span className="w-12 text-center font-mono text-[0.7rem] text-theme">
        {value}
      </span>
      <button
        type="button"
        disabled={disabled || !canUp}
        onClick={() => onStep(1)}
        className={STEP_BUTTON}
      >
        +
      </button>
    </div>
  );
}

export default function DefaultTuning({
  defaults, onChange, disabled,
  volume, onVolumeChange,
  quality, onQualityChange,
  vocalsOnly, onVocalsChange, vocalsAvailable,
}) {
  const pitch = typeof defaults?.pitch === "number" ? defaults.pitch : 0;
  const speed = typeof defaults?.speed === "number" ? defaults.speed : 1;

  // Starts open, then adopts the stored choice after mount. Reading storage
  // during render would make the server and the first client paint disagree.
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try {
      if (localStorage.getItem(COLLAPSE_KEY) === "1") setCollapsed(true);
    } catch {
      // private mode; the panel simply opens expanded
    }
  }, []);

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        // nothing to do; the choice just will not survive a reload
      }
      return next;
    });
  };

  // Walks the card's own ladders rather than counting in fixed increments, so
  // a default can only ever be a value the card can show as selected. Stepping
  // by one semitone would let the default reach -3, where the row underneath
  // would light no button at all while the song played shifted.
  const stepPitch = (dir) => {
    const next = stepAlong(PITCH_STEPS, pitch, dir);
    if (next !== pitch) onChange({ pitch: next });
  };

  const stepSpeed = (dir) => {
    const next = stepAlong(SPEED_STEPS, speed, dir);
    if (!sameValue(next, speed)) onChange({ speed: next });
  };

  // Collapsing works on every device: when collapsed, the folded button
  // shows and the panel is hidden; when expanded, the reverse. The stored
  // preference now applies everywhere, phone and desktop alike.
  return (
    <>
    {collapsed && (
      <button
        type="button"
        onClick={toggleCollapsed}
        aria-expanded="false"
        title="展开全局设置"
        className="fixed bottom-4 right-4 z-30 flex items-center gap-1.5 rounded-xl border border-border bg-surface px-3 py-2 text-[0.7rem] shadow-xl sm:bottom-6 sm:right-6"
      >
        <span className="font-medium text-theme">全局设置</span>
        {/* The values ride on the button: folded away, this is the only place
            the key and tempo in force can still be read. */}
        <span className="text-muted">
          {pitchLabel(defaults?.pitch)} · {speedLabel(defaults?.speed)}x
        </span>
        <span aria-hidden="true" className="text-muted">▲</span>
      </button>
    )}

    <div
      // Above the cards, below any dialog. Clear of the bottom edge on a phone
      // so it does not sit under the thumb rest.
      className={`fixed bottom-4 right-4 z-30 max-h-[70vh] overflow-y-auto rounded-xl border border-border bg-surface px-3 py-2.5 shadow-xl sm:bottom-6 sm:right-6 sm:max-h-none sm:overflow-visible ${
        collapsed ? "hidden" : ""
      }`}
    >
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-[0.7rem] font-medium text-theme">全局设置</span>
        {/* Collapsible on every device now: folding the panel away is useful
            on a desktop too when it sits over the cards. */}
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-expanded="true"
          title="收起全局设置"
          className="-my-1 -mr-1 px-1 py-1 text-[0.7rem] leading-none text-muted hover:text-theme"
        >
          ▼
        </button>
      </div>

      <div className="space-y-1.5">
        <Stepper
          label="变调"
          value={pitchLabel(defaults?.pitch)}
          onStep={stepPitch}
          canDown={pitch > PITCH_STEPS[0]}
          canUp={pitch < PITCH_STEPS[PITCH_STEPS.length - 1]}
          disabled={disabled}
        />
        <Stepper
          label="变速"
          value={speedLabel(defaults?.speed)}
          onStep={stepSpeed}
          canDown={speed > SPEED_STEPS[0]}
          canUp={speed < SPEED_STEPS[SPEED_STEPS.length - 1]}
          disabled={disabled}
        />

        {/* Volume belongs here rather than on a card: it is one level for the
            whole evening, not a property of a song. Separated by a rule
            because it is the one row that takes effect immediately and is not
            a default for something later. */}
        {onVolumeChange ? (
          <div className="mt-2 border-t border-border/60 pt-2">
            <div className="flex items-center gap-1.5">
              <span className="w-7 shrink-0 text-right text-[0.62rem] text-muted">音量</span>
              <LiveVolumeControl volume={volume} onChange={onVolumeChange} />
            </div>
          </div>
        ) : null}

        {/* Quality and the vocals track both change which file plays, so they
            sit together and apart from the tuning above. Both take effect on
            the song already playing — swapped in without a gap — since a
            setting you cannot hear the effect of is one you cannot judge. */}
        {onQualityChange ? (
          <div className="mt-2 border-t border-border/60 pt-2">
            <div className="mb-1 flex items-center gap-1.5">
              <span className="w-7 shrink-0 text-right text-[0.62rem] text-muted">音质</span>
              <div className="flex flex-wrap gap-1">
                {QUALITY_TIERS.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    disabled={disabled}
                    onClick={() => onQualityChange(t.id)}
                    title={t.note || t.label}
                    className={`rounded border px-1.5 py-0.5 text-[0.62rem] transition-colors disabled:opacity-30 ${
                      quality === t.id
                        ? "border-accent text-accent"
                        : "border-border text-muted hover:border-accent/50 hover:text-theme"
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
            {/* Said where it is chosen, not discovered later by a slow shift. */}
            {QUALITY_TIERS.find((t) => t.id === quality)?.note ? (
              <p className="pl-9 text-[0.58rem] leading-snug text-muted/70">
                {QUALITY_TIERS.find((t) => t.id === quality).note}
              </p>
            ) : null}
          </div>
        ) : null}

        {onVocalsChange ? (
          <div className="mt-2 border-t border-border/60 pt-2">
            <label
              className={`flex items-center gap-2 text-[0.65rem] ${
                vocalsAvailable === false ? "opacity-40" : "cursor-pointer"
              }`}
            >
              <input
                type="checkbox"
                checked={!!vocalsOnly}
                disabled={disabled || vocalsAvailable === false}
                onChange={(e) => onVocalsChange(e.target.checked)}
                className="h-3 w-3 accent-accent"
              />
              <span className="text-theme">只听人声</span>
              <span className="text-muted/70">
                {vocalsAvailable === false ? "这首没有" : "无原伴奏"}
              </span>
            </label>
          </div>
        ) : null}

        {/* Keyboard shortcuts for the open card's player. Desktop only —
            hidden below sm entirely, since a phone has no keyboard to press
            and this panel folds away there anyway. The whole panel is where a
            desktop singer's controls already live, so the keys that do the
            same job belong beside them. */}
        <div className="mt-2 hidden border-t border-border/60 pt-2 sm:block">
          <p className="mb-1 text-[0.6rem] font-medium text-muted/80">键盘快捷键</p>
          <div className="space-y-0.5 text-[0.6rem] leading-relaxed text-muted/70">
            <div className="flex items-center gap-1.5">
              <kbd className="rounded border border-border px-1 font-mono text-theme">A</kbd>
              <span>/</span>
              <kbd className="rounded border border-border px-1 font-mono text-theme">D</kbd>
              <span className="text-muted/50">或</span>
              <kbd className="rounded border border-border px-1 font-mono text-theme">←</kbd>
              <span>/</span>
              <kbd className="rounded border border-border px-1 font-mono text-theme">→</kbd>
              <span className="ml-0.5">微调 1 秒</span>
            </div>
            <div className="flex items-center gap-1.5">
              <kbd className="rounded border border-border px-1 font-mono text-theme">W</kbd>
              <span>/</span>
              <kbd className="rounded border border-border px-1 font-mono text-theme">S</kbd>
              <span className="ml-0.5">上 / 下一句歌词</span>
            </div>
          </div>
        </div>
      </div>
    </div>
    </>
  );
}
