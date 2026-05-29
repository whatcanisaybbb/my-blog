const express = require('express');
const multer = require('multer');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3001;

// ===== 配置 =====
const UPLOAD_DIR = path.join(__dirname, '..', 'blog-files');
const JWT_SECRET = 'my-blog-secret-key-2026';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';

// 确保上传目录存在
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ===== 中间件 =====
app.use(cors());
app.use(express.json());
app.use('/files', express.static(UPLOAD_DIR));

// ===== Multer 配置 =====
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    // 保留原始文件名，冲突时加时间戳
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext);
    const safeName = base.replace(/[^\w\u4e00-\u9fa5.-]/g, '_');
    const finalName = `${Date.now()}_${safeName}${ext}`;
    cb(null, finalName);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB 上限
});

// ===== JWT 验证 =====
function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: '未登录' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: '登录已过期' });
  }
}

// ===== 路由 =====

// 登录
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username !== ADMIN_USER || password !== ADMIN_PASS) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, username });
});

// 验证 token
app.get('/api/verify', auth, (req, res) => {
  res.json({ ok: true, username: req.user.username });
});

// 文件列表
app.get('/api/files', auth, (req, res) => {
  const files = fs.readdirSync(UPLOAD_DIR)
    .filter(f => !f.startsWith('.'))
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

// 上传文件（支持多文件）
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

// 下载文件
app.get('/api/download/:id', auth, (req, res) => {
  const filename = Buffer.from(req.params.id, 'base64').toString();
  const filepath = path.join(UPLOAD_DIR, path.basename(filename));
  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: '文件不存在' });
  }
  res.download(filepath);
});

// 删除文件
app.delete('/api/files/:id', auth, (req, res) => {
  const filename = Buffer.from(req.params.id, 'base64').toString();
  const filepath = path.join(UPLOAD_DIR, path.basename(filename));
  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: '文件不存在' });
  }
  fs.unlinkSync(filepath);
  res.json({ ok: true });
});

// 启动
app.listen(PORT, '0.0.0.0', () => {
  console.log(`文件服务器运行在 http://localhost:${PORT}`);
  console.log(`上传目录: ${UPLOAD_DIR}`);
  console.log(`默认账号: ${ADMIN_USER} / ${ADMIN_PASS}`);
});
