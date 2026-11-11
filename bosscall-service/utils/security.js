// Minimal async wrapper (same semantics as the Salon backend's utils/security.js
// `wrap`): any crash inside a route becomes a clean 500 instead of hanging.
function serverError(res, err, where = "") {
  console.error("SERVER ERROR", where, err);
  if (!res.headersSent) {
    res.status(500).json({ ok: false, message: "Internal server error" });
  }
}

function wrap(fn) {
  return (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch((err) => serverError(res, err, req.originalUrl));
}

module.exports = { wrap, serverError };
