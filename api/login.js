// Função serverless de login — verifica usuário/senha AQUI (no servidor), nunca no navegador.

import crypto from 'crypto';

function hashComSalt(senha, salt) {
  return crypto.scryptSync(senha, salt, 64).toString('hex');
}
function novoHash(senha) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + hashComSalt(senha, salt);
}
function senhaConfere(digitada, salva) {
  if (!salva || !salva.includes(':')) return false;
  const [salt, hash] = salva.split(':');
  try { return hashComSalt(digitada, salt) === hash; } catch { return false; }
}

async function getKV(base, key, headers) {
  const r = await fetch(`${base}/rest/v1/fin_kv?key=eq.${encodeURIComponent(key)}&select=value`, { headers });
  if (!r.ok) return null;
  const rows = await r.json();
  return rows.length ? rows[0].value : null;
}
async function setKV(base, key, value, headers) {
  await fetch(`${base}/rest/v1/fin_kv?on_conflict=key`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Configuração do servidor incompleta.' });
  }
  const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };

  const { usuario, senha } = req.body || {};
  if (!usuario || !senha) return res.status(400).json({ error: 'Informe usuário e senha.' });

  try {
    const usuarios = (await getKV(SUPABASE_URL, 'fin:usuarios', headers)) || [];
    const u = usuarios.find(x => x.usuario === usuario);
    if (!u) return res.status(200).json({ ok: false, message: 'Usuário não encontrado.' });
    if (senhaConfere(senha, u.senha)) {
      return res.status(200).json({ ok: true, nome: u.nome, usuario: u.usuario, admin: !!u.admin });
    }
    return res.status(200).json({ ok: false, message: 'Senha incorreta.' });
  } catch (err) {
    return res.status(500).json({ error: 'Erro no servidor: ' + err.message });
  }
}
