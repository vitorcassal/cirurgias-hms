/* =========================================================================
   Cirurgias HSM — Apps Script (backend)
   Liga o aplicativo do celular à planilha do Google Sheets e faz a leitura
   da etiqueta do paciente com a IA de visão do Gemini.

   Suporta DOIS hospitais, cada um com sua própria aba e seu próprio
   conjunto de campos:
     • HMS  → aba "CIRURGIAS APP"  (6 colunas, inclui Honorário)
     • HMC  → aba "HMC"            (7 colunas, fluxo novo)
   Todo pedido do app (extract/save/report) chega com "hospital": "HMS" ou
   "HMC" e é roteado para a lógica certa.

   RELATÓRIO MENSAL (action "report"): soma cirurgias, valores e — no caso
   do HMS — também os atendimentos de ambulatório, lidos da aba "AMBU" que
   você já mantém manualmente na planilha (Número de Pacientes | Data).

   COMO USAR (resumo — o passo a passo completo está no GUIA):
   1) Abra a planilha → Extensões → Apps Script.
   2) Cole este arquivo inteiro no editor (substituindo o que houver).
   3) Em "Configurações do projeto" → Propriedades do script, crie a
      propriedade  GEMINI_API_KEY  com a sua chave do Gemini.
   4) Rode UMA vez a função  configurarPlanilha  (reorganiza as colunas do
      HMS preservando os registros antigos) e UMA vez  configurarAbaHMC
      (cria a aba nova do HMC já com o cabeçalho pronto).
   5) Implante como "Aplicativo da Web" (executar como você; acesso: qualquer
      pessoa) e copie a URL terminada em /exec para dentro do app.
   ========================================================================= */

/* ---------- CONFIGURAÇÕES ---------- */
var DOC_ID     = "1Z_4Bgn6_kyROaUGuOF1RGxqmxofPd_alC1S9nZ6U85s";
var ABA_ORIGEM = "CIRURGIAS";       // aba original do HMS (só existia antes da 1ª migração)
var ABA_APP    = "CIRURGIAS APP";   // aba do HMS que o app usa
var ABA_HMC    = "HMC";             // aba do HMC que o app usa
var ABA_AMBU   = "AMBU";            // aba com os atendimentos diários do ambulatório (Número de Pacientes | Data) — lida pelo relatório e gravada pelo botão "Consultas Ambulatório" do app
var MODELO     = "gemini-2.5-flash";   // modelo de visão do Gemini (atual em 2026)

var CABECALHOS = [                  // colunas da aba do HMS
  "Nome Completo",
  "Data de Nascimento",
  "Procedimento Realizado",
  "Data do Procedimento",
  "Intercorrências",
  "Honorário"
];

// Ordem fixa usada no relatório mensal do HMS — corresponde às opções do
// dropdown "Procedimento realizado" da Tela 2. Textos antigos digitados
// livremente que não batam com nenhuma delas caem em "Outros".
var ORDEM_PROCEDIMENTOS_HMS = [
  "Hernioplastia inguinal",
  "Hernioplastia umbilical",
  "Hernioplastia incisional",
  "Hernioplastia epigástrica",
  "Colecistectomia convencional",
  "Outros"
];

// Valores padrão dos procedimentos do HMS (tabela de honorários)
var VALORES_PADRAO_HMS = {
  "Hernioplastia inguinal":    "220,00",
  "Hernioplastia umbilical":   "220,00",
  "Hernioplastia incisional":  "220,00",
  "Hernioplastia epigástrica": "220,00",
  "Colecistectomia convencional": "450,00"
};

var CABECALHOS_AMBU = [             // colunas da aba do ambulatório (ordem já existente na planilha)
  "Número de Pacientes",
  "Data"
];

var CABECALHOS_HMC = [              // colunas da aba do HMC
  "Data",
  "Nome Completo",
  "Número de Atendimento",
  "Procedimento Realizado",
  "Chefe",
  "Convênio",
  "Apartamento"
];

/* =========================================================================
   PONTO DE ENTRADA — recebe as chamadas do app (POST)
   ========================================================================= */
function doPost(e) {
  try {
    var req = JSON.parse(e.postData.contents);
    var action = req.action;

    if (action === "extract")  return _json(extrairEtiqueta(req));
    if (action === "save")     return _json(salvarRegistro(req));
    if (action === "saveAmbu") return _json(salvarAmbulatorio(req));
    if (action === "report")   return _json(gerarRelatorio(req));

    return _json({ ok: false, erro: "Ação desconhecida." });
  } catch (err) {
    return _json({ ok: false, erro: "Erro no servidor: " + err.message });
  }
}

