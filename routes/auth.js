/**
 * routes/auth.js
 * Endpoints de autenticación: registro, login, perfil, recuperar contraseña.
 */

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { db } = require('../database/db');
const { verificarJWT } = require('../middleware/auth');

// ─── Configurar transporte de email ───────────────────────────────────────────
function crearTransporte() {
  return nodemailer.createTransport({
    host: process.env.EMAIL_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.EMAIL_PORT) || 587,
    secure: false,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS
    }
  });
}

// ─── Generar JWT ──────────────────────────────────────────────────────────────
function generarToken(usuario) {
  return jwt.sign(
    { id: usuario.id, email: usuario.email, role: usuario.role, name: usuario.name },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

// ─── POST /api/auth/register ──────────────────────────────────────────────────
// Registro manual de usuario (también usado internamente tras pago)
router.post('/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;

    // Validaciones básicas
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Nombre, email y contraseña son requeridos.' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'El email no tiene un formato válido.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres.' });
    }

    // Verificar que el email no esté registrado
    const existente = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
    if (existente) {
      return res.status(409).json({ error: 'Este email ya está registrado.' });
    }

    // Hashear contraseña y guardar
    const hash = await bcrypt.hash(password, 12);
    const result = db.prepare(`
      INSERT INTO users (name, email, password_hash, role)
      VALUES (?, ?, ?, 'student')
    `).run(name.trim(), email.toLowerCase(), hash);

    const usuario = db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(result.lastInsertRowid);
    const token = generarToken(usuario);

    res.status(201).json({ mensaje: 'Cuenta creada exitosamente.', token, usuario });
  } catch (err) {
    console.error('Error en registro:', err);
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

// ─── POST /api/auth/login ─────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email y contraseña son requeridos.' });
    }

    // Buscar usuario
    const usuario = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
    if (!usuario) {
      return res.status(401).json({ error: 'Credenciales incorrectas.' });
    }

    // Verificar contraseña
    const coincide = await bcrypt.compare(password, usuario.password_hash);
    if (!coincide) {
      return res.status(401).json({ error: 'Credenciales incorrectas.' });
    }

    const token = generarToken(usuario);
    res.json({
      token,
      usuario: { id: usuario.id, name: usuario.name, email: usuario.email, role: usuario.role }
    });
  } catch (err) {
    console.error('Error en login:', err);
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

// ─── GET /api/auth/me ─────────────────────────────────────────────────────────
// Obtener datos del usuario autenticado y sus cursos
router.get('/me', verificarJWT, (req, res) => {
  try {
    const usuario = db.prepare('SELECT id, name, email, role, created_at FROM users WHERE id = ?').get(req.usuario.id);
    if (!usuario) {
      return res.status(404).json({ error: 'Usuario no encontrado.' });
    }

    // Obtener cursos comprados (pagos completados)
    const cursos = db.prepare(`
      SELECT p.id as product_id, p.name, p.description, p.image_url,
             pu.created_at as purchase_date, c.id as course_id
      FROM purchases pu
      JOIN products p ON p.id = pu.product_id
      LEFT JOIN courses c ON c.product_id = p.id
      WHERE pu.user_id = ? AND pu.status = 'completed'
    `).all(req.usuario.id);

    res.json({ usuario, cursos });
  } catch (err) {
    console.error('Error en /me:', err);
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

// ─── POST /api/auth/forgot ────────────────────────────────────────────────────
// Solicitar recuperación de contraseña
router.post('/forgot', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'El email es requerido.' });
    }

    const usuario = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());

    // Siempre responder lo mismo para no revelar si el email existe
    const respuesta = { mensaje: 'Si ese email está registrado, recibirás un enlace de recuperación.' };

    if (!usuario) return res.json(respuesta);

    // Generar token de reset
    const token = crypto.randomBytes(32).toString('hex');
    const expira = Date.now() + 3600000; // 1 hora

    db.prepare('UPDATE users SET reset_token = ?, reset_expires = ? WHERE id = ?')
      .run(token, expira, usuario.id);

    // Enviar email
    try {
      const transporte = crearTransporte();
      const enlace = `${process.env.BASE_URL || 'http://localhost:3000'}/reset-password.html?token=${token}`;
      await transporte.sendMail({
        from: `"Dany Ads" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: 'Recuperar contraseña — Dany Ads',
        html: `
          <div style="font-family: sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">
            <h2 style="color: #0066FF;">Recuperar contraseña</h2>
            <p>Hola ${usuario.name},</p>
            <p>Haz clic en el siguiente enlace para restablecer tu contraseña:</p>
            <a href="${enlace}" style="background: #0066FF; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; display: inline-block; margin: 16px 0;">
              Restablecer contraseña
            </a>
            <p style="color: #999; font-size: 12px;">Este enlace expira en 1 hora. Si no solicitaste esto, ignora este email.</p>
          </div>
        `
      });
    } catch (emailErr) {
      console.error('Error enviando email de reset:', emailErr.message);
    }

    res.json(respuesta);
  } catch (err) {
    console.error('Error en forgot:', err);
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

// ─── POST /api/auth/reset ─────────────────────────────────────────────────────
// Restablecer contraseña con token
router.post('/reset', async (req, res) => {
  try {
    const { token, password } = req.body;

    if (!token || !password) {
      return res.status(400).json({ error: 'Token y nueva contraseña son requeridos.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres.' });
    }

    const usuario = db.prepare(`
      SELECT * FROM users WHERE reset_token = ? AND reset_expires > ?
    `).get(token, Date.now());

    if (!usuario) {
      return res.status(400).json({ error: 'Token inválido o expirado.' });
    }

    const hash = await bcrypt.hash(password, 12);
    db.prepare('UPDATE users SET password_hash = ?, reset_token = NULL, reset_expires = NULL WHERE id = ?')
      .run(hash, usuario.id);

    res.json({ mensaje: 'Contraseña actualizada correctamente. Ya puedes iniciar sesión.' });
  } catch (err) {
    console.error('Error en reset:', err);
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

// ─── POST /api/auth/change-password ──────────────────────────────────────────
// Cambiar contraseña estando autenticado (desde el dashboard del estudiante)
router.post('/change-password', verificarJWT, async (req, res) => {
  try {
    const { password } = req.body;

    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres.' });
    }

    const hash = await bcrypt.hash(password, 12);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.usuario.id);

    res.json({ mensaje: 'Contraseña actualizada correctamente.' });
  } catch (err) {
    console.error('Error en change-password:', err);
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

module.exports = router;
