/**
 * Paid add-ons: features sold on top of a membership rather than included.
 *
 * Who gets one:
 *   ADMIN  — always, so the feature can be exercised without buying it
 *   GUEST  — always, free during the trial. Handing guests the full
 *            experience is the point: they should miss it when it stops.
 *   MEMBER — only if an admin granted it
 *   PENDING — never; the account cannot log in at all
 */

/** Every add-on the app knows about. Adding one starts here. */
const ADD_ONS = Object.freeze({
  CAPTURE: 'capture',
});

/**
 * @param {{ role: string, entitlements?: string[] }} user
 * @param {string} addOn - one of ADD_ONS
 * @returns {boolean}
 */
function hasAddOn(user, addOn) {
  if (!user) return false;
  if (user.role === 'ADMIN' || user.role === 'GUEST') return true;
  return Array.isArray(user.entitlements) && user.entitlements.includes(addOn);
}

module.exports = { ADD_ONS, hasAddOn };
