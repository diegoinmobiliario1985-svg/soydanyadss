/**
 * server.js
 * Servidor principal de Dany Ads — Express + SQLite + Stripe
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const { inicializarDB, crearAdminPorDefecto, insertarProductosDemo } = require('./database/db');

// ─── Importar rutas ────────────────────────────────────────────────────────────
const authRoutes     = require('./routes/auth');
const productsRoutes = require('./routes/products');
const paymentsRoutes = require('./routes/payments');
const videosRoutes   = require('./routes/videos');
const adminRoutes    = require('./routes/admin');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middlewares globales ─────────────────────────────────────────────────────

// CORS
app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? process.env.BASE_URL
    : '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// El webhook de Stripe necesita el body RAW (sin parsear)
// Por eso se registra ANTES del json parser general
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));

// Parser JSON para el resto de rutas
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ─── Archivos estáticos públicos ──────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ─── Registrar rutas API ──────────────────────────────────────────────────────
app.use('/api/auth',     authRoutes);
app.use('/api/products', productsRoutes);
app.use('/api/payments', paymentsRoutes);
app.use('/api/videos',   videosRoutes);
app.use('/api/admin',    adminRoutes);

// ─── Ruta raíz → landing.html (nueva landing page de ventas) ──────────────────
// La landing de ventas del ebook es ahora la página principal.
// El antiguo index quedó guardado como old-index.html (no se sirve en "/").
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});

// ─── Manejador de rutas no encontradas ───────────────────────────────────────
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Endpoint no encontrado.' });
  }
  // Para rutas HTML, redirigir al index
  res.redirect('/');
});

// ─── Manejador global de errores ─────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Error no manejado:', err);
  res.status(500).json({ error: 'Error interno del servidor.' });
});

// ─── Inicializar y arrancar ────────────────────────────────────────────────────
async function arrancar() {
  try {
    // 1. Inicializar base de datos y tablas
    inicializarDB();

    // 2. Crear admin por defecto si no existe
    await crearAdminPorDefecto();

    // 3. Insertar productos demo si la BD está vacía
    insertarProductosDemo();

    // 4. Arrancar el servidor
    app.listen(PORT, () => {
      console.log('');
      console.log('🚀 ─────────────────────────────────────────');
      console.log('   Dany Ads — Servidor iniciado');
      console.log(`   🌐 http://localhost:${PORT}`);
      console.log(`   🔐 Admin: http://localhost:${PORT}/admin.html`);
      console.log(`   📊 API:   http://localhost:${PORT}/api`);
      console.log('─────────────────────────────────────────────');
      console.log('');
    });
  } catch (err) {
    console.error('❌ Error al inicializar la aplicación:', err);
    process.exit(1);
  }
}

arrancar();
