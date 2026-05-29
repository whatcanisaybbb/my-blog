const express = require('express');
const multer = require('multer');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const app = express();
const PORT = 3001;

// ===== 配置 =====
const UPLOAD_DIR = path.join(__dirname, '..', 'blog-files');
const VIDEO_DIR = path.join(UPLOAD_DIR, 'videos');
const JWT_SECRET = 'my-blog-secret-key-2026';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

// 确保目录存在
[UPLOAD_DIR, VIDEO_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ===== 中间件 =====
app.use(cors());
app.use(express.json());
app.use('/files', express.static(UPLOAD_DIR));

// ===== Multer =====
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const isVideo = /\.(mp4|mkv|avi|mov|webm|flv|wmv|ts|m4v)$/i.test(file.originalname);
    cb(null, isVideo ? VIDEO_DIR : UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext);
    const safeName = base.replace(/[^\w\u4e00-\u9fa5.-]/g, '_');
    cb(null, `${Date.now()}_${safeName}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 * 1024 } // 8GB 上限（视频可能很大）
});

// ===== JWT =====
function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: '未登录' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: '登录已过期' }); }
}

// ===== 视频流播放（支持 Range 请求，允许浏览器 seek） =====
const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.avi', '.mov', '.webm', '.flv', '.wmv', '.ts', '.m4v']);

app.get('/api/video/stream/:id', auth, (req, res) => {
  const filename = Buffer.from(req.params.id, 'base64').toString();
  const filepath = path.join(VIDEO_DIR, path.basename(filename));

  if (!fs.existsSync(filepath)) return res.status(404).json({ error: '视频不存在' });

  const stat = fs.statSync(filepath);
  const fileSize = stat.size;
  const ext = path.extname(filename).toLowerCase();

  // MKV 实时转封装为 MP4（不重编码，超快）
  if (ext === '.mkv') {
    res.setHeader('Content-Type', 'video/mp4');
    const ffmpeg = spawn(FFMPEG, [
      '-i', filepath,
      '-c', 'copy',        // 不重编码
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof', // 流式 MP4
      '-f', 'mp4',
      '-'
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    ffmpeg.stdout.pipe(res);
    ffmpeg.stderr.on('data', () => {}); // 忽略 ffmpeg 日志
    ffmpeg.on('error', (err) => {
      if (!res.headersSent) res.status(500).json({ error: '转封装失败: ' + err.message });
    });
    ffmpeg.on('close', () => {
      if (!res.destroyed) res.end();
    });
    req.on('close', () => ffmpeg.kill());
    return;
  }

  // 其他格式直接 Range 流
  const mimeMap = {
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo', '.flv': 'video/x-flv', '.wmv': 'video/x-ms-wmv',
    '.ts': 'video/mp2t', '.m4v': 'video/mp4'
  };
  res.setHeader('Content-Type', mimeMap[ext] || 'video/mp4');
  res.setHeader('Accept-Ranges', 'bytes');

  const range = req.headers.range;
  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = end - start + 1;
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
    res.setHeader('Content-Length', chunkSize);
    fs.createReadStream(filepath, { start, end }).pipe(res);
  } else {
    res.setHeader('Content-Length', fileSize);
    fs.createReadStream(filepath).pipe(res);
  }
});

// ===== 获取视频信息 =====
app.get('/api/video/info/:id', auth, (req, res) => {
  const filename = Buffer.from(req.params.id, 'base64').toString();
  const filepath = path.join(VIDEO_DIR, path.basename(filename));
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: '视频不存在' });

  const stat = fs.statSync(filepath);
  res.json({
    name: filename,
    size: stat.size,
    mtime: stat.mtime.toISOString(),
    ext: path.extname(filename).toLowerCase()
  });
});

// ===== 视频转码（MKV→MP4 容器转换，不重编码） =====
app.post('/api/video/convert/:id', auth, (req, res) => {
  const filename = Buffer.from(req.params.id, 'base64').toString();
  const filepath = path.join(VIDEO_DIR, path.basename(filename));

  if (!fs.existsSync(filepath)) return res.status(404).json({ error: '视频不存在' });

  const ext = path.extname(filename).toLowerCase();
  const base = path.basename(filename, ext);
  const outName = `${base}_converted.mp4`;
  const outPath = path.join(VIDEO_DIR, outName);

  // 如果已经转过了直接返回
  if (fs.existsSync(outPath)) {
    const stat = fs.statSync(outPath);
    return res.json({
      ok: true,
      skipped: true,
      id: Buffer.from(outName).toString('base64'),
      name: outName,
      size: stat.size
    });
  }

  res.json({ ok: true, converting: true });

  // 后台转码
  const ffmpeg = spawn(FFMPEG, [
    '-i', filepath,
    '-c', 'copy',
    '-movflags', '+faststart',
    '-y', outPath
  ]);

  let stderr = '';
  ffmpeg.stderr.on('data', d => { stderr += d.toString(); });
  ffmpeg.on('close', code => {
    if (code === 0) {
      const stat = fs.statSync(outPath);
      console.log(`[video] 转码完成: ${outName} (${(stat.size/1024/1024).toFixed(1)}MB)`);
    } else {
      console.error(`[video] 转码失败: ${stderr.slice(-500)}`);
      if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
    }
  });
});

// ===== 登录 =====
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username !== ADMIN_USER || password !== ADMIN_PASS) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, username });
});

app.get('/api/verify', auth, (req, res) => {
  res.json({ ok: true, username: req.user.username });
});

// ===== 视频列表 =====
app.get('/api/video/list', auth, (req, res) => {
  if (!fs.existsSync(VIDEO_DIR)) return res.json([]);
  const files = fs.readdirSync(VIDEO_DIR)
    .filter(f => !f.startsWith('.') && VIDEO_EXTS.has(path.extname(f).toLowerCase()))
    .map(f => {
      const stat = fs.statSync(path.join(VIDEO_DIR, f));
      return {
        id: Buffer.from(f).toString('base64'),
        name: f,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
        ext: path.extname(f).toLowerCase()
      };
    })
    .sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
  res.json(files);
});

// ===== 通用文件列表 =====
app.get('/api/files', auth, (req, res) => {
  const files = fs.readdirSync(UPLOAD_DIR)
    .filter(f => !f.startsWith('.'))
    .filter(f => !fs.statSync(path.join(UPLOAD_DIR, f)).isDirectory())
    .map(f => {
      const stat = fs.statSync(path.join(UPLOAD_DIR, f));
      return {
        id: Buffer.from(f).toString('base64'),
        name: f,
        size: stat.size,
        mtime: stat.mtime.toISOString()
      };
    })
    .sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
  res.json(files);
});

// ===== 上传 =====
app.post('/api/upload', auth, upload.array('files', 10), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: '没有文件' });
  }
  const result = req.files.map(f => ({
    id: Buffer.from(f.filename).toString('base64'),
    name: f.filename,
    size: f.size,
    originalName: f.originalname
  }));
  res.json({ ok: true, files: result });
});

// ===== 下载 =====
app.get('/api/download/:id', auth, (req, res) => {
  const filename = Buffer.from(req.params.id, 'base64').toString();
  const filepath = path.join(UPLOAD_DIR, path.basename(filename));
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: '文件不存在' });
  res.download(filepath);
});

// ===== 删除 =====
app.delete('/api/files/:id', auth, (req, res) => {
  const filename = Buffer.from(req.params.id, 'base64').toString();
  // 先找普通目录，再找视频目录
  let filepath = path.join(UPLOAD_DIR, path.basename(filename));
  if (!fs.existsSync(filepath)) filepath = path.join(VIDEO_DIR, path.basename(filename));
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: '文件不存在' });
  fs.unlinkSync(filepath);
  res.json({ ok: true });
});

app.delete('/api/video/:id', auth, (req, res) => {
  const filename = Buffer.from(req.params.id, 'base64').toString();
  const filepath = path.join(VIDEO_DIR, path.basename(filename));
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: '视频不存在' });
  fs.unlinkSync(filepath);
  res.json({ ok: true });
});

// ===== 启动 =====
app.listen(PORT, '0.0.0.0', () => {
  console.log(`服务器运行在 http://localhost:${PORT}`);
  console.log(`上传目录: ${UPLOAD_DIR}`);
  console.log(`视频目录: ${VIDEO_DIR}`);
  console.log(`默认账号: ${ADMIN_USER} / ${ADMIN_PASS}`);
  console.log(`ffmpeg: ${FFMPEG}`);
});
