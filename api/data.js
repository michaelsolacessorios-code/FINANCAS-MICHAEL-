// =====================================================================
// POST /api/data  { acao, ... }
// Rota única do app. TUDO passa por aqui e TUDO é filtrado pelo usuário
// do token — é isso que garante que você só vê o seu e ela só vê o dela.
// =====================================================================
const crypto = require('crypto');
const {
  select, insert, update, remover, rpc,
  gerarHashSenha, usuarioLogado, lerCorpo, primeiroDiaDoMes,
} = require('./_lib');

const uuid = (v) => /^[0-9a-f-]{36}$/i.test(String(v || ''));

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });

  try {
    const corpo = lerCorpo(req);
    const eu = await usuarioLogado(req);
    if (!eu) return res.status(401).json({ error: 'Sessão expirada. Entre de novo.' });

    const meu = `user_id=eq.${eu.id}`;
    const acao = corpo.acao;
    const d = corpo.dados || {};

    // -----------------------------------------------------------------
    // LEITURA DO MÊS
    // -----------------------------------------------------------------
    if (acao === 'mes') {
      const mesRef = primeiroDiaDoMes(d.mes);

      // ativa planos vencidos e gera as linhas fixas do mês
      await rpc('fin_ativar_planos').catch(() => {});
      await rpc('fin_gerar_mes',