/* Resposta ao abrir a URL no navegador (ou se, por algum motivo, o app
   fizer uma requisição GET em vez de POST). Devolve JSON — assim, se o app
   algum dia receber esta resposta por engano, ele consegue mostrar uma
   mensagem clara em vez de travar com um erro de "JSON inválido". */
function doGet() {
  return _json({
    ok: false,
    erro: "Este endereço está ativo, mas só responde de verdade a requisições " +
      "enviadas pelo app (POST). Se esta mensagem apareceu DEPOIS de tentar " +
      "extrair uma etiqueta ou salvar um registro (não de você abrir a URL " +
      "direto no navegador para testar), normalmente é sinal de que o Apps " +
      "Script foi editado mas não foi reimplantado: vá em Implantar → " +
      "Gerenciar implantações → clique no lápis de editar → Versão: Nova " +
      "versão → Implantar. Confira também se a URL configurada no app (⚙️) " +
      "é a mesma URL /exec da implantação atual."
  });
}

function _json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* Normaliza o valor recebido do app para "HMS" ou "HMC" (padrão: HMS) */
function _hospital(req) {
  return (req && req.hospital === "HMC") ? "HMC" : "HMS";
}

/* =========================================================================
   1) EXTRAÇÃO DA ETIQUETA COM GEMINI VISION
   O JSON pedido à IA muda conforme o hospital.
   ========================================================================= */
function extrairEtiqueta(req) {
  var apiKey = PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY");
  if (!apiKey) return { ok: false, erro: "Chave do Gemini não configurada (GEMINI_API_KEY)." };
  if (!req.imageBase64) return { ok: false, erro: "Imagem não recebida." };

  var hospital = _hospital(req);
  var instrucao = hospital === "HMC" ? _instrucaoHMC() : _instrucaoHMS();

  var url = "https://generativelanguage.googleapis.com/v1beta/models/" +
            MODELO + ":generateContent?key=" + apiKey;

  var payload = {
    contents: [{
      parts: [
        { text: instrucao },
        { inline_data: { mime_type: req.mimeType || "image/jpeg", data: req.imageBase64 } }
      ]
    }],
    generationConfig: { temperature: 0, response_mime_type: "application/json" }
  };

  var resp = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  if (resp.getResponseCode() !== 200) {
    return { ok: false, erro: "Falha na IA (" + resp.getResponseCode() + ")." };
  }

  var dados;
  try {
    var out = JSON.parse(resp.getContentText());
    var texto = out.candidates[0].content.parts[0].text;
    dados = JSON.parse(_limparJson(texto));
  } catch (err) {
    return { ok: false, erro: "Não consegui interpretar a resposta da IA." };
  }

  if (hospital === "HMC") {
    return {
      ok: true,
      nome_completo:     _str(dados.nome_completo),
      data:               _data(dados.data),
      numero_atendimento: _str(dados.numero_atendimento),
      convenio:           _str(dados.convenio)
    };
  }

  return {
    ok: true,
    nome_completo:   _str(dados.nome_completo),
    data_nascimento: _data(dados.data_nascimento),
    data_admissao:   _data(dados.data_admissao),
    prontuario:      _str(dados.prontuario)
  };
}

function _instrucaoHMS() {
  return "Você é um leitor de etiquetas hospitalares. A imagem é a etiqueta de identificação " +
    "de um paciente internado. Extraia EXATAMENTE estes campos e devolva SOMENTE um JSON, " +
    "sem texto extra, sem markdown:\n" +
    "{\n" +
    '  "nome_completo": "",\n' +
    '  "data_nascimento": "DD/MM/AAAA",\n' +
    '  "data_admissao": "DD/MM/AAAA",\n' +
    '  "prontuario": ""\n' +
    "}\n" +
    "Regras: normalize todas as datas para o formato DD/MM/AAAA. " +
    "data_admissao é a data de admissão/internação. " +
    "prontuario é o número de prontuário/registro/atendimento. " +
    "Se algum campo não estiver legível na etiqueta, devolva string vazia para ele. " +
    "NUNCA invente dados que não estejam claramente visíveis.";
}

