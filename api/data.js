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
      await rpc('fin_gerar_mes', { p_user: eu.id, p_mes: mesRef }).catch(() => {});
      if (eu.parceiro_id) {
        await rpc('fin_gerar_mes', { p_user: eu.parceiro_id, p_mes: mesRef }).catch(() => {});
      }

      const ids = [eu.id, eu.parceiro_id].filter(Boolean);
      const filtroDupla = `user_id=in.(${ids.join(',')})`;

      const [entradas, saidas, futuras, categorias, contasFixas, entradasFixas, planos, usuarios] =
        await Promise.all([
          select('fin_entradas', `${filtroDupla}&mes_ref=eq.${mesRef}&select=*&order=data`),
          select('fin_saidas', `${filtroDupla}&mes_ref=eq.${mesRef}&select=*&order=data`),
          // futuras: só parceladas/planos/avulsas — fixas não, porque são infinitas
          select('fin_saidas', `${meu}&mes_ref=gt.${mesRef}&conta_fixa_id=is.null&select=*&order=data`),
          select('fin_categorias', `${meu}&select=*&order=nome`),
          select('fin_contas_fixas', `${meu}&select=*&order=dia_vencimento`),
          select('fin_entradas_fixas', `${meu}&select=*&order=dia`),
          select('fin_planos', `${meu}&select=*&order=data_inicio`),
          select('fin_usuarios', 'select=id,nome,usuario,admin,foto,parceiro_id&order=created_at'),
        ]);

      return res.json({
        ok: true, eu, mes: mesRef,
        entradas, saidas, futuras, categorias, contasFixas, entradasFixas, planos, usuarios,
      });
    }

    // -----------------------------------------------------------------
    // ANO INTEIRO (gráfico de evolução)
    // -----------------------------------------------------------------
    if (acao === 'ano') {
      const ano = String(d.ano || new Date().getFullYear());
      const ids = [eu.id, eu.parceiro_id].filter(Boolean);
      const filtroDupla = `user_id=in.(${ids.join(',')})`;
      const de = `${ano}-01-01`, ate = `${ano}-12-01`;
      const [entradas, saidas] = await Promise.all([
        select('fin_entradas', `${filtroDupla}&mes_ref=gte.${de}&mes_ref=lte.${ate}&select=user_id,valor,mes_ref,tipo`),
        select('fin_saidas', `${filtroDupla}&mes_ref=gte.${de}&mes_ref=lte.${ate}&select=user_id,valor,mes_ref,categoria,conta_fixa_id,pago`),
      ]);
      return res.json({ ok: true, entradas, saidas });
    }

    // -----------------------------------------------------------------
    // ENTRADAS
    // -----------------------------------------------------------------
    if (acao === 'entrada.salvar') {
      const linha = {
        tipo: d.tipo, descricao: d.descricao, valor: Number(d.valor),
        data: d.data, mes_ref: primeiroDiaDoMes(d.data),
        recebido: !!d.recebido,
      };
      if (uuid(d.id)) {
        await update('fin_entradas', `id=eq.${d.id}&${meu}`, linha);
      } else {
        await insert('fin_entradas', { ...linha, user_id: eu.id });
      }
      return res.json({ ok: true });
    }

    if (acao === 'entrada.excluir') {
      await remover('fin_entradas', `id=eq.${d.id}&${meu}`);
      return res.json({ ok: true });
    }

    if (acao === 'entradaFixa.salvar') {
      const linha = {
        tipo: d.tipo, descricao: d.descricao,
        valor_atual: Number(d.valor), dia: Number(d.dia),
        ativa: d.ativa !== false,
      };
      if (uuid(d.id)) {
        await update('fin_entradas_fixas', `id=eq.${d.id}&${meu}`, linha);
      } else {
        await insert('fin_entradas_fixas', { ...linha, user_id: eu.id });
      }
      await rpc('fin_gerar_mes', { p_user: eu.id, p_mes: primeiroDiaDoMes(d.mes) }).catch(() => {});
      return res.json({ ok: true });
    }

    if (acao === 'entradaFixa.excluir') {
      await remover('fin_entradas_fixas', `id=eq.${d.id}&${meu}`);
      return res.json({ ok: true });
    }

    // -----------------------------------------------------------------
    // SAÍDAS
    // -----------------------------------------------------------------
    if (acao === 'saida.salvar') {
      if (uuid(d.id)) {
        await update('fin_saidas', `id=eq.${d.id}&${meu}`, {
          nome: d.nome, categoria: d.categoria, valor: Number(d.valor),
          data: d.data, mes_ref: primeiroDiaDoMes(d.data),
        });
        return res.json({ ok: true });
      }

      const parcelas = Math.max(1, Number(d.parcelas) || 1);
      const [a, m, dia] = String(d.data).split('-').map(Number);

      if (parcelas === 1) {
        await insert('fin_saidas', {
          user_id: eu.id, nome: d.nome, categoria: d.categoria,
          valor: Number(d.valor), data: d.data, mes_ref: primeiroDiaDoMes(d.data),
        });
      } else {
        const valorParcela = Math.round((Number(d.valor) / parcelas) * 100) / 100;
        const grupo = crypto.randomUUID();
        const linhas = [];
        for (let i = 0; i < parcelas; i++) {
          const total = a * 12 + (m - 1) + i;
          const ano = Math.floor(total / 12);
          const mes = (total % 12) + 1;
          const ultimo = new Date(ano, mes, 0).getDate();
          const diaOk = Math.min(dia, ultimo);
          const dataParcela = `${ano}-${String(mes).padStart(2, '0')}-${String(diaOk).padStart(2, '0')}`;
          linhas.push({
            user_id: eu.id,
            nome: `${d.nome} (${i + 1}/${parcelas})`,
            categoria: d.categoria, valor: valorParcela,
            data: dataParcela, mes_ref: `${ano}-${String(mes).padStart(2, '0')}-01`,
            parcela_atual: i + 1, total_parcelas: parcelas, grupo_id: grupo,
          });
        }
        await insert('fin_saidas', linhas);
      }
      return res.json({ ok: true });
    }

    // Edita nome/categoria/valor total/quantidade de parcelas/data da 1ª
    // parcela de TODAS as parcelas de um grupo de uma vez.
    // - d.valor_total é o valor TOTAL (dividido igualmente pelas parcelas).
    // - Se a quantidade e a data da 1ª parcela não mudarem, só atualiza
    //   nome/categoria/valor e mantém as datas e o pago/não pago de cada uma.
    // - Se mudar a quantidade e/ou a data, recalcula as datas a partir da
    //   1ª parcela; parcelas que continuam existindo são só atualizadas
    //   (mantém o pago), as que sobram são criadas e as que não cabem mais
    //   são removidas — nunca apaga tudo e recria do zero.
    if (acao === 'saida.editarGrupo') {
      if (!uuid(d.grupo_id)) return res.json({ ok: false, message: 'Parcelamento inválido.' });
      const linhas = await select(
        'fin_saidas',
        `grupo_id=eq.${d.grupo_id}&${meu}&select=id,data,parcela_atual,total_parcelas,pago&order=parcela_atual`
      );
      if (!linhas || !linhas.length) {
        return res.json({ ok: false, message: 'Não achei essas parcelas.' });
      }
      const novoTotal = Math.max(1, Number(d.total_parcelas) || linhas.length);
      const valorTotal = Number(d.valor_total);
      if (!valorTotal) return res.json({ ok: false, message: 'Informe o valor total.' });
      const valorParcela = Math.round((valorTotal / novoTotal) * 100) / 100;
      const novaData = d.data || linhas[0].data;
      const mudouEsquema = novoTotal !== linhas.length || novaData !== linhas[0].data;

      if (!mudouEsquema) {
        await Promise.all(linhas.map(l => update('fin_saidas', `id=eq.${l.id}&${meu}`, {
          nome: `${d.nome} (${l.parcela_atual}/${novoTotal})`,
          categoria: d.categoria,
          valor: valorParcela,
        })));
        return res.json({ ok: true, atualizadas: linhas.length });
      }

      if (novoTotal < linhas.length && linhas.slice(novoTotal).some(l => l.pago)) {
        return res.json({ ok: false, message: 'Tem parcela já paga além dessa quantidade nova. Apague ela primeiro se quiser reduzir.' });
      }

      const [a, m, dia] = String(novaData).split('-').map(Number);
      const tarefas = [];
      for (let i = 0; i < Math.max(novoTotal, linhas.length); i++) {
        const total = a * 12 + (m - 1) + i;
        const ano = Math.floor(total / 12);
        const mes = (total % 12) + 1;
        const ultimo = new Date(ano, mes, 0).getDate();
        const diaOk = Math.min(dia, ultimo);
        const dataParcela = `${ano}-${String(mes).padStart(2, '0')}-${String(diaOk).padStart(2, '0')}`;
        const mesRefParcela = `${ano}-${String(mes).padStart(2, '0')}-01`;
        if (i < novoTotal && i < linhas.length) {
          tarefas.push(update('fin_saidas', `id=eq.${linhas[i].id}&${meu}`, {
            nome: `${d.nome} (${i + 1}/${novoTotal})`, categoria: d.categoria, valor: valorParcela,
            data: dataParcela, mes_ref: mesRefParcela, parcela_atual: i + 1, total_parcelas: novoTotal,
          }));
        } else if (i < novoTotal) {
          tarefas.push(insert('fin_saidas', {
            user_id: eu.id, nome: `${d.nome} (${i + 1}/${novoTotal})`, categoria: d.categoria, valor: valorParcela,
            data: dataParcela, mes_ref: mesRefParcela, parcela_atual: i + 1, total_parcelas: novoTotal, grupo_id: d.grupo_id,
          }));
        } else {
          tarefas.push(remover('fin_saidas', `id=eq.${linhas[i].id}&${meu}`));
        }
      }
      await Promise.all(tarefas);
      return res.json({ ok: true, total_parcelas: novoTotal });
    }

    if (acao === 'saida.pago') {
      await update('fin_saidas', `id=eq.${d.id}&${meu}`, {
        pago: !!d.pago,
        data_pagamento: d.pago ? new Date().toISOString().slice(0, 10) : null,
      });
      return res.json({ ok: true });
    }

    if (acao === 'saida.excluir') {
      if (d.grupoTodo && uuid(d.grupo_id)) {
        await remover('fin_saidas', `grupo_id=eq.${d.grupo_id}&${meu}`);
      } else {
        await remover('fin_saidas', `id=eq.${d.id}&${meu}`);
      }
      return res.json({ ok: true });
    }

    // -----------------------------------------------------------------
    // CONTAS FIXAS
    // -----------------------------------------------------------------
    if (acao === 'contaFixa.salvar') {
      const linha = {
        nome: d.nome, categoria: d.categoria,
        valor_atual: Number(d.valor), dia_vencimento: Number(d.dia),
        ativa: d.ativa !== false,
      };
      if (uuid(d.id)) {
        await update('fin_contas_fixas', `id=eq.${d.id}&${meu}`, linha);
      } else {
        await insert('fin_contas_fixas', { ...linha, user_id: eu.id });
      }
      await rpc('fin_gerar_mes', { p_user: eu.id, p_mes: primeiroDiaDoMes(d.mes) }).catch(() => {});
      return res.json({ ok: true });
    }

    if (acao === 'contaFixa.excluir') {
      // apaga o modelo e as linhas dos meses (cascade no banco)
      await remover('fin_contas_fixas', `id=eq.${d.id}&${meu}`);
      return res.json({ ok: true });
    }

    // -----------------------------------------------------------------
    // PLANOS
    // -----------------------------------------------------------------
    if (acao === 'plano.salvar') {
      const linha = {
        nome: d.nome, resumo: d.resumo, valor_total: Number(d.valor_total),
        forma_pagamento: d.forma_pagamento,
        parcelas: d.forma_pagamento === 'parcelado' ? Math.max(2, Number(d.parcelas) || 2) : 1,
        data_inicio: d.data_inicio,
      };
      if (uuid(d.id)) {
        await update('fin_planos', `id=eq.${d.id}&${meu}`, linha);
      } else {
        await insert('fin_planos', { ...linha, user_id: eu.id, status: 'pendente' });
      }
      return res.json({ ok: true });
    }

    if (acao === 'plano.adiar') {
      await update('fin_planos', `id=eq.${d.id}&${meu}`, {
        data_inicio: d.nova_data, status: 'pendente',
      });
      return res.json({ ok: true });
    }

    if (acao === 'plano.concluir') {
      await update('fin_planos', `id=eq.${d.id}&${meu}`, { status: 'concluido' });
      return res.json({ ok: true });
    }

    if (acao === 'plano.excluir') {
      await remover('fin_planos', `id=eq.${d.id}&${meu}`);
      return res.json({ ok: true });
    }

    // -----------------------------------------------------------------
    // CATEGORIAS
    // -----------------------------------------------------------------
    if (acao === 'categoria.salvar') {
      await insert('fin_categorias', {
        user_id: eu.id, nome: d.nome, tipo: d.tipo || 'saida',
      }).catch(() => {});
      return res.json({ ok: true });
    }

    if (acao === 'categoria.excluir') {
      await remover('fin_categorias', `id=eq.${d.id}&${meu}`);
      return res.json({ ok: true });
    }

    // -----------------------------------------------------------------
    // PERFIL / USUÁRIOS
    // -----------------------------------------------------------------
    if (acao === 'perfil.foto') {
      await update('fin_usuarios', `id=eq.${eu.id}`, { foto: d.foto });
      return res.json({ ok: true });
    }

    if (acao === 'perfil.senha') {
      await update('fin_usuarios', `id=eq.${eu.id}`, { senha: gerarHashSenha(d.senha) });
      return res.json({ ok: true });
    }

    // daqui pra baixo, só admin
    if (!eu.admin) return res.status(403).json({ error: 'Só o administrador pode fazer isso.' });

    if (acao === 'usuario.criar') {
      const login = String(d.usuario).trim().toLowerCase();
      const jaTem = await select('fin_usuarios', `usuario=eq.${encodeURIComponent(login)}&select=id`);
      if (jaTem && jaTem.length) {
        return res.json({ ok: false, message: 'Esse usuário já existe.' });
      }
      await insert('fin_usuarios', {
        nome: d.nome, usuario: login, senha: gerarHashSenha(d.senha), admin: !!d.admin,
      });
      return res.json({ ok: true });
    }

    if (acao === 'usuario.senha') {
      await update('fin_usuarios', `id=eq.${d.id}`, { senha: gerarHashSenha(d.senha) });
      return res.json({ ok: true });
    }

    if (acao === 'usuario.excluir') {
      if (d.id === eu.id) return res.json({ ok: false, message: 'Você não pode se remover.' });
      await remover('fin_usuarios', `id=eq.${d.id}`);
      return res.json({ ok: true });
    }

    // Vincular/desvincular casal (liga os dois lados de uma vez)
    if (acao === 'usuario.vincular') {
      const a = d.id_1, b = d.id_2;
      if (!uuid(a)) return res.json({ ok: false, message: 'Usuário inválido.' });
      if (b === null || b === '' || b === undefined) {
        const atual = await select('fin_usuarios', `id=eq.${a}&select=parceiro_id`);
        const antigo = atual && atual[0] && atual[0].parceiro_id;
        await update('fin_usuarios', `id=eq.${a}`, { parceiro_id: null });
        if (antigo) await update('fin_usuarios', `id=eq.${antigo}`, { parceiro_id: null });
        return res.json({ ok: true });
      }
      await update('fin_usuarios', `id=eq.${a}`, { parceiro_id: b });
      await update('fin_usuarios', `id=eq.${b}`, { parceiro_id: a });
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: `Ação desconhecida: ${acao}` });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
