/**
 * database/db.js
 * Configuración de SQLite con better-sqlite3.
 * Crea las tablas automáticamente si no existen (migraciones).
 */

const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');

// Ruta al archivo de base de datos
const DB_PATH = path.join(__dirname, 'dany_ads.db');

// Crear/abrir la base de datos
const db = new Database(DB_PATH);

// Activar WAL mode para mejor rendimiento con lecturas concurrentes
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/**
 * Inicializa todas las tablas de la base de datos.
 * Se ejecuta al arrancar el servidor.
 */
function inicializarDB() {
  // ─── Tabla: usuarios ───────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      name             TEXT NOT NULL,
      email            TEXT NOT NULL UNIQUE,
      password_hash    TEXT NOT NULL,
      role             TEXT NOT NULL DEFAULT 'student',
      stripe_customer_id TEXT,
      reset_token      TEXT,
      reset_expires    INTEGER,
      created_at       INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  // ─── Tabla: productos/cursos (landing) ────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      name             TEXT NOT NULL,
      description      TEXT,
      price            REAL NOT NULL,
      original_price   REAL,
      stripe_price_id  TEXT,
      image_url        TEXT,
      features         TEXT,
      active           INTEGER NOT NULL DEFAULT 1,
      created_at       INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  // ─── Tabla: compras / pagos ───────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS purchases (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id              INTEGER NOT NULL,
      product_id           INTEGER NOT NULL,
      stripe_payment_id    TEXT,
      stripe_session_id    TEXT,
      amount               REAL NOT NULL,
      status               TEXT NOT NULL DEFAULT 'pending',
      created_at           INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (user_id)    REFERENCES users(id),
      FOREIGN KEY (product_id) REFERENCES products(id)
    )
  `);

  // ─── Tabla: cursos (agrupan lecciones) ───────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS courses (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id       INTEGER NOT NULL UNIQUE,
      title            TEXT NOT NULL,
      description      TEXT,
      created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (product_id) REFERENCES products(id)
    )
  `);

  // ─── Tabla: lecciones ────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS lessons (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      course_id        INTEGER NOT NULL,
      title            TEXT NOT NULL,
      video_filename   TEXT,
      duration         INTEGER DEFAULT 0,
      sort_order       INTEGER NOT NULL DEFAULT 0,
      created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (course_id) REFERENCES courses(id)
    )
  `);

  // ─── Tabla: progreso del usuario ─────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_progress (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id          INTEGER NOT NULL,
      lesson_id        INTEGER NOT NULL,
      completed        INTEGER NOT NULL DEFAULT 0,
      watched_seconds  INTEGER NOT NULL DEFAULT 0,
      updated_at       INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(user_id, lesson_id),
      FOREIGN KEY (user_id)   REFERENCES users(id),
      FOREIGN KEY (lesson_id) REFERENCES lessons(id)
    )
  `);

  console.log('✅ Base de datos inicializada correctamente');
}

/**
 * Crea el usuario administrador por defecto si no existe.
 * Usa las variables de entorno ADMIN_EMAIL y ADMIN_PASSWORD.
 */
async function crearAdminPorDefecto() {
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@danyads.com';
  const adminPassword = process.env.ADMIN_PASSWORD || 'Admin123!';
  const adminName = process.env.ADMIN_NAME || 'Daniel Alvarado';

  const adminExistente = db.prepare('SELECT id FROM users WHERE email = ?').get(adminEmail);

  if (!adminExistente) {
    const hash = await bcrypt.hash(adminPassword, 12);
    db.prepare(`
      INSERT INTO users (name, email, password_hash, role)
      VALUES (?, ?, ?, 'admin')
    `).run(adminName, adminEmail, hash);
    console.log(`✅ Admin creado: ${adminEmail}`);
  }
}

/**
 * Inserta productos de demostración si la tabla está vacía.
 */
function insertarProductosDemo() {
  const count = db.prepare('SELECT COUNT(*) as c FROM products').get();
  if (count.c > 0) return;

  const productos = [
    {
      name: 'Workshop: WhatsApp Ads que Cierran™',
      description: 'Aprende el método exacto para crear anuncios de Meta que llevan clientes directamente a WhatsApp listos para comprar.',
      price: 17,
      original_price: 97,
      stripe_price_id: '',
      image_url: '',
      features: JSON.stringify([
        'Método de 3 pasos para conversaciones de venta',
        'Objetivo "Ventas" configurado correctamente',
        'Guión de cierre de ventas por WhatsApp',
        'Diseño de creativos con IA',
        'El secreto del algoritmo que nadie te cuenta'
      ]),
      active: 1
    },
    {
      name: 'Servicio Trafficker Meta Ads',
      description: 'Gestión profesional de tus campañas en Meta Ads con seguimiento, optimización y escalamiento de resultados.',
      price: 97,
      original_price: 197,
      stripe_price_id: '',
      image_url: '',
      features: JSON.stringify([
        'Configuración completa de campaña',
        'Análisis semanal de métricas',
        'Optimización continua de audiencias',
        'Escalamiento de presupuesto estratégico',
        'Acompañamiento personalizado vía WhatsApp'
      ]),
      active: 1
    }
  ];

  const stmt = db.prepare(`
    INSERT INTO products (name, description, price, original_price, stripe_price_id, image_url, features, active)
    VALUES (@name, @description, @price, @original_price, @stripe_price_id, @image_url, @features, @active)
  `);

  for (const p of productos) {
    const result = stmt.run(p);
    // Crear el curso asociado al producto
    db.prepare(`
      INSERT INTO courses (product_id, title, description)
      VALUES (?, ?, ?)
    `).run(result.lastInsertRowid, p.name, p.description);
  }

  console.log('✅ Productos demo insertados');
}

module.exports = { db, inicializarDB, crearAdminPorDefecto, insertarProductosDemo };