function _instrucaoHMC() {
  return "Você é um leitor de etiquetas hospitalares. A imagem é a etiqueta de identificação " +
    "de um paciente internado. Extraia EXATAMENTE estes campos e devolva SOMENTE um JSON, " +
    "sem texto extra, sem markdown:\n" +
    "{\n" +
    '  "data": "DD/MM/AAAA",\n' +
    '  "nome_completo": "",\n' +
    '  "numero_atendimento": "",\n' +
    '  "convenio": ""\n' +
    "}\n" +
    "Regras: normalize a data para o formato DD/MM/AAAA (data de admissão/internação impressa " +
    "na etiqueta). numero_atendimento é o número de atendimento/registro do paciente. " +
    "convenio é o nome do convênio/plano de saúde impresso na etiqueta, se houver. " +
    "Se algum campo não estiver legível na etiqueta, devolva string vazia para ele. " +
    "NUNCA invente dados que não estejam claramente visíveis.";
}

/* =========================================================================
   2) SALVAR REGISTRO (com checagem de duplicata) — roteia por hospital
   ========================================================================= */
function salvarRegistro(req) {
  return (_hospital(req) === "HMC") ? _salvarHMC(req) : _salvarHMS(req);
}

function _salvarHMS(req) {
  var nome  = _str(req.nome_completo);
  var proc  = _str(req.procedimento_realizado);
  var dProc = _str(req.data_procedimento);

  if (!nome || !proc || !dProc) {
    return { ok: false, erro: "Campos obrigatórios ausentes." };
  }

  var aba = _aba("HMS");
  _garantirCabecalhos(aba, "HMS");

  // Checagem de duplicata: mesmo Nome Completo + mesma Data do Procedimento
  if (!req.forcar && _existeDuplicataHMS(aba, nome, dProc)) {
    return {
      duplicate: true,
      mensagem: "Já existe um registro de \"" + nome + "\" na data " + dProc +
                ". Deseja salvar mesmo assim?"
    };
  }

  var valor = _str(req.valor);
  if (!valor) {
    var cat = _categoriaProcedimentoHMS(proc);
    if (VALORES_PADRAO_HMS[cat]) {
      valor = VALORES_PADRAO_HMS[cat];
    }
  }

  _gravarLinha(aba, [
    nome,
    _str(req.data_nascimento),
    proc,
    dProc,
    _str(req.intercorrencias),
    _formatarValor(valor)
  ]);

  return { ok: true };
}

function _salvarHMC(req) {
  var nome        = _str(req.nome_completo);
  var data        = _str(req.data);
  var atendimento = _str(req.numero_atendimento);
  var proc        = _str(req.procedimento_realizado);
  var chefe       = _str(req.chefe);
  var apartamento = _str(req.apartamento);

  if (!nome || !data || !atendimento || !proc || !chefe || !apartamento) {
    return { ok: false, erro: "Campos obrigatórios ausentes." };
  }

  var aba = _aba("HMC");
  _garantirCabecalhos(aba, "HMC");

  // Checagem de duplicata: mesmo Nome Completo + mesmo Número de Atendimento
  if (!req.forcar && _existeDuplicataHMC(aba, nome, atendimento)) {
    return {
      duplicate: true,
      mensagem: "Já existe um registro de \"" + nome + "\" com o atendimento " + atendimento +
                ". Deseja salvar mesmo assim?"
    };
  }

  _gravarLinha(aba, [
    _data(data),
    nome,
    atendimento,
    proc,
    chefe,
    _str(req.convenio),
    apartamento
  ]);

  return { ok: true };
}

/* =========================================================================
   2b) SALVAR ATENDIMENTOS DO AMBULATÓRIO (aba "AMBU" — só HMS)
   Recebe { data: "DD/MM/AAAA", quantidade: N } e grava uma linha nova na
   aba AMBU, no formato que ela já usa: Número de Pacientes | Data.
   Checagem de duplicata: já existe lançamento para a MESMA data.
   ========================================================================= */
