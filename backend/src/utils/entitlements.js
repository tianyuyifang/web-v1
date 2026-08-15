/**
 * Add-ons: the extras that make up 加订版, the tier above a plain membership.
 * They are sold as one bundle rather than à la carte, so holding any of them
 * means holding the tier — a new extra is a new string here plus a row in the
 * pricing table, with no change to what anything costs.
 *
 * Who gets one:
 *   ADMIN  — always, so the feature can be exercised without buying it
 *   MEMBER / GUEST — only what an admin granted
 *   PENDING — never; the account cannot log in at all
 */

/** Every add-on the app knows about. Adding one starts here. */
const ADD_ONS = Object.freeze({
  CAPTURE: 'capture',
});

/** Everything included in 加订版, granted and revoked together. */
const ALL_ADD_ONS = Object.freeze(Object.values(ADD_ONS));

/**
 * @param {{ role: string, entitlements?: string[] }} user
 * @param {string} addOn - one of ADD_ONS
 * @returns {boolean}
 */
function hasAddOn(user, addOn) {
  if (!user) return false;
  if (user.role === 'ADMIN') return true;
  return Array.isArray(user.entitlements) && user.entitlements.includes(addOn);
}

module.exports = { ADD_ONS, ALL_ADD_ONS, hasAddOn };
