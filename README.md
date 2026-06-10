# Dany Ads — Plataforma de Cursos y Servicios

Plataforma web completa para venta de cursos de publicidad digital en Meta Ads.
Área de miembros con reproductor de video protegido, pagos con Stripe y panel de administración.

---

## Stack

- **Frontend:** HTML + CSS + Vanilla JS (sin frameworks)
- **Backend:** Node.js + Express
- **Base de datos:** SQLite (better-sqlite3)
- **Pagos:** Stripe (PaymentIntents + Webhooks)
- **Auth:** JWT + bcryptjs
- **Email:** Nodemailer (Gmail SMTP)
- **Videos:** Multer (almacenamiento local) + streaming por rangos

---

## Setup rápido

### 1. Instalar dependencias

```bash
npm install
```

### 2. Configurar variables de entorno

```bash
cp .env.example .env
```

Edita `.env` y rellena:

| Variable | Descripción |
|---|---|
| `JWT_SECRET` | Cadena aleatoria larga (mín. 32 chars) |
| `STRIPE_SECRET_KEY` | `sk_test_...` desde dashboard.stripe.com |
| `STRIPE_PUBLISHABLE_KEY` | `pk_test_...` desde dashboard.stripe.com |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` (ver paso 5) |
| `EMAIL_USER` | Tu cuenta de Gmail |
| `EMAIL_PASS` | App Password de Gmail (no la contraseña normal) |
| `ADMIN_EMAIL` | Email del administrador |
| `ADMIN_PASSWORD` | Contraseña inicial del admin (¡cámbiala!) |

### 3. Arrancar el servidor

```bash
node server.js
# o en desarrollo con auto-reload:
npm run dev
```

La base de datos se crea automáticamente en `database/dany_ads.db`.
El usuario admin se crea al primer arranque.

### 4. Abrir en el navegador

| URL | Descripción |
|---|---|
| `http://localhost:3000` | Landing page pública |
| `http://localhost:3000/login.html` | Login de estudiantes |
| `http://localhost:3000/dashboard.html` | Área de miembros |
| `http://localhost:3000/admin.html` | Panel de administración |

---

## Configurar Stripe (paso 5)

### Modo test local con Stripe CLI

1. Instala Stripe CLI: https://stripe.com/docs/stripe-cli
2. Autentícate:
   ```bash
   stripe login
   ```
3. Escucha webhooks en local:
   ```bash
   stripe listen --forward-to localhost:3000/api/payments/webhook
   ```
4. Copia el `whsec_...` que aparece y pégalo en `.env` como `STRIPE_WEBHOOK_SECRET`.

### Crear productos en Stripe (opcional)

Para usar `stripe_price_id` en los productos, crea los precios en el dashboard de Stripe
y añade el ID (`price_...`) en el panel de Admin → Productos.

---

## Flujo de pago

```
Usuario hace clic "Quiero este Workshop"
        ↓
Modal de checkout (nombre, email, tarjeta)
        ↓
POST /api/payments/create-intent → crea PaymentIntent en Stripe
        ↓
Stripe.js confirma el pago con la tarjeta
        ↓
Webhook: payment_intent.succeeded
        ↓
Backend crea cuenta automática + activa acceso al curso
        ↓
Email con credenciales enviado al comprador
```

El **webhook es la fuente de verdad**. Los accesos solo se activan cuando
Stripe confirma el pago exitoso, nunca desde el frontend.

---

## Estructura de archivos

```
dany-ads/
├── server.js              # Express principal
├── package.json
├── .env                   # Variables de entorno (no commitear)
├── .env.example           # Plantilla
├── database/
│   ├── db.js              # SQLite setup + migraciones
│   └── dany_ads.db        # Base de datos (generada automáticamente)
├── routes/
│   ├── auth.js            # login, register, JWT, cambiar password
│   ├── products.js        # CRUD productos/cursos
│   ├── payments.js        # Stripe checkout + webhooks
│   ├── videos.js          # subida y streaming protegido
│   └── admin.js           # panel admin
├── middleware/
│   └── auth.js            # verificar JWT y rol admin
├── public/
│   ├── index.html         # Landing page
│   ├── login.html         # Login estudiantes
│   ├── dashboard.html     # Área de miembros
│   ├── admin.html         # Panel de administración
│   ├── forgot-password.html
│   └── css/
│       └── styles.css
└── uploads/
    └── videos/            # Videos subidos (no commitear)
```

---

## API Reference

### Auth
| Método | Endpoint | Descripción |
|---|---|---|
| POST | `/api/auth/register` | Registrar usuario |
| POST | `/api/auth/login` | Login → retorna JWT |
| GET | `/api/auth/me` | Datos del usuario + cursos |
| POST | `/api/auth/forgot` | Solicitar reset de contraseña |
| POST | `/api/auth/reset` | Resetear contraseña con token |
| POST | `/api/auth/change-password` | Cambiar password (requiere JWT) |

### Productos
| Método | Endpoint | Descripción |
|---|---|---|
| GET | `/api/products` | Lista pública |
| GET | `/api/products/:id` | Detalle |
| POST | `/api/products` | Crear (admin) |
| PUT | `/api/products/:id` | Editar (admin) |
| DELETE | `/api/products/:id` | Desactivar (admin) |

### Pagos
| Método | Endpoint | Descripción |
|---|---|---|
| POST | `/api/payments/create-intent` | Crear PaymentIntent |
| POST | `/api/payments/webhook` | Webhook de Stripe |
| GET | `/api/payments/history` | Historial (admin) |
| POST | `/api/payments/activate-manual` | Activar acceso manual (admin) |

### Videos
| Método | Endpoint | Descripción |
|---|---|---|
| POST | `/api/videos/upload` | Subir video (admin, multipart) |
| GET | `/api/videos/:id/stream` | Stream protegido (JWT) |
| GET | `/api/videos?courseId=X` | Lecciones de un curso (JWT) |
| POST | `/api/videos/progress` | Guardar progreso (JWT) |
| DELETE | `/api/videos/:id` | Eliminar lección (admin) |

### Admin
| Método | Endpoint | Descripción |
|---|---|---|
| GET | `/api/admin/stats` | Métricas del negocio |
| GET | `/api/admin/users` | Lista de usuarios |
| GET | `/api/admin/users/:id` | Detalle de usuario |
| PUT | `/api/admin/users/:id/access` | Dar/revocar acceso a curso |
| GET | `/api/admin/courses` | Lista de cursos con lecciones |
| GET | `/api/admin/courses/:id/lessons` | Lecciones de un curso |

---

## Gmail — App Password

1. Ve a tu cuenta Google → Seguridad
2. Activa la verificación en 2 pasos
3. Busca "Contraseñas de aplicación"
4. Crea una para "Correo" → copia los 16 caracteres
5. Pégala en `.env` como `EMAIL_PASS`

---

## Producción

Para despliegue en producción:

1. Usa `NODE_ENV=production` en el `.env`
2. Configura un reverse proxy (Nginx) apuntando al puerto 3000
3. Usa PM2 para mantener el proceso:
   ```bash
   npm install -g pm2
   pm2 start server.js --name dany-ads
   pm2 save && pm2 startup
   ```
4. Cambia las claves de Stripe de `sk_test_` a `sk_live_`
5. Registra el webhook de producción en dashboard.stripe.com

---

© 2025 Dany Ads · Daniel Alvarado