function salvarAmbulatorio(req) {
  var data = _data(_str(req.data));
  var qtd  = Number(req.quantidade);

  if (!data || !/^\d{2}\/\d{2}\/\d{4}$/.test(data)) {
    return { ok: false, erro: "Data inválida." };
  }
  if (!qtd || qtd < 1 || qtd !== Math.floor(qtd)) {
    return { ok: false, erro: "Número de atendimentos inválido." };
  }

  var ss = SpreadsheetApp.openById(DOC_ID);
  var aba = ss.getSheetByName(ABA_AMBU);
  if (!aba) {
    aba = ss.insertSheet(ABA_AMBU);
    aba.getRange(1, 1, 1, CABECALHOS_AMBU.length).setValues([CABECALHOS_AMBU])
       .setFontWeight("bold").setBackground("#0b6e6e").setFontColor("#ffffff");
    aba.setFrozenRows(1);
  } else if (aba.getLastRow() === 0) {
    aba.getRange(1, 1, 1, CABECALHOS_AMBU.length).setValues([CABECALHOS_AMBU])
       .setFontWeight("bold").setBackground("#0b6e6e").setFontColor("#ffffff");
    aba.setFrozenRows(1);
  }

  if (!req.forcar) {
    var existente = _atendimentosNaData(aba, data);
    if (existente !== null) {
      return {
        duplicate: true,
        mensagem: "Já existe um lançamento de ambulatório em " + data +
                  " (" + existente + " atendimento(s)). Deseja salvar mesmo assim? " +
                  "Isso criará um segundo lançamento nessa data."
      };
    }
  }

  _gravarLinha(aba, [qtd, data]);
  return { ok: true };
}

/* Devolve o número de pacientes já lançado na data informada, ou null se
   ainda não houver nenhum lançamento naquele dia. */
function _atendimentosNaData(aba, dataBR) {
  var ultima = aba.getLastRow();
  if (ultima < 2) return null;
  var valores = aba.getRange(2, 1, ultima - 1, 2).getValues(); // Número de Pacientes | Data
  for (var i = 0; i < valores.length; i++) {
    if (_data(valores[i][1]) === dataBR) return Number(valores[i][0]) || 0;
  }
  return null;
}

/* =========================================================================
   GRAVAÇÃO SEGURA DE UMA LINHA NOVA
   -------------------------------------------------------------------------
   Antes usávamos aba.appendRow(). O appendRow NÃO calcula a última linha
   preenchida: ele confia no "intervalo de dados" que o próprio Google Sheets
   mantém para a aba. Esse intervalo fica inflado por qualquer conteúdo
   invisível lá embaixo — um espaço digitado sem querer, uma célula que ficou
   com texto vazio depois de um "apagar" incompleto, uma fórmula que devolve
   "", um arrasto de preenchimento automático até o fim da grade, ou um
   objeto "Tabela" cobrindo a aba inteira. Quando isso acontece, o Sheets
   considera que a aba tem ~1000 linhas de dados e o appendRow grava DEPOIS
   disso — daí o registro aparecer centenas de linhas abaixo do último.
   Como o conteúdo invisível costuma ser apagado depois, o problema é
   intermitente: some sozinho e volta.

   _primeiraLinhaLivre varre de baixo para cima SOMENTE as colunas que o app
   usa e ignora células que contenham apenas espaços — devolvendo a primeira
   linha realmente livre. Assim a gravação passa a ser imune a esse estado da
   planilha.
   ========================================================================= */
function _primeiraLinhaLivre(aba, nCols) {
  var maxLin = aba.getMaxRows();
  if (maxLin < 2) return 2;

  var valores = aba.getRange(1, 1, maxLin, nCols).getValues();
  for (var i = valores.length - 1; i >= 1; i--) {   // i = 0 é o cabeçalho
    for (var j = 0; j < nCols; j++) {
      if (String(valores[i][j]).trim() !== "") return i + 2;
    }
  }
  return 2;
}

function _gravarLinha(aba, valores) {
  var linha = _primeiraLinhaLivre(aba, valores.length);

  // Se a linha calculada passar do tamanho atual da grade, cria espaço.
  if (linha > aba.getMaxRows()) {
    aba.insertRowsAfter(aba.getMaxRows(), linha - aba.getMaxRows());
  }

  aba.getRange(linha, 1, 1, valores.length).setValues([valores]);
}

function _existeDuplicataHMS(aba, nome, dProc) {
  var ultima = aba.getLastRow();
  if (ultima < 2) return false;
  var valores = aba.getRange(2, 1, ultima - 1, 4).getValues(); // col A..D
  var n = nome.toLowerCase().trim();
  for (var i = 0; i < valores.length; i++) {
    var rNome = String(valores[i][0]).toLowerCase().trim();
    var rData = _data(valores[i][3]);
    if (rNome === n && rData === dProc) return true;
  }
  return false;
}

