import 'dotenv/config';
import express from 'express';
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

const app = express();
app.use(express.json());

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

app.listen(PORT, () => {
  console.log(`Redirecionador rodando na porta ${PORT}. ${Object.keys(redirects).length} link(s) carregado(s).`);
});
