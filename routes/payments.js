/**
 * routes/payments.js
 * Integración con Stripe: crear PaymentIntent, webhook y historial.
 * El webhook es la fuente de verdad para activar accesos a cursos.
 */

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { db } = require('../database/db');
const { verificarJWT, soloAdmin } = require('../middleware/auth');

// Stripe se inicializa con la clave del .env
let stripe;
function getStripe() {
  if (!stripe) {
    stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  }
  return stripe;
}

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

/**
 * Envía email de bienvenida con credenciales al nuevo estudiante.
 */
async function enviarBienvenida(email, nombre, password, nombreProducto) {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.log('⚠️  Email no configurado. Credenciales:', email, password);
    return;
  }
  try {
    const transporte = crearTransporte();
    await transporte.sendMail({
      from: `"Dany Ads" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: `¡Acceso a tu curso! — ${nombreProducto}`,
      html: `
        <div style="font-family: 'DM Sans', sans-serif; max-width: 560px; margin: 0 auto; background: #051937; color: #F5F7FA; padding: 40px; border-radius: 16px;">
          <h1 style="font-size: 28px; margin-bottom: 8px;">
            <span style="background: linear-gradient(90deg, #0066FF, #8338EC); -webkit-background-clip: text; -webkit-text-fill-color: transparent;">Dany Ads</span>
          </h1>
          <h2 style="color: #F5F7FA; margin-top: 24px;">¡Bienvenido, ${nombre}! 🎉</h2>
          <p>Tu compra de <strong>${nombreProducto}</strong> ha sido procesada exitosamente.</p>
          <p>Aquí están tus credenciales de acceso:</p>
          <div style="background: rgba(255,255,255,0.05); border: 1px solid rgba(0,102,255,0.3); border-radius: 12px; padding: 20px; margin: 20px 0;">
            <p style="margin: 4px 0;"><strong>Email:</strong> ${email}</p>
            <p style="margin: 4px 0;"><strong>Contraseña temporal:</strong> <code style="background: rgba(131,56,236,0.2); padding: 2px 8px; border-radius: 4px;">${password}</code></p>
          </div>
          <p>Inicia sesión en tu área de miembros y <strong>cambia tu contraseña</strong> lo antes posible.</p>
          <a href="${process.env.BASE_URL || 'http://localhost:3000'}/login.html"
             style="display: inline-block; background: linear-gradient(90deg, #0066FF, #8338EC); color: white; padding: 14px 28px; border-radius: 8px; text-decoration: none; font-weight: bold; margin: 16px 0;">
            Acceder a mi curso →
          </a>
          <p style="color: #888; font-size: 12px; margin-top: 32px;">
            © 2025 Dany Ads · Daniel Alvarado<br>
            Si tienes problemas, escríbenos a <a href="mailto:${process.env.EMAIL_USER}" style="color: #0066FF;">${process.env.EMAIL_USER}</a>
          </p>
        </div>
      `
    });
    console.log(`✅ Email de bienvenida enviado a: ${email}`);
  } catch (err) {
    console.error('Error enviando email de bienvenida:', err.message);
  }
}

/**
 * Activa el acceso al curso después de un pago completado.
 * Crea la cuenta si no existe y registra la compra como 'completed'.
 */
async function activarAcceso(datosCompra) {
  const { email, nombre, productId, stripePaymentId, amount } = datosCompra;

  // 1. Buscar o crear usuario
  let usuario = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
  let passwordTemporal = null;
  let esNuevo = false;

  if (!usuario) {
    // Crear cuenta automáticamente con contraseña temporal
    passwordTemporal = crypto.randomBytes(8).toString('hex');
    const hash = await bcrypt.hash(passwordTemporal, 12);
    const result = db.prepare(`
      INSERT INTO users (name, email, password_hash, role)
      VALUES (?, ?, ?, 'student')
    `).run(nombre || email.split('@')[0], email.toLowerCase(), hash);
    usuario = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
    esNuevo = true;
    console.log(`✅ Nueva cuenta creada para: ${email}`);
  }

  // 2. Registrar la compra como completada
  const compraExistente = db.prepare(
    'SELECT id FROM purchases WHERE stripe_payment_id = ?'
  ).get(stripePaymentId);

  if (!compraExistente) {
    db.prepare(`
      INSERT INTO purchases (user_id, product_id, stripe_payment_id, amount, status)
      VALUES (?, ?, ?, ?, 'completed')
    `).run(usuario.id, productId, stripePaymentId, amount);
    console.log(`✅ Compra registrada: usuario ${usuario.id}, producto ${productId}`);
  } else {
    // Actualizar estado si ya existía como pending
    db.prepare('UPDATE purchases SET status = ? WHERE stripe_payment_id = ?')
      .run('completed', stripePaymentId);
  }

  // 3. Enviar email de bienvenida si es cuenta nueva
  if (esNuevo && passwordTemporal) {
    const producto = db.prepare('SELECT name FROM products WHERE id = ?').get(productId);
    await enviarBienvenida(email, usuario.name, passwordTemporal, producto?.name || 'tu curso');
  }

  return usuario;
}

// ─── POST /api/payments/create-intent ─────────────────────────────────────────
// Crear un PaymentIntent de Stripe para el checkout modal
router.post('/create-intent', async (req, res) => {
  try {
    const { productId, name, email, phone } = req.body;

    if (!productId || !email || !name) {
      return res.status(400).json({ error: 'Producto, nombre y email son requeridos.' });
    }

    // Verificar que el email tenga formato válido
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Email inválido.' });
    }

    // Obtener el producto
    const producto = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(productId);
    if (!producto) {
      return res.status(404).json({ error: 'Producto no encontrado.' });
    }

    const stripeClient = getStripe();

    // Buscar o crear cliente en Stripe
    let customerId;
    const usuarioExistente = db.prepare('SELECT stripe_customer_id FROM users WHERE email = ?').get(email.toLowerCase());

    if (usuarioExistente?.stripe_customer_id) {
      customerId = usuarioExistente.stripe_customer_id;
    } else {
      const customer = await stripeClient.customers.create({
        email: email.toLowerCase(),
        name: name,
        phone: phone || undefined,
        metadata: { productId: String(productId) }
      });
      customerId = customer.id;

      // Guardar en DB si el usuario ya existe
      if (usuarioExistente) {
        db.prepare('UPDATE users SET stripe_customer_id = ? WHERE email = ?')
          .run(customerId, email.toLowerCase());
      }
    }

    // Crear el PaymentIntent
    const paymentIntent = await stripeClient.paymentIntents.create({
      amount: Math.round(producto.price * 100), // centavos
      currency: 'usd',
      customer: customerId,
      metadata: {
        productId: String(productId),
        productName: producto.name,
        buyerEmail: email.toLowerCase(),
        buyerName: name,
        buyerPhone: phone || ''
      },
      automatic_payment_methods: { enabled: true }
    });

    // Guardar compra como 'pending' en la BD
    const usuario = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
    if (usuario) {
      const compraExistente = db.prepare(
        'SELECT id FROM purchases WHERE stripe_payment_id = ?'
      ).get(paymentIntent.id);

      if (!compraExistente) {
        db.prepare(`
          INSERT INTO purchases (user_id, product_id, stripe_payment_id, amount, status)
          VALUES (?, ?, ?, ?, 'pending')
        `).run(usuario.id, productId, paymentIntent.id, producto.price);
      }
    }

    res.json({
      clientSecret: paymentIntent.client_secret,
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
      amount: producto.price,
      productName: producto.name
    });
  } catch (err) {
    console.error('Error creando PaymentIntent:', err);
    res.status(500).json({ error: 'Error al iniciar el pago: ' + err.message });
  }
});

// ─── POST /api/payments/webhook ───────────────────────────────────────────────
// Webhook de Stripe — FUENTE DE VERDAD para activar accesos
// Nota: usa express.raw() en server.js para esta ruta
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let evento;
  try {
    const stripeClient = getStripe();
    evento = stripeClient.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error('Webhook: firma inválida:', err.message);
    return res.status(400).json({ error: `Webhook error: ${err.message}` });
  }

  console.log(`📨 Webhook recibido: ${evento.type}`);

  // Procesar evento de pago completado
  if (evento.type === 'payment_intent.succeeded') {
    const paymentIntent = evento.data.object;
    const { productId, buyerEmail, buyerName } = paymentIntent.metadata;

    if (productId && buyerEmail) {
      await activarAcceso({
        email: buyerEmail,
        nombre: buyerName,
        productId: parseInt(productId),
        stripePaymentId: paymentIntent.id,
        amount: paymentIntent.amount / 100
      });
    }
  }

  // Pago fallido
  if (evento.type === 'payment_intent.payment_failed') {
    const paymentIntent = evento.data.object;
    db.prepare('UPDATE purchases SET status = ? WHERE stripe_payment_id = ?')
      .run('failed', paymentIntent.id);
    console.log(`❌ Pago fallido: ${paymentIntent.id}`);
  }

  res.json({ received: true });
});

// ─── GET /api/payments/history ────────────────────────────────────────────────
// Historial de transacciones (solo admin)
router.get('/history', verificarJWT, soloAdmin, (req, res) => {
  try {
    const pagos = db.prepare(`
      SELECT pu.id, pu.stripe_payment_id, pu.amount, pu.status, pu.created_at,
             u.name as user_name, u.email as user_email,
             p.name as product_name
      FROM purchases pu
      JOIN users u ON u.id = pu.user_id
      JOIN products p ON p.id = pu.product_id
      ORDER BY pu.created_at DESC
      LIMIT 100
    `).all();

    const total = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total
      FROM purchases WHERE status = 'completed'
    `).get();

    res.json({ pagos, total_recaudado: total.total });
  } catch (err) {
    console.error('Error obteniendo historial:', err);
    res.status(500).json({ error: 'Error al obtener el historial.' });
  }
});

// ─── POST /api/payments/activate-manual ──────────────────────────────────────
// Activar acceso manualmente (admin)
router.post('/activate-manual', verificarJWT, soloAdmin, async (req, res) => {
  try {
    const { email, productId } = req.body;
    if (!email || !productId) {
      return res.status(400).json({ error: 'Email y productId son requeridos.' });
    }

    await activarAcceso({
      email,
      nombre: email.split('@')[0],
      productId: parseInt(productId),
      stripePaymentId: `manual_${Date.now()}`,
      amount: 0
    });

    res.json({ mensaje: 'Acceso activado manualmente.' });
  } catch (err) {
    console.error('Error en activación manual:', err);
    res.status(500).json({ error: 'Error al activar acceso.' });
  }
});

module.exports = router;