function _existeDuplicataHMC(aba, nome, atendimento) {
  var ultima = aba.getLastRow();
  if (ultima < 2) return false;
  var valores = aba.getRange(2, 1, ultima - 1, 3).getValues(); // col A..C: Data, Nome, Atendimento
  var n = nome.toLowerCase().trim();
  var at = String(atendimento).trim();
  for (var i = 0; i < valores.length; i++) {
    var rNome  = String(valores[i][1]).toLowerCase().trim();
    var rAtend = String(valores[i][2]).trim();
    if (rNome === n && rAtend === at) return true;
  }
  return false;
}

/* =========================================================================
   3) RELATÓRIO MENSAL — roteia por hospital
   req.mes chega no formato "AAAA-MM" (é o que o <input type="month"> do
   app entrega). HMS devolve contagens + valores; HMC devolve a lista de
   registros do mês (o app monta a tabela).
   ========================================================================= */
function gerarRelatorio(req) {
  var mes = _str(req.mes);
  if (!/^\d{4}-\d{2}$/.test(mes)) return { ok: false, erro: "Mês inválido." };
  return (_hospital(req) === "HMC") ? _relatorioHMC(mes) : _relatorioHMS(mes);
}

function _relatorioHMS(mesIso) {
  var mesBR = _mesAnoBR(mesIso); // "MM/AAAA", para comparar com as datas da planilha
  var ss = SpreadsheetApp.openById(DOC_ID);
  var aba = ss.getSheetByName(ABA_APP);

  var porProcedimento = {};
  var i;
  for (i = 0; i < ORDEM_PROCEDIMENTOS_HMS.length; i++) {
    porProcedimento[ORDEM_PROCEDIMENTOS_HMS[i]] = { qtd: 0, valor: 0 };
  }

  var totalCirurgias = 0;
  var valorTotal = 0;

  if (aba && aba.getLastRow() > 1) {
    // Colunas A..F: Nome | Nascimento | Procedimento | Data Procedimento | Intercorrências | Honorário
    var valores = aba.getRange(2, 1, aba.getLastRow() - 1, 6).getValues();
    for (i = 0; i < valores.length; i++) {
      var nome = valores[i][0];
      var proc = valores[i][2];
      var dataProc = valores[i][3];
      var honorario = valores[i][5];

      if (!nome && !proc) continue;               // linha em branco
      if (_mesAnoDe(dataProc) !== mesBR) continue; // fora do mês pedido (ou sem data)

      totalCirurgias++;
      var cat = _categoriaProcedimentoHMS(proc);
      var v = _numeroDeValor(honorario) || 0;
      porProcedimento[cat].qtd += 1;
      porProcedimento[cat].valor += v;
      valorTotal += v;
    }
  }

  var hernioplastias =
    porProcedimento["Hernioplastia inguinal"].qtd +
    porProcedimento["Hernioplastia umbilical"].qtd +
    porProcedimento["Hernioplastia incisional"].qtd +
    porProcedimento["Hernioplastia epigástrica"].qtd;

  var lista = [];
  for (i = 0; i < ORDEM_PROCEDIMENTOS_HMS.length; i++) {
    var nomeCat = ORDEM_PROCEDIMENTOS_HMS[i];
    lista.push({
      nome: nomeCat,
      qtd: porProcedimento[nomeCat].qtd,
      valor: _formatarValor(porProcedimento[nomeCat].valor) || "R$ 0,00"
    });
  }

  return {
    ok: true,
    mes: mesBR,
    totalCirurgias: totalCirurgias,
    colecistectomiasAbertas: porProcedimento["Colecistectomia convencional"].qtd,
    hernioplastias: hernioplastias,
    atendimentosAmbulatorio: _contarAmbulatorio(mesBR),
    porProcedimento: lista,
    valorTotal: _formatarValor(valorTotal) || "R$ 0,00"
  };
}

