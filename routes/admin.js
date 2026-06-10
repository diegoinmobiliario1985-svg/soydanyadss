/**
 * routes/admin.js
 * Panel de administración: usuarios, estadísticas, gestión de accesos.
 */

const express = require('express');
const router = express.Router();
const { db } = require('../database/db');
const { verificarJWT, soloAdmin } = require('../middleware/auth');

// Todas las rutas de admin requieren autenticación y rol admin
router.use(verificarJWT, soloAdmin);

// ─── GET /api/admin/stats ─────────────────────────────────────────────────────
// Métricas del negocio
router.get('/stats', (req, res) => {
  try {
    const totalUsuarios = db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'student'").get().c;
    const totalRecaudado = db.prepare("SELECT COALESCE(SUM(amount), 0) as t FROM purchases WHERE status = 'completed'").get().t;
    const totalVentas = db.prepare("SELECT COUNT(*) as c FROM purchases WHERE status = 'completed'").get().c;
    const ventasHoy = db.prepare(`
      SELECT COUNT(*) as c FROM purchases
      WHERE status = 'completed' AND created_at >= unixepoch('now', 'start of day')
    `).get().c;
    const totalProductos = db.prepare('SELECT COUNT(*) as c FROM products WHERE active = 1').get().c;
    const totalVideos = db.prepare('SELECT COUNT(*) as c FROM lessons').get().c;

    // Últimos 7 días de ventas
    const ventasPorDia = db.prepare(`
      SELECT date(created_at, 'unixepoch') as fecha,
             COUNT(*) as ventas,
             SUM(amount) as total
      FROM purchases
      WHERE status = 'completed' AND created_at >= unixepoch('now', '-7 days')
      GROUP BY fecha
      ORDER BY fecha ASC
    `).all();

    res.json({
      totalUsuarios,
      totalRecaudado,
      totalVentas,
      ventasHoy,
      totalProductos,
      totalVideos,
      ventasPorDia
    });
  } catch (err) {
    console.error('Error en stats:', err);
    res.status(500).json({ error: 'Error al obtener estadísticas.' });
  }
});

// ─── GET /api/admin/users ─────────────────────────────────────────────────────
// Lista de todos los usuarios con sus compras
router.get('/users', (req, res) => {
  try {
    const usuarios = db.prepare(`
      SELECT u.id, u.name, u.email, u.role, u.created_at,
             COUNT(pu.id) as total_compras,
             COALESCE(SUM(CASE WHEN pu.status = 'completed' THEN pu.amount ELSE 0 END), 0) as total_gastado
      FROM users u
      LEFT JOIN purchases pu ON pu.user_id = u.id
      GROUP BY u.id
      ORDER BY u.created_at DESC
    `).all();

    res.json(usuarios);
  } catch (err) {
    console.error('Error listando usuarios:', err);
    res.status(500).json({ error: 'Error al obtener usuarios.' });
  }
});

// ─── GET /api/admin/users/:id ─────────────────────────────────────────────────
// Detalle de un usuario con sus cursos
router.get('/users/:id', (req, res) => {
  try {
    const usuario = db.prepare(`
      SELECT id, name, email, role, stripe_customer_id, created_at
      FROM users WHERE id = ?
    `).get(req.params.id);

    if (!usuario) {
      return res.status(404).json({ error: 'Usuario no encontrado.' });
    }

    const compras = db.prepare(`
      SELECT pu.id, pu.amount, pu.status, pu.created_at, pu.stripe_payment_id,
             p.name as product_name, p.id as product_id
      FROM purchases pu
      JOIN products p ON p.id = pu.product_id
      WHERE pu.user_id = ?
      ORDER BY pu.created_at DESC
    `).all(req.params.id);

    res.json({ usuario, compras });
  } catch (err) {
    console.error('Error obteniendo usuario:', err);
    res.status(500).json({ error: 'Error al obtener el usuario.' });
  }
});

