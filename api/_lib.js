// =====================================================================
// Funções compartilhadas pelas rotas /api
// Sem dependências externas — usa fetch nativo do Node 18+ da Vercel.
// =====================================================================
const crypto = require('crypto');

const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  process.env.VITE_SUPABASE_URL ||
  process.env.SUPABASE_PROJECT_URL;

const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_KEY;

function checarConfig() {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw new Error(
      'Variáveis de ambiente faltando na Vercel. Precisa de SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY.'
    );
  }
}

// --------------------------- Supabase REST ---------------------------
async function sb(caminho, opcoes = {}) {
  checarConfig();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${caminho}`, {
    ...opcoes,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: opcoes.prefer || 'return=representation',
      ...(opcoes.headers || {}),
    },
  });
  const texto = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${texto}`);
  return texto ? JSON.parse(texto) : null;
}

const select = (tabela, query = '') => sb(`${tabela}?${query}`);
const insert = (tabela, linhas) =>
  sb(tabela, { method: 'POST', body: JSON.stringify(linhas) });
const update = (tabela, query, patch) =>
  sb(`${tabela}?${query}`, { method: 'PATCH', body: JSON.stringify(patch) });
const remover = (tabela, query) =>
  sb(`${tabela}?${query}`, { method: 'DELETE' });

async function rpc(funcao, args = {}) {
  checarConfig();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${funcao}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  const texto = await res.text();
  if (!res.ok) throw new Error(`RPC ${funcao} ${res.status}: ${texto}`);
  return texto ? JSON.parse(texto) : null;
}

// --------------------------- Senha (scrypt) --------------------------
// Mesmo formato que já está gravado hoje: "salt:hash"
// (salt = 16 bytes hex, hash = 64 bytes hex)
function gerarHashSenha(senha) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(senha), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function conferirSenha(senha, guardado) {
  try {
    const [salt, hash] = String(guardado).split(':');
    if (!salt || !hash) return false;
    const calculado = crypto.scryptSync(String(senha), salt, 64).toString('hex');
    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(calculado, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// --------------------------- Token de sessão -------------------------
// Assinado com a própria service key (não precisa criar variável nova).
const DIAS_VALIDADE = 30;

function criarToken(userId) {
  checarConfig();
  const corpo = Buffer.from(
    JSON.stringify({ u: userId, exp: Date.now() + DIAS_VALIDADE * 864e5 })
  ).toString('base64url');
  const assinatura = crypto
    .createHmac('sha256', SERVICE_KEY)
    .update(corpo)
    .digest('hex');
  return `${corpo}.${assinatura}`;
}

function lerToken(token) {
  checarConfig();
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [corpo, assinatura] = token.split('.');
  const esperado = crypto
    .createHmac('sha256', SERVICE_KEY)
    .update(corpo)
    .digest('hex');
  if (
    assinatura.length !== esperado.length ||
    !crypto.timingSafeEqual(Buffer.from(assinatura), Buffer.from(esperado))
  ) {
    return null;
  }
  try {
    const dados = JSON.parse(Buffer.from(corpo, 'base64url').toString());
    if (!dados.exp || dados.exp < Date.now()) return null;
    return dados.u;
  } catch {
    return null;
  }
}

// Devolve o usuário logado (ou null). É daqui que sai a separação de dados.
async function usuarioLogado(req) {
  const cabecalho = req.headers.authorization || '';
  const token = cabecalho.replace(/^Bearer /i, '') || (req.body && req.body.token);
  const id = lerToken(token);
  if (!id) return null;
  const lista = await select(
    'fin_usuarios',
    `id=eq.${id}&select=id,nome,usuario,admin,foto,parceiro_id`
  );
  return lista && lista[0] ? lista[0] : null;
}

// --------------------------- Utilidades ------------------------------
function lerCorpo(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body;
}

function primeiroDiaDoMes(mes) {
  // aceita "2026-09" ou "2026-09-15"
  return `${String(mes).slice(0, 7)}-01`;
}

function semSenha(u) {
  const { senha, ...resto } = u || {};
  return resto;
}

module.exports = {
  sb, select, insert, update, remover, rpc,
  gerarHashSenha, conferirSenha,
  criarToken, lerToken, usuarioLogado,
  lerCorpo, primeiroDiaDoMes, semSenha,
};
