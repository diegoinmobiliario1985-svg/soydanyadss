/**
 * routes/products.js
 * CRUD de productos/cursos. Rutas públicas de lectura, admin para escritura.
 */

const express = require('express');
const router = express.Router();
const { db } = require('../database/db');
const { verificarJWT, soloAdmin } = require('../middleware/auth');

// ─── GET /api/products ────────────────────────────────────────────────────────
// Lista pública de productos activos
router.get('/', (req, res) => {
  try {
    const productos = db.prepare(`
      SELECT id, name, description, price, original_price, image_url, features
      FROM products
      WHERE active = 1
      ORDER BY id ASC
    `).all();

    // Parsear features de JSON a array
    const resultado = productos.map(p => ({
      ...p,
      features: p.features ? JSON.parse(p.features) : []
    }));

    res.json(resultado);
  } catch (err) {
    console.error('Error listando productos:', err);
    res.status(500).json({ error: 'Error al obtener productos.' });
  }
});

// ─── GET /api/products/:id ────────────────────────────────────────────────────
// Detalle de un producto
router.get('/:id', (req, res) => {
  try {
    const producto = db.prepare(`
      SELECT p.*, c.id as course_id, c.title as course_title
      FROM products p
      LEFT JOIN courses c ON c.product_id = p.id
      WHERE p.id = ? AND p.active = 1
    `).get(req.params.id);

    if (!producto) {
      return res.status(404).json({ error: 'Producto no encontrado.' });
    }

    producto.features = producto.features ? JSON.parse(producto.features) : [];
    res.json(producto);
  } catch (err) {
    console.error('Error obteniendo producto:', err);
    res.status(500).json({ error: 'Error al obtener el producto.' });
  }
});

// ─── POST /api/products ───────────────────────────────────────────────────────
// Crear producto (solo admin)
router.post('/', verificarJWT, soloAdmin, (req, res) => {
  try {
    const { name, description, price, original_price, stripe_price_id, image_url, features } = req.body;

    if (!name || price === undefined) {
      return res.status(400).json({ error: 'Nombre y precio son requeridos.' });
    }

    const result = db.prepare(`
      INSERT INTO products (name, description, price, original_price, stripe_price_id, image_url, features, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      name,
      description || '',
      parseFloat(price),
      original_price ? parseFloat(original_price) : null,
      stripe_price_id || '',
      image_url || '',
      features ? JSON.stringify(features) : '[]'
    );

    // Crear el curso asociado automáticamente
    db.prepare(`
      INSERT INTO courses (product_id, title, description)
      VALUES (?, ?, ?)
    `).run(result.lastInsertRowid, name, description || '');

    const nuevo = db.prepare('SELECT * FROM products WHERE id = ?').get(result.lastInsertRowid);
    nuevo.features = JSON.parse(nuevo.features);

    res.status(201).json(nuevo);
  } catch (err) {
    console.error('Error creando producto:', err);
    res.status(500).json({ error: 'Error al crear el producto.' });
  }
});

// ─── PUT /api/products/:id ────────────────────────────────────────────────────
// Actualizar producto (solo admin)
router.put('/:id', verificarJWT, soloAdmin, (req, res) => {
  try {
    const { name, description, price, original_price, stripe_price_id, image_url, features, active } = req.body;
    const id = req.params.id;

    const existente = db.prepare('SELECT id FROM products WHERE id = ?').get(id);
    if (!existente) {
      return res.status(404).json({ error: 'Producto no encontrado.' });
    }

    db.prepare(`
      UPDATE products SET
        name = COALESCE(?, name),
        description = COALESCE(?, description),
        price = COALESCE(?, price),
        original_price = COALESCE(?, original_price),
        stripe_price_id = COALESCE(?, stripe_price_id),
        image_url = COALESCE(?, image_url),
        features = COALESCE(?, features),
        active = COALESCE(?, active)
      WHERE id = ?
    `).run(
      name || null,
      description || null,
      price !== undefined ? parseFloat(price) : null,
      original_price !== undefined ? parseFloat(original_price) : null,
      stripe_price_id || null,
      image_url || null,
      features ? JSON.stringify(features) : null,
      active !== undefined ? (active ? 1 : 0) : null,
      id
    );

    const actualizado = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    actualizado.features = JSON.parse(actualizado.features);

    res.json(actualizado);
  } catch (err) {
    console.error('Error actualizando producto:', err);
    res.status(500).json({ error: 'Error al actualizar el producto.' });
  }
});

// ─── DELETE /api/products/:id ─────────────────────────────────────────────────
// Eliminar (desactivar) producto (solo admin)
router.delete('/:id', verificarJWT, soloAdmin, (req, res) => {
  try {
    const existente = db.prepare('SELECT id FROM products WHERE id = ?').get(req.params.id);
    if (!existente) {
      return res.status(404).json({ error: 'Producto no encontrado.' });
    }

    // Desactivar en lugar de eliminar para preservar historial
    db.prepare('UPDATE products SET active = 0 WHERE id = ?').run(req.params.id);
    res.json({ mensaje: 'Producto desactivado correctamente.' });
  } catch (err) {
    console.error('Error eliminando producto:', err);
    res.status(500).json({ error: 'Error al eliminar el producto.' });
  }
});

module.exports = router;