function _relatorioHMC(mesIso) {
  var mesBR = _mesAnoBR(mesIso);
  var ss = SpreadsheetApp.openById(DOC_ID);
  var aba = ss.getSheetByName(ABA_HMC);
  var registros = [];

  if (aba && aba.getLastRow() > 1) {
    // Colunas A..G: Data | Nome | Nº Atendimento | Procedimento | Chefe | Convênio | Apartamento
    var valores = aba.getRange(2, 1, aba.getLastRow() - 1, 7).getValues();
    for (var i = 0; i < valores.length; i++) {
      var data = valores[i][0];
      var nome = valores[i][1];
      if (!nome && !data) continue;
      if (_mesAnoDe(data) !== mesBR) continue;
      registros.push({
        data: _data(data),
        nome_completo: _str(nome),
        numero_atendimento: _str(valores[i][2]),
        procedimento_realizado: _str(valores[i][3]),
        chefe: _str(valores[i][4]),
        convenio: _str(valores[i][5]),
        apartamento: _str(valores[i][6])
      });
    }
    registros.sort(function (a, b) { return _paraOrdenacao(a.data) - _paraOrdenacao(b.data); });
  }

  return { ok: true, mes: mesBR, registros: registros };
}

/* Soma a coluna "Número de Pacientes" da aba AMBU (mantida manualmente por
   você, fora do app) para as linhas cuja Data cai no mês pedido. Se a aba
   ainda não existir, devolve 0 em vez de dar erro. */
function _contarAmbulatorio(mesBR) {
  var ss = SpreadsheetApp.openById(DOC_ID);
  var aba = ss.getSheetByName(ABA_AMBU);
  if (!aba || aba.getLastRow() < 2) return 0;

  var valores = aba.getRange(2, 1, aba.getLastRow() - 1, 2).getValues(); // Número de Pacientes | Data
  var total = 0;
  for (var i = 0; i < valores.length; i++) {
    var qtd = valores[i][0];
    var data = valores[i][1];
    if (data === "" || data === undefined) continue;
    if (_mesAnoDe(data) !== mesBR) continue;
    total += Number(qtd) || 0;
  }
  return total;
}

/* Classifica o texto do procedimento numa das 6 categorias do dropdown do
   HMS. Entradas antigas digitadas livremente (maiúsculas, sem "convencional",
   com "aberta" etc.) são reconhecidas por palavra-chave; o que não bater com
   nada vira "Outros" — inclui explicitamente colecistectomia "VLP"
   (videolaparoscópica), que é um procedimento diferente de "aberta". */
function _categoriaProcedimentoHMS(texto) {
  var t = _semAcento(String(texto || "").toLowerCase());
  var ehVlp = t.indexOf("vlp") > -1 || t.indexOf("laparosc") > -1;

  if (t.indexOf("colecistectomia") > -1 && !ehVlp) return "Colecistectomia convencional";
  if (t.indexOf("hernioplastia") > -1) {
    if (t.indexOf("inguinal") > -1) return "Hernioplastia inguinal";
    if (t.indexOf("umbilical") > -1) return "Hernioplastia umbilical";
    if (t.indexOf("incisional") > -1) return "Hernioplastia incisional";
    if (t.indexOf("epigastrica") > -1) return "Hernioplastia epigástrica";
  }
  return "Outros";
}

/* =========================================================================
   4) CONFIGURAÇÃO INICIAL DA PLANILHA  (rodar UMA vez cada, manualmente)
   ========================================================================= */

/* ---- HMS: migração NÃO-DESTRUTIVA da aba original (histórico) ----
   Lê a aba original "CIRURGIAS" sem alterá-la (ela vira backup) e cria uma
   aba NOVA e limpa "CIRURGIAS APP" com as colunas e os registros migrados.
   Antes:  Nome Paciente | Procedimento Realizado | Data
   Depois: Nome Completo | Data de Nascimento | Procedimento Realizado |
           Data do Procedimento | Intercorrências | Honorário
   Esta função já foi usada — veja a trava de segurança logo abaixo.
   ========================================================================= */
