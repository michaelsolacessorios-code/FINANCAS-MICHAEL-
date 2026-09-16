// =====================================================================
// POST /api/login  { usuario, senha }
// Confere a senha (scrypt, mesmo formato antigo) e devolve um token.
// =====================================================================
const { select, conferirSenha, criarToken, lerCorpo, semSenha } = require('./_lib');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Use POST.' });
  }
  try {
    const { usuario, senha } = lerCorpo(req);
    if (!usuario || !senha) {
      return res.status(200).json({ ok: false, message: 'Preencha usuário e senha.' });
    }

    const login = String(usuario).trim().toLowerCase();
    const lista = await select(
      'fin_usuarios',
      `usuario=eq.${encodeURIComponent(login)}&select=*&limit=1`
    );
    const u = lista && lista[0];

    if (!u || !conferirSenha(senha, u.senha)) {
      return res.status(200).json({ ok: false, message: 'Usuário ou senha incorretos.' });
    }

    return res.status(200).json({
      ok: true,
      token: criarToken(u.id),
      usuario: semSenha(u),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
