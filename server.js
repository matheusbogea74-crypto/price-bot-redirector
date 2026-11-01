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

const app = express();
app.use(express.json({ limit: '2mb' }));

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
  res.json(publicData);
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
