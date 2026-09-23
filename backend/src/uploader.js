/**
 * Who performed an upload. For a real request it is the signed-in user from the
 * verified token (set by requireAuth) — never the client-supplied `uploadedBy`
 * field, which anyone could set to any name. Only the in-process folder
 * automation (no HTTP request, so no token) falls back to the label it passes
 * in the body.
 *
 * Its own module, not middleware/auth.js: that one refuses to load without
 * JWT_SECRET, and the upload routes (and their DB-free unit tests) only need
 * this pure helper.
 */
function uploaderOf(req) {
  return req.user?.employeeId ?? req.body?.uploadedBy ?? null;
}

module.exports = { uploaderOf };
