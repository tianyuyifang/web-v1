// How a usage alert (an account that went over a limit) reads on the admin page.

export const LEVEL_RANK = { first: 1, repeat: 2, revoke: 3 };

// first: went over the first line once — most likely a heavy user.
// repeat: keeps coming back to the line. revoke: reached the second line.
export const LEVEL_STYLE = {
  first: { name: "", tag: "bg-gray-500/15 text-muted" },
  repeat: { name: "text-orange-400", tag: "bg-orange-500/15 text-orange-400" },
  revoke: { name: "text-red-400", tag: "bg-red-500/15 text-red-400" },
};

/** "整首歌 983/40 · 已达撤销线" */
export function alertText(alert, labels = {}) {
  const what = labels[alert.category] || alert.category;
  const span = alert.window === "day" ? "一天" : "10分钟";
  let text = `${what} ${span} ${alert.count}/${alert.limitValue}`;
  if (alert.level === "revoke") text += alert.autoRevoked ? " · 已自动撤销" : " · 已达撤销线";
  else if (alert.level === "repeat") {
    if (alert.window === "day") text += " · 已到当日上限";
    else if (alert.episodes >= 3) text += ` · 当天第 ${alert.episodes} 次碰线`;
    else text += " · 连续两天碰线";
  }
  // Whitelisted: it went over, and nothing was refused.
  if (alert.exempt) text += " · 白名单，未限制";
  return text;
}

/** The most serious of a user's open alerts, or null. */
export function worstLevel(alerts) {
  let worst = null;
  for (const a of alerts || []) {
    if (!worst || LEVEL_RANK[a.level] > LEVEL_RANK[worst]) worst = a.level;
  }
  return worst;
}

/** Open alerts grouped by user id. */
export function groupByUser(open) {
  const map = {};
  for (const a of open || []) (map[a.userId] = map[a.userId] || []).push(a);
  return map;
}