// ─── PUT /api/admin/users/:id/access ─────────────────────────────────────────
// Asignar o revocar acceso a un curso manualmente
router.put('/users/:id/access', (req, res) => {
  try {
    const { productId, action } = req.body; // action: 'grant' | 'revoke'

    if (!productId || !action) {
      return res.status(400).json({ error: 'productId y action son requeridos.' });
    }

    const usuario = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
    if (!usuario) {
      return res.status(404).json({ error: 'Usuario no encontrado.' });
    }

    const producto = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    if (!producto) {
      return res.status(404).json({ error: 'Producto no encontrado.' });
    }

    if (action === 'grant') {
      // Verificar si ya tiene acceso
      const existente = db.prepare(`
        SELECT id FROM purchases WHERE user_id = ? AND product_id = ? AND status = 'completed'
      `).get(req.params.id, productId);

      if (!existente) {
        db.prepare(`
          INSERT INTO purchases (user_id, product_id, stripe_payment_id, amount, status)
          VALUES (?, ?, ?, 0, 'completed')
        `).run(req.params.id, productId, `manual_admin_${Date.now()}`);
      }
      res.json({ mensaje: 'Acceso concedido correctamente.' });
    } else if (action === 'revoke') {
      db.prepare(`
        UPDATE purchases SET status = 'revoked'
        WHERE user_id = ? AND product_id = ? AND status = 'completed'
      `).run(req.params.id, productId);
      res.json({ mensaje: 'Acceso revocado correctamente.' });
    } else {
      res.status(400).json({ error: 'Action debe ser "grant" o "revoke".' });
    }
  } catch (err) {
    console.error('Error gestionando acceso:', err);
    res.status(500).json({ error: 'Error al gestionar el acceso.' });
  }
});

// ─── PUT /api/admin/users/:id ─────────────────────────────────────────────────
// Actualizar datos de un usuario (cambiar rol, etc.)
router.put('/users/:id', (req, res) => {
  try {
    const { name, email, role } = req.body;
    const id = req.params.id;

    const usuario = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
    if (!usuario) {
      return res.status(404).json({ error: 'Usuario no encontrado.' });
    }

    // Validar rol
    if (role && !['student', 'admin'].includes(role)) {
      return res.status(400).json({ error: 'Rol inválido. Debe ser "student" o "admin".' });
    }

    db.prepare(`
      UPDATE users SET
        name = COALESCE(?, name),
        email = COALESCE(?, email),
        role = COALESCE(?, role)
      WHERE id = ?
    `).run(name || null, email ? email.toLowerCase() : null, role || null, id);

    const actualizado = db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(id);
    res.json(actualizado);
  } catch (err) {
    console.error('Error actualizando usuario:', err);
    res.status(500).json({ error: 'Error al actualizar el usuario.' });
  }
});

// ─── GET /api/admin/courses ───────────────────────────────────────────────────
// Lista de todos los cursos con sus lecciones
router.get('/courses', (req, res) => {
  try {
    const cursos = db.prepare(`
      SELECT c.*, p.name as product_name, p.price,
             COUNT(l.id) as total_lecciones
      FROM courses c
      JOIN products p ON p.id = c.product_id
      LEFT JOIN lessons l ON l.course_id = c.id
      GROUP BY c.id
      ORDER BY c.id ASC
    `).all();

    res.json(cursos);
  } catch (err) {
    console.error('Error listando cursos:', err);
    res.status(500).json({ error: 'Error al obtener cursos.' });
  }
});

// ─── GET /api/admin/courses/:id/lessons ───────────────────────────────────────
// Lecciones de un curso específico
router.get('/courses/:id/lessons', (req, res) => {
  try {
    const lecciones = db.prepare(`
      SELECT * FROM lessons WHERE course_id = ? ORDER BY sort_order ASC
    `).all(req.params.id);

    res.json(lecciones);
  } catch (err) {
    console.error('Error listando lecciones:', err);
    res.status(500).json({ error: 'Error al obtener lecciones.' });
  }
});

// ─── PUT /api/admin/lessons/:id ───────────────────────────────────────────────
// Actualizar datos de una lección
router.put('/lessons/:id', (req, res) => {
  try {
    const { title, sortOrder, duration } = req.body;
    const id = req.params.id;

    db.prepare(`
      UPDATE lessons SET
        title = COALESCE(?, title),
        sort_order = COALESCE(?, sort_order),
        duration = COALESCE(?, duration)
      WHERE id = ?
    `).run(title || null, sortOrder || null, duration || null, id);

    const leccion = db.prepare('SELECT * FROM lessons WHERE id = ?').get(id);
    res.json(leccion);
  } catch (err) {
    console.error('Error actualizando lección:', err);
    res.status(500).json({ error: 'Error al actualizar la lección.' });
  }
});

module.exports = router;
