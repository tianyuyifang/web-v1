/**
 * Strip the ETag from a response, so the browser cannot be answered with a 304.
 *
 * Express adds a weak ETag to every JSON response. When the body is unchanged
 * the browser revalidates and gets a 304, which by spec carries no body — so
 * the caller reads an undefined value where it expected data. Two endpoints
 * have been bitten by exactly this: the QR poll flickered between "waiting"
 * and nothing, and the tools page stopped showing the client version because
 * every request after the first returned 304 with an empty body.
 *
 * Cache-Control: no-store does NOT fix it; measured, Express still generates
 * the ETag and still answers 304. Only removing the header does.
 *
 * Stripped per route rather than via app.set('etag', false), because that
 * setting is global and would drop ETags from every other endpoint, where they
 * save real bandwidth.
 *
 * Use it on any route whose caller reads the body every time — a poll, or a
 * value the page renders from — and not on ones that are merely read often.
 */
function noEtag(req, res, next) {
  const end = res.end;
  res.end = function patched(...args) {
    res.removeHeader('ETag');
    return end.apply(this, args);
  };
  next();
}

module.exports = noEtag;
