const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '8h';

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET env var must be set to a random string of at least 32 characters. Refusing to start with an insecure or missing secret.');
}

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN, algorithm: 'HS256' });
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    req.user = verifyToken(token); // { sub, employeeId, role }
    return next();
  } catch (err) {
    const message = err.name === 'TokenExpiredError' ? 'Session expired' : 'Invalid token';
    return res.status(401).json({ error: message });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'Admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  return next();
}

/**
 * requireAuth for everything under a mount point except the listed public
 * paths (full paths, e.g. '/api/auth/login'). Secure by default: a route added
 * later is covered without anyone remembering to protect it.
 */
function requireAuthExcept(publicPaths) {
  const open = new Set(publicPaths);
  return (req, res, next) => {
    const urlPath = (req.originalUrl || req.url || '').split('?')[0].replace(/\/+$/, '');
    return open.has(urlPath) ? next() : requireAuth(req, res, next);
  };
}

module.exports = { signToken, verifyToken, requireAuth, requireAdmin, requireAuthExcept };
