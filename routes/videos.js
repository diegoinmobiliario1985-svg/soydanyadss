/**
 * routes/videos.js
 * Subida y streaming protegido de videos.
 * Los videos NUNCA se sirven sin JWT válido y acceso al curso.
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { db } = require('../database/db');
const { verificarJWT, soloAdmin } = require('../middleware/auth');

// ─── Configurar multer para videos ────────────────────────────────────────────
const VIDEOS_DIR = path.join(__dirname, '..', 'uploads', 'videos');

// Crear directorio si no existe
if (!fs.existsSync(VIDEOS_DIR)) {
  fs.mkdirSync(VIDEOS_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, VIDEOS_DIR),
  filename: (req, file, cb) => {
    // Generar nombre único: timestamp_nombre-sanitizado.ext
    const ext = path.extname(file.originalname).toLowerCase();
    const base = path.basename(file.originalname, ext)
      .replace(/[^a-z0-9]/gi, '_')
      .toLowerCase()
      .substring(0, 50);
    const nombre = `${Date.now()}_${base}${ext}`;
    cb(null, nombre);
  }
});

const fileFilter = (req, file, cb) => {
  // Solo aceptar videos
  const tiposPermitidos = ['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime', 'video/x-msvideo'];
  if (tiposPermitidos.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Solo se permiten archivos de video (MP4, WebM, MOV, AVI).'), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 } // 2GB máximo
});

// ─── POST /api/videos/upload ──────────────────────────────────────────────────
// Subir video y asociarlo a una lección (solo admin)
router.post('/upload', verificarJWT, soloAdmin, upload.single('video'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No se recibió ningún archivo de video.' });
    }

    const { courseId, title, sortOrder } = req.body;

    if (!courseId || !title) {
      // Eliminar el archivo subido si faltan datos
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'courseId y title son requeridos.' });
    }

    // Verificar que el curso existe
    const curso = db.prepare('SELECT id FROM courses WHERE id = ?').get(courseId);
    if (!curso) {
      fs.unlinkSync(req.file.path);
      return res.status(404).json({ error: 'Curso no encontrado.' });
    }

    // Calcular el orden si no se especificó
    const orden = sortOrder || db.prepare(
      'SELECT COALESCE(MAX(sort_order), 0) + 1 as next FROM lessons WHERE course_id = ?'
    ).get(courseId).next;

    // Registrar la lección en la BD
    const result = db.prepare(`
      INSERT INTO lessons (course_id, title, video_filename, sort_order)
      VALUES (?, ?, ?, ?)
    `).run(courseId, title, req.file.filename, orden);

    const leccion = db.prepare('SELECT * FROM lessons WHERE id = ?').get(result.lastInsertRowid);

    res.status(201).json({
      mensaje: 'Video subido correctamente.',
      leccion,
      archivo: {
        nombre: req.file.filename,
        tamaño: req.file.size,
        tipo: req.file.mimetype
      }
    });
  } catch (err) {
    console.error('Error subiendo video:', err);
    res.status(500).json({ error: 'Error al subir el video: ' + err.message });
  }
});

// ─── GET /api/videos/:id/stream ───────────────────────────────────────────────
// Streaming protegido de video (requiere JWT en header o query string ?t=TOKEN)
// El dashboard envía el token como query param para poder usarlo en <video src="">
router.get('/:id/stream', (req, res, next) => {
  // Aceptar token por query string además del header Authorization
  const tokenQuery = req.query.t;
  if (tokenQuery && !req.headers['authorization']) {
    req.headers['authorization'] = `Bearer ${tokenQuery}`;
  }
  next();
}, verificarJWT, (req, res) => {
  try {
    const lessonId = req.params.id;
    const userId = req.usuario.id;

    // Obtener la lección y su curso asociado
    const leccion = db.prepare(`
      SELECT l.*, c.product_id FROM lessons l
      JOIN courses c ON c.id = l.course_id
      WHERE l.id = ?
    `).get(lessonId);

    if (!leccion) {
      return res.status(404).json({ error: 'Lección no encontrada.' });
    }

    // Verificar que el usuario tiene acceso al producto (compra completada) o es admin
    if (req.usuario.role !== 'admin') {
      const tieneAcceso = db.prepare(`
        SELECT id FROM purchases
        WHERE user_id = ? AND product_id = ? AND status = 'completed'
      `).get(userId, leccion.product_id);

      if (!tieneAcceso) {
        return res.status(403).json({ error: 'No tienes acceso a este contenido.' });
      }
    }

    // Ruta del archivo de video
    const videoPath = path.join(VIDEOS_DIR, leccion.video_filename);

    if (!fs.existsSync(videoPath)) {
      return res.status(404).json({ error: 'Archivo de video no encontrado.' });
    }

    const stat = fs.statSync(videoPath);
    const fileSize = stat.size;
    const range = req.headers.range;

    // Soporte para streaming parcial (seek en el video)
    if (range) {
      const partes = range.replace(/bytes=/, '').split('-');
      const inicio = parseInt(partes[0], 10);
      const fin = partes[1] ? parseInt(partes[1], 10) : fileSize - 1;
      const chunkSize = fin - inicio + 1;

      const stream = fs.createReadStream(videoPath, { start: inicio, end: fin });

      res.writeHead(206, {
        'Content-Range': `bytes ${inicio}-${fin}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': 'video/mp4',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache'
      });

      stream.pipe(res);
    } else {
      // Sin range: enviar todo el archivo
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      });
      fs.createReadStream(videoPath).pipe(res);
    }
  } catch (err) {
    console.error('Error en streaming:', err);
    res.status(500).json({ error: 'Error al reproducir el video.' });
  }
});

// ─── GET /api/videos ──────────────────────────────────────────────────────────
// Listar lecciones de un curso (requiere acceso)
router.get('/', verificarJWT, (req, res) => {
  try {
    const { courseId } = req.query;

    if (!courseId) {
      return res.status(400).json({ error: 'courseId es requerido.' });
    }

    // Verificar acceso al curso
    if (req.usuario.role !== 'admin') {
      const curso = db.prepare('SELECT product_id FROM courses WHERE id = ?').get(courseId);
      if (!curso) return res.status(404).json({ error: 'Curso no encontrado.' });

      const tieneAcceso = db.prepare(`
        SELECT id FROM purchases
        WHERE user_id = ? AND product_id = ? AND status = 'completed'
      `).get(req.usuario.id, curso.product_id);

      if (!tieneAcceso) {
        return res.status(403).json({ error: 'No tienes acceso a este curso.' });
      }
    }

    const lecciones = db.prepare(`
      SELECT l.id, l.title, l.duration, l.sort_order,
             CASE WHEN up.completed = 1 THEN 1 ELSE 0 END as completed,
             COALESCE(up.watched_seconds, 0) as watched_seconds
      FROM lessons l
      LEFT JOIN user_progress up ON up.lesson_id = l.id AND up.user_id = ?
      WHERE l.course_id = ?
      ORDER BY l.sort_order ASC
    `).all(req.usuario.id, courseId);

    res.json(lecciones);
  } catch (err) {
    console.error('Error listando lecciones:', err);
    res.status(500).json({ error: 'Error al obtener las lecciones.' });
  }
});

// ─── POST /api/videos/progress ───────────────────────────────────────────────
// Actualizar progreso de una lección
router.post('/progress', verificarJWT, (req, res) => {
  try {
    const { lessonId, watchedSeconds, completed } = req.body;

    if (!lessonId) {
      return res.status(400).json({ error: 'lessonId es requerido.' });
    }

    db.prepare(`
      INSERT INTO user_progress (user_id, lesson_id, completed, watched_seconds, updated_at)
      VALUES (?, ?, ?, ?, unixepoch())
      ON CONFLICT(user_id, lesson_id) DO UPDATE SET
        completed = CASE WHEN excluded.completed = 1 THEN 1 ELSE completed END,
        watched_seconds = MAX(watched_seconds, excluded.watched_seconds),
        updated_at = unixepoch()
    `).run(
      req.usuario.id,
      lessonId,
      completed ? 1 : 0,
      watchedSeconds || 0
    );

    res.json({ mensaje: 'Progreso actualizado.' });
  } catch (err) {
    console.error('Error actualizando progreso:', err);
    res.status(500).json({ error: 'Error al actualizar progreso.' });
  }
});

// ─── DELETE /api/videos/:id ───────────────────────────────────────────────────
// Eliminar lección y su video (solo admin)
router.delete('/:id', verificarJWT, soloAdmin, (req, res) => {
  try {
    const leccion = db.prepare('SELECT * FROM lessons WHERE id = ?').get(req.params.id);
    if (!leccion) {
      return res.status(404).json({ error: 'Lección no encontrada.' });
    }

    // Eliminar archivo de video
    if (leccion.video_filename) {
      const videoPath = path.join(VIDEOS_DIR, leccion.video_filename);
      if (fs.existsSync(videoPath)) {
        fs.unlinkSync(videoPath);
      }
    }

    // Eliminar de la BD
    db.prepare('DELETE FROM user_progress WHERE lesson_id = ?').run(req.params.id);
    db.prepare('DELETE FROM lessons WHERE id = ?').run(req.params.id);

    res.json({ mensaje: 'Lección y video eliminados.' });
  } catch (err) {
    console.error('Error eliminando lección:', err);
    res.status(500).json({ error: 'Error al eliminar la lección.' });
  }
});

// Manejador de errores de multer
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'El archivo es demasiado grande (máximo 2GB).' });
    }
  }
  if (err) {
    return res.status(400).json({ error: err.message });
  }
  next();
});

module.exports = router;
