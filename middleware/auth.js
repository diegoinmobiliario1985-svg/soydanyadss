/**
 * middleware/auth.js
 * Middlewares de verificación JWT para proteger rutas.
 */

const jwt = require('jsonwebtoken');

/**
 * Verifica que el request incluya un JWT válido.
 * El token puede venir en el header Authorization: Bearer <token>
 */
function verificarJWT(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // "Bearer TOKEN"

  if (!token) {
    return res.status(401).json({ error: 'Acceso denegado. Token requerido.' });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.usuario = payload; // { id, email, role, name }
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Sesión expirada. Inicia sesión de nuevo.' });
    }
    return res.status(403).json({ error: 'Token inválido.' });
  }
}

/**
 * Verifica que el usuario autenticado tenga rol "admin".
 * Debe usarse después de verificarJWT.
 */
function soloAdmin(req, res, next) {
  if (req.usuario.role !== 'admin') {
    return res.status(403).json({ error: 'Acceso restringido a administradores.' });
  }
  next();
}

module.exports = { verificarJWT, soloAdmin };