function configurarPlanilha() {
  var ss = SpreadsheetApp.openById(DOC_ID);
  var origem = ss.getSheetByName(ABA_ORIGEM);

  // Trava de segurança: esta função só existe para a migração ÚNICA da aba
  // antiga "CIRURGIAS" para a "CIRURGIAS APP". Se a aba "CIRURGIAS" não
  // existe mais (sinal de que a migração já foi feita), NÃO seguimos em
  // frente — rodar de novo apagaria os registros reais que já estão em
  // "CIRURGIAS APP" hoje (incluindo os Honorários lançados manualmente),
  // sem ter de onde recuperá-los.
  if (!origem) {
    var aviso = "Esta função já foi usada antes: a aba \"" + ABA_ORIGEM + "\" não existe " +
      "mais na planilha (normal, ela só existia até a primeira migração). Por segurança, " +
      "esta função NÃO faz nada agora — rodar de novo apagaria os registros reais que já " +
      "estão em \"" + ABA_APP + "\". Se precisar ajustar a aba \"" + ABA_APP + "\", edite-a " +
      "diretamente na planilha.";
    Logger.log(aviso);
    return aviso;
  }

  // Lê tudo da aba original — somente LEITURA, não modifica nada nela.
  var ultLin = origem.getLastRow();
  var ultCol = origem.getLastColumn();
  var antigo = ultLin > 0 ? origem.getRange(1, 1, ultLin, Math.max(ultCol, 1)).getValues() : [];

  // Detecta se a primeira linha é cabeçalho antigo (contém "nome")
  var temCabecalhoAntigo = antigo.length &&
      String(antigo[0][0]).toLowerCase().indexOf("nome") >= 0;

  // Monta as linhas migradas (5 colunas)
  var novo = [CABECALHOS.slice()];
  var inicio = temCabecalhoAntigo ? 1 : 0;
  for (var i = inicio; i < antigo.length; i++) {
    var linha = antigo[i];
    var nome = linha[0] !== undefined ? linha[0] : "";
    var proc = linha[1] !== undefined ? linha[1] : "";
    var data = linha[2] !== undefined ? linha[2] : "";
    if (String(nome).trim() === "" && String(proc).trim() === "" && String(data).trim() === "") {
      continue; // pula linhas vazias
    }
    novo.push([
      nome,            // Nome Completo  (era "Nome Paciente")
      "",              // Data de Nascimento (em branco nos antigos)
      proc,            // Procedimento Realizado
      _data(data),     // Data do Procedimento (era "Data")
      "",              // Intercorrências (em branco nos antigos)
      ""               // Honorário (em branco nos antigos)
    ]);
  }

  // Cria (ou recria) a aba nova e LIMPA usada pelo app — sem objeto "Tabela".
  var app = ss.getSheetByName(ABA_APP);
  if (app) app.clear(); else app = ss.insertSheet(ABA_APP);

  app.getRange(1, 1, novo.length, CABECALHOS.length).setValues(novo);
  app.getRange(1, 1, 1, CABECALHOS.length)
     .setFontWeight("bold").setBackground("#0b6e6e").setFontColor("#ffffff");
  app.setFrozenRows(1);
  app.autoResizeColumns(1, CABECALHOS.length);

  var msg = "Pronto! Criei a aba \"" + ABA_APP + "\" com " + (novo.length - 1) +
            " registro(s) migrado(s). A aba original \"" + ABA_ORIGEM + "\" foi mantida intacta como backup.";
  Logger.log(msg);
  return msg;
}

/* ---- HMC: cria a aba nova do zero, já com o cabeçalho formatado ----
   Não existe aba antiga do HMC para migrar — esta função só garante que a
   aba "HMC" já apareça pronta na planilha antes do primeiro registro.
   (Se você pular esta etapa, a aba é criada automaticamente no primeiro
   "Salvar registro" feito no app — mas sem a formatação do cabeçalho.)
   ========================================================================= */
function configurarAbaHMC() {
  var ss = SpreadsheetApp.openById(DOC_ID);
  var aba = ss.getSheetByName(ABA_HMC);
  if (!aba) aba = ss.insertSheet(ABA_HMC);

  if (aba.getLastRow() === 0) {
    aba.getRange(1, 1, 1, CABECALHOS_HMC.length).setValues([CABECALHOS_HMC])
       .setFontWeight("bold").setBackground("#0b6e6e").setFontColor("#ffffff");
    aba.setFrozenRows(1);
  }
  aba.autoResizeColumns(1, CABECALHOS_HMC.length);

  var msg = "Pronto! A aba \"" + ABA_HMC + "\" está criada com as colunas: " +
            CABECALHOS_HMC.join(" | ");
  Logger.log(msg);
  return msg;
}

/* =========================================================================
   AUXILIARES
   ========================================================================= */
