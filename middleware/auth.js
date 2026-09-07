const jwt = require("jsonwebtoken");

function protect(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Login required" });
  }

  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // { id, role }
    next();
  } catch (err) {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
}

// Sirf owner hi ye route use kar sake
function ownerOnly(req, res, next) {
  if (req.user.role !== "owner") {
    return res.status(403).json({ message: "Only salon owners allowed" });
  }
  next();
}

module.exports = { protect, ownerOnly };
