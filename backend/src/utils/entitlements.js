/**
 * Add-ons: the extras that make up 加订版, the tier above a plain membership.
 * They are sold as one bundle rather than à la carte, so holding any of them
 * means holding the tier — a new extra is a new string here plus a row in the
 * pricing table, with no change to what anything costs.
 *
 * Who gets one:
 *   ADMIN  — always, so the feature can be exercised without buying it
 *   MEMBER — only what an admin granted
 *   PENDING — never; the account cannot log in at all
 */

/** Every add-on the app knows about. Adding one starts here. */
const ADD_ONS = Object.freeze({
  CAPTURE: 'capture',
  // 平台打标: like songs straight into the user's own QQ / NetEase account.
  // Tier-driven like capture; during the closed beta only 挚友 has it.
  PLATFORM_TAGGING: 'platform_tagging',
});

/**
 * Which field of a tier's config grants each tier-driven add-on. An add-on
 * absent here can only come from the per-user override.
 */
const TIER_FIELD = Object.freeze({
  [ADD_ONS.CAPTURE]: 'capture',
  [ADD_ONS.PLATFORM_TAGGING]: 'platformTagging',
});

/**
 * Everything included in 加订版, granted and revoked together. Deliberately
 * not every add-on: 平台打标 is its own closed-beta gate, not part of the
 * bundle, so granting 加订版 must not grant it.
 */
const ALL_ADD_ONS = Object.freeze([ADD_ONS.CAPTURE]);

/**
 * Whether a user holds an add-on, honouring both the per-user override and the
 * membership tier.
 *
 *   ADMIN               → every add-on, always
 *   entitlements list   → a per-user override; a non-empty list is what an
 *                         admin set by hand and it wins
 *   tier                → otherwise the tier's config decides. Only CAPTURE is
 *                         tier-driven today (a tier either includes 加订 or not);
 *                         a future à-la-carte add-on would extend this.
 *
 * @param {{ role: string, entitlements?: string[], tier?: string|null }} user
 * @param {string} addOn - one of ADD_ONS
 * @param {object} [tierConfig] - getTiers() output; omitted where only the
 *   override matters (or where the caller has none to hand).
 * @returns {boolean}
 */
function hasAddOn(user, addOn, tierConfig) {
  if (!user) return false;
  if (user.role === 'ADMIN') return true;
  // A per-user override wins when present.
  if (Array.isArray(user.entitlements) && user.entitlements.includes(addOn)) {
    return true;
  }
  // Otherwise the tier grants it, through the field named for this add-on.
  const field = TIER_FIELD[addOn];
  if (field && user.tier && tierConfig && tierConfig[user.tier]) {
    return !!tierConfig[user.tier][field];
  }
  return false;
}

module.exports = { ADD_ONS, ALL_ADD_ONS, TIER_FIELD, hasAddOn };