function _aba(hospital) {
  var ss = SpreadsheetApp.openById(DOC_ID);
  var nomeAba     = (hospital === "HMC") ? ABA_HMC : ABA_APP;
  var cabecalhos  = (hospital === "HMC") ? CABECALHOS_HMC : CABECALHOS;
  var aba = ss.getSheetByName(nomeAba);
  if (!aba) {
    // Cria a aba já com cabeçalho, caso ainda não exista
    aba = ss.insertSheet(nomeAba);
    aba.getRange(1, 1, 1, cabecalhos.length).setValues([cabecalhos])
       .setFontWeight("bold").setBackground("#0b6e6e").setFontColor("#ffffff");
    aba.setFrozenRows(1);
  }
  return aba;
}

function _garantirCabecalhos(aba, hospital) {
  if (aba.getLastRow() === 0) {
    var cabecalhos = (hospital === "HMC") ? CABECALHOS_HMC : CABECALHOS;
    aba.getRange(1, 1, 1, cabecalhos.length).setValues([cabecalhos])
       .setFontWeight("bold").setBackground("#0b6e6e").setFontColor("#ffffff");
    aba.setFrozenRows(1);
  }
}

function _str(v) {
  return (v === undefined || v === null) ? "" : String(v).trim();
}

/* Normaliza datas para DD/MM/AAAA, aceitando objetos Date e textos diversos */
function _data(v) {
  if (v === undefined || v === null || v === "") return "";
  if (Object.prototype.toString.call(v) === "[object Date]") {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), "dd/MM/yyyy");
  }
  var s = String(v).trim();
  var m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/.exec(s);
  if (m) {
    var d = ("0" + m[1]).slice(-2);
    var mes = ("0" + m[2]).slice(-2);
    var a = m[3].length === 2 ? "20" + m[3] : m[3];
    return d + "/" + mes + "/" + a;
  }
  // AAAA-MM-DD
  var iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return iso[3] + "/" + iso[2] + "/" + iso[1];
  return s;
}

/* Remove cercas de markdown que a IA às vezes adiciona */
function _limparJson(t) {
  return String(t).replace(/```json/gi, "").replace(/```/g, "").trim();
}

/* ---------- Auxiliares do relatório mensal ---------- */

/* "AAAA-MM" (do <input type="month"> do app) → "MM/AAAA" */
function _mesAnoBR(mesIso) {
  var p = mesIso.split("-");
  return p[1] + "/" + p[0];
}

/* Dado um valor de data de qualquer coluna (texto ou Date), devolve "MM/AAAA".
   Reaproveita _data() para normalizar, então some vazio se não der pra ler. */
function _mesAnoDe(v) {
  var d = _data(v);
  var m = /^\d{2}\/(\d{2}\/\d{4})$/.exec(d);
  return m ? m[1] : "";
}

/* Converte "DD/MM/AAAA" numa data comparável, para ordenar a tabela do HMC */
function _paraOrdenacao(dataBR) {
  var m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(dataBR);
  if (!m) return 0;
  return new Date(+m[3], +m[2] - 1, +m[1]).getTime();
}

/* Remove acentos dos caracteres usados nos nomes de procedimento em
   português, para comparação por palavra-chave sem depender de maiúsculas
   ou acentuação exatas. */
function _semAcento(s) {
  var mapa = { "á": "a", "à": "a", "â": "a", "ã": "a", "é": "e", "ê": "e",
               "í": "i", "ó": "o", "ô": "o", "õ": "o", "ú": "u", "ç": "c" };
  return s.replace(/[áàâãéêíóôõúç]/g, function (c) { return mapa[c]; });
}

/* Interpreta um valor em dinheiro vindo do app (texto digitado, ex.:
   "450,00") ou já lançado na planilha (texto "R$ 450,00" ou número puro,
   se a célula estiver formatada como moeda). Devolve null se não der pra
   interpretar. */
function _numeroDeValor(v) {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "number") return v;
  var s = String(v).trim().replace(/^R\$\s*/, "");
  if (!s) return null;
  if (s.indexOf(",") > -1) {
    s = s.replace(/\./g, "").replace(",", "."); // vírgula = decimal, ponto = milhar
  }
  var n = parseFloat(s);
  return isNaN(n) ? null : n;
}

/* Formata um número para o padrão brasileiro "R$ 1.234,56". Devolve "" se
   o valor de entrada estiver vazio ou não for interpretável. */
function _formatarValor(v) {
  var n = _numeroDeValor(v);
  if (n === null) return "";
  var partes = n.toFixed(2).split(".");
  var inteiro = partes[0].replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return "R$ " + inteiro + "," + partes[1];
}
