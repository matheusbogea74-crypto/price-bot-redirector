import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, 'data', 'redirects.json');
const SYNC_SECRET = process.env.SYNC_SECRET;
const PORT = process.env.PORT || 3000;

if (!SYNC_SECRET) {
  throw new Error('SYNC_SECRET não configurado.');
}

function loadRedirects() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveRedirects(redirects) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(redirects, null, 2), 'utf-8');
}

let redirects = loadRedirects();

// Painel do monitor de iPhones: o price-bot manda um retrato dos preços
// (POST /iphones/sync) e a página /iphones?k=CHAVE mostra. A chave de
// leitura vem dentro do próprio retrato, então não precisa de variável nova
// no Render. O disco do plano grátis é temporário — o bot reenvia a cada 10 min.
const IPHONES_FILE = path.join(__dirname, 'data', 'iphones.json');

function loadIphoneSnapshot() {
  try {
    return JSON.parse(fs.readFileSync(IPHONES_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

let iphoneSnapshot = loadIphoneSnapshot();

function hasViewKey(req) {
  const expected = iphoneSnapshot?.viewKey;
  const given = req.query.k;
  if (!expected || typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Páginas do Zoom/Buscapé que o usuário salvou no navegador e enviou pelo
// painel. Ficam na fila até o bot buscar (GET /iphones/imports), importar e
// devolver o resultado. Só em memória: se a instância reiniciar antes do bot
// buscar, o usuário reenvia.
const iphoneImports = [];
const MAX_IMPORTS_KEPT = 20;

const app = express();
// 10mb: uma página salva do Zoom tem ~800kb.
app.use(express.json({ limit: '10mb' }));

app.get('/', (req, res) => {
  res.json({ ok: true, totalRedirects: Object.keys(redirects).length });
});

app.get('/p/:id', (req, res) => {
  const target = redirects[req.params.id];
  if (!target) {
    res.status(404).send('Link não encontrado.');
    return;
  }
  res.redirect(302, target);
});

app.post('/sync', (req, res) => {
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${SYNC_SECRET}`) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const { id, url } = req.body ?? {};
  if (!id || !url) {
    res.status(400).json({ error: 'id e url são obrigatórios' });
    return;
  }

  redirects[String(id)] = url;
  saveRedirects(redirects);
  res.json({ ok: true });
});

app.get('/iphones', (req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
  if (!iphoneSnapshot) {
    res
      .status(503)
      .send('Painel ainda sem dados. O bot envia uma atualização a cada 10 minutos — tente de novo em instantes.');
    return;
  }
  if (!hasViewKey(req)) {
    res.status(404).send('Link não encontrado.');
    return;
  }
  res.sendFile(path.join(__dirname, 'public', 'iphones.html'));
});

app.get('/iphones/data.json', (req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
  if (!iphoneSnapshot || !hasViewKey(req)) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const { viewKey: _viewKey, ...publicData } = iphoneSnapshot;
  const imports = iphoneImports.map(({ html: _html, ...rest }) => rest);
  res.json({ ...publicData, imports });
});

app.post('/iphones/upload', (req, res) => {
  if (!iphoneSnapshot || !hasViewKey(req)) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  const { filename, html, savedAt } = req.body ?? {};
  if (typeof html !== 'string' || !html.includes('__NEXT_DATA__')) {
    res.status(400).json({ error: 'Esse arquivo não parece uma página de busca salva do Zoom ou do Buscapé.' });
    return;
  }

  // Quando a página foi salva no navegador (lastModified do arquivo); nunca no futuro.
  const now = Date.now();
  const savedAtMs = Number.isFinite(savedAt) && savedAt > 0 ? Math.min(savedAt, now) : now;

  const upload = {
    id: crypto.randomUUID(),
    filename: String(filename ?? 'pagina.html').slice(0, 200),
    uploadedAt: new Date(now).toISOString(),
    savedAt: new Date(savedAtMs).toISOString(),
    status: 'pending',
    html,
  };
  iphoneImports.unshift(upload);
  iphoneImports.splice(MAX_IMPORTS_KEPT);
  res.json({ ok: true, id: upload.id });
});

app.get('/iphones/imports', (req, res) => {
  if (req.headers.authorization !== `Bearer ${SYNC_SECRET}`) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  res.json(iphoneImports.filter((u) => u.status === 'pending'));
});

app.post('/iphones/imports/:id/result', (req, res) => {
  if (req.headers.authorization !== `Bearer ${SYNC_SECRET}`) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  const upload = iphoneImports.find((u) => u.id === req.params.id);
  if (!upload) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  upload.status = req.body?.ok ? 'done' : 'error';
  upload.result = req.body ?? null;
  upload.html = null;
  res.json({ ok: true });
});

app.post('/iphones/sync', (req, res) => {
  if (req.headers.authorization !== `Bearer ${SYNC_SECRET}`) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const snapshot = req.body;
  if (!snapshot?.viewKey || !Array.isArray(snapshot.groups)) {
    res.status(400).json({ error: 'viewKey e groups são obrigatórios' });
    return;
  }

  iphoneSnapshot = snapshot;
  fs.mkdirSync(path.dirname(IPHONES_FILE), { recursive: true });
  fs.writeFileSync(IPHONES_FILE, JSON.stringify(snapshot), 'utf-8');
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Redirecionador rodando na porta ${PORT}. ${Object.keys(redirects).length} link(s) carregado(s).`);
});
