/**
 * Everything bundled into 加订版, the tier above a plain membership.
 *
 * Mirrors ALL_ADD_ONS in backend/src/utils/entitlements.js. They are granted
 * and revoked as one bundle, so the admin UI toggles this whole list rather
 * than a box per feature. Adding a paid feature means adding its key here and
 * on the server, plus a row in the pricing table.
 */
export const ALL_ADD_ONS = ["capture"];
