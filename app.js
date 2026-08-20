/* =========================================================================
   Cirurgias HSM — lógica do app (PWA)
   Suporta DOIS hospitais (HMS e HMC), cada um com sua aba na planilha e seu
   próprio conjunto de campos. O hospital é escolhido na Tela 1, antes da
   foto, porque a extração por IA já depende de qual hospital está ativo.

   Conversa com um único endpoint (Apps Script Web App) que:
     • action "extract" → lê a etiqueta com IA (Gemini) e devolve JSON
     • action "save"    → confere duplicata e grava a linha na aba correta
   ========================================================================= */

"use strict";

/* ---------- Estado e referências ---------- */
const CHAVE_ENDPOINT  = "cirurgias_hsm_endpoint";
const CHAVE_HOSPITAL  = "cirurgias_hospital_atual";
let dadosExtraidos = { prontuario: "" };   // guarda o prontuário lido (só HMS) para conferência
let registroPendente = null;               // dados aguardando confirmação de duplicata
let tipoPendente = "cirurgia";             // "cirurgia" ou "ambulatorio" — de quem é o registro pendente

// Valores sugeridos por procedimento (HMS) — só preenche o campo "Valor" se
// ele ainda estiver vazio; o cirurgião pode sempre editar.
const VALORES_PADRAO_HMS = {
  "Hernioplastia inguinal":    "220,00",
  "Hernioplastia umbilical":   "220,00",
  "Hernioplastia incisional":  "220,00",
  "Hernioplastia epigástrica": "220,00",
  "Colecistectomia convencional": "450,00",
};

const el = (id) => document.getElementById(id);

const telas = {
  captura:     el("tela-captura"),
  loading:     el("tela-loading"),
  form:        el("tela-form"),
  ambulatorio: el("tela-ambulatorio"),
  sucesso:     el("tela-sucesso"),
  relatorio:   el("tela-relatorio"),
};

function mostrarTela(nome) {
  Object.values(telas).forEach((t) => t.classList.remove("ativa"));
  telas[nome].classList.add("ativa");
  window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
}

/* ---------- Toast ---------- */
let toastTimer;
function toast(msg) {
  const t = el("toast");
  t.textContent = msg;
  t.classList.remove("oculto");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("oculto"), 3200);
}

/* ---------- Endpoint (URL do Apps Script) ---------- */
function getEndpoint() {
  return localStorage.getItem(CHAVE_ENDPOINT) || "";
}
function setEndpoint(url) {
  localStorage.setItem(CHAVE_ENDPOINT, url.trim());
}

/* =========================================================================
   Hospital ativo (HMS ou HMC)
   Define: (1) qual bloco de campos aparece na Tela 2, (2) o prompt de
   extração usado pela IA, (3) em qual aba da planilha o registro é gravado.
   ========================================================================= */
function getHospital() {
  return localStorage.getItem(CHAVE_HOSPITAL) || "HMS";
}
function setHospital(h) {
  localStorage.setItem(CHAVE_HOSPITAL, h);
  atualizarSeletorHospital();
}

function atualizarSeletorHospital() {
  const h = getHospital();
  document.querySelectorAll(".hospital-opcao").forEach((btn) => {
    btn.classList.toggle("ativo", btn.dataset.hospital === h);
  });
  el("campos-hms").classList.toggle("oculto", h !== "HMS");
  el("campos-hmc").classList.toggle("oculto", h !== "HMC");
  el("hospitalBadge").textContent = h;
  // O registro de ambulatório existe apenas no HMS (aba "AMBU" da planilha)
  el("btnAmbulatorio").classList.toggle("oculto", h !== "HMS");
}

document.querySelectorAll(".hospital-opcao").forEach((btn) => {
  btn.addEventListener("click", () => setHospital(btn.dataset.hospital));
});

atualizarSeletorHospital(); // aplica o estado salvo (ou HMS por padrão) já na abertura

/* ---------- Datas: máscara e validação ---------- */
function aplicarMascaraData(input) {
  let v = input.value.replace(/\D/g, "").slice(0, 8);
  if (v.length >= 5) v = v.slice(0, 2) + "/" + v.slice(2, 4) + "/" + v.slice(4);
  else if (v.length >= 3) v = v.slice(0, 2) + "/" + v.slice(2);
  input.value = v;
}

function dataValida(str) {
  if (!str) return false;
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(str.trim());
  if (!m) return false;
  const d = +m[1], mes = +m[2], a = +m[3];
  if (mes < 1 || mes > 12 || d < 1 || d > 31 || a < 1900 || a > 2100) return false;
  const dt = new Date(a, mes - 1, d);
  return dt.getDate() === d && dt.getMonth() === mes - 1 && dt.getFullYear() === a;
}

// Aceita vazio (campo opcional) ou um número com até 2 casas decimais,
// separadas por vírgula ou ponto (ex.: "450", "450,00", "450.00").
function valorValido(str) {
  if (!str) return true;
  return /^\d+([.,]\d{1,2})?$/.test(str.trim());
}

/* =========================================================================
   TELA 1 — Captura da foto
   ========================================================================= */
el("inputFoto").addEventListener("change", async (e) => {
  const arquivo = e.target.files && e.target.files[0];
  e.target.value = ""; // permite reenviar a mesma foto depois
  if (!arquivo) return;

  if (!getEndpoint()) {
    toast("Configure a URL do app primeiro (ícone ⚙️).");
    abrirConfig();
    return;
  }

  mostrarTela("loading");
  try {
    const base64 = await arquivoParaBase64(arquivo);   // só o conteúdo, sem prefixo
    const resp = await chamarEndpoint({
      action: "extract",
      hospital: getHospital(),
      mimeType: arquivo.type || "image/jpeg",
      imageBase64: base64,
    });
    // a foto não é guardada: a variável sai de escopo após esta função

    if (resp && resp.ok === false) {
      // O servidor respondeu, mas a IA falhou: mostra a causa real.
      preencherFormulario({});
      mostrarTela("form");
      mostrarAvisoErro("A IA não conseguiu ler a etiqueta: " +
        (resp.erro || "erro desconhecido") + ". Confira a configuração e preencha manualmente.");
    } else {
      preencherFormulario(resp || {});
      mostrarTela("form");
    }
  } catch (err) {
    console.error(err);
    preencherFormulario({});
    mostrarTela("form");
    mostrarAvisoErro("Falha de conexão com o servidor (" + (err.message || err) +
      "). Verifique a internet e a URL configurada (⚙️). Preencha manualmente por enquanto.");
  }
});

/* Mostra um aviso vermelho no topo do formulário */
function mostrarAvisoErro(msg) {
  const aviso = el("aviso-campos");
  aviso.textContent = msg;
  aviso.classList.remove("oculto", "aviso-atencao");
  aviso.classList.add("aviso-erro");
}

el("btnManual").addEventListener("click", () => {
  preencherFormulario({});
  mostrarTela("form");
});

function arquivoParaBase64(arquivo) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(arquivo);
  });
}

/* =========================================================================
   TELA 2 — Conferência / formulário
   Roteia para o preenchimento certo conforme o hospital ativo.
   ========================================================================= */
function preencherFormulario(d) {
  atualizarSeletorHospital(); // garante que o bloco de campos certo está visível
  if (getHospital() === "HMC") preencherFormularioHMC(d);
  else preencherFormularioHMS(d);

  document.querySelectorAll(".invalido").forEach((i) => i.classList.remove("invalido"));
}

function preencherFormularioHMS(d) {
  dadosExtraidos = { prontuario: d.prontuario || "" };

  el("nome").value          = d.nome_completo || "";
  el("nascimento").value    = d.data_nascimento || "";
  el("procedimento").value  = "";
  el("procedimentoOutro").value = "";
  el("campo-procedimento-outro").classList.add("oculto");
  el("valorProcedimento").value = "";
  el("dataProcedimento").value = d.data_admissao || "";
  el("intercorrencias").value  = "";

  // Prontuário (discreto, só para conferência)
  if (d.prontuario) {
    el("prontuarioValor").textContent = d.prontuario;
    el("prontuarioInfo").classList.remove("oculto");
  } else {
    el("prontuarioInfo").classList.add("oculto");
  }

  // Avisa quais campos não foram lidos
  const faltando = [];
  if (!d.nome_completo)  faltando.push("nome");
  if (!d.data_nascimento) faltando.push("data de nascimento");
  if (!d.data_admissao)   faltando.push("data do procedimento");
  const aviso = el("aviso-campos");
  if (faltando.length && (d.nome_completo || d.data_nascimento || d.data_admissao || d.prontuario)) {
    aviso.textContent = "Atenção: não consegui ler " + faltando.join(", ") +
      ". Confira e preencha manualmente.";
    aviso.classList.remove("oculto", "aviso-erro");
    aviso.classList.add("aviso-atencao");
  } else {
    aviso.classList.add("oculto");
  }
}

function preencherFormularioHMC(d) {
  el("hmcNome").value        = d.nome_completo || "";
  el("hmcData").value        = d.data || "";
  el("hmcAtendimento").value = d.numero_atendimento || "";
  el("hmcConvenio").value    = d.convenio || "";

  el("hmcProcedimento").value = "";
  el("hmcProcedimentoOutro").value = "";
  el("campo-hmc-procedimento-outro").classList.add("oculto");

  el("hmcChefe").value = "";
  el("hmcChefeOutro").value = "";
  el("campo-hmc-chefe-outro").classList.add("oculto");

  el("hmcApartamento").value = ""; // nunca vem pré-selecionado — o cirurgião escolhe

  // Avisa quais campos não foram lidos
  const faltando = [];
  if (!d.nome_completo)     faltando.push("nome");
  if (!d.data)               faltando.push("data");
  if (!d.numero_atendimento) faltando.push("nº de atendimento");
  const aviso = el("aviso-campos");
  if (faltando.length && (d.nome_completo || d.data || d.numero_atendimento || d.convenio)) {
    aviso.textContent = "Atenção: não consegui ler " + faltando.join(", ") +
      ". Confira e preencha manualmente.";
    aviso.classList.remove("oculto", "aviso-erro");
    aviso.classList.add("aviso-atencao");
  } else {
    aviso.classList.add("oculto");
  }
}

// Máscara nas datas (campos dos dois hospitais)
["nascimento", "dataProcedimento", "hmcData"].forEach((id) => {
  el(id).addEventListener("input", (e) => aplicarMascaraData(e.target));
});

// Dropdown "Outra…" — procedimento HMS (também sugere o valor do procedimento)
el("procedimento").addEventListener("change", (e) => {
  const outro = el("campo-procedimento-outro");
  if (e.target.value === "Outra") {
    outro.classList.remove("oculto");
    el("procedimentoOutro").focus();
  } else {
    outro.classList.add("oculto");
  }

  const campoValor = el("valorProcedimento");
  if (!campoValor.value.trim() && VALORES_PADRAO_HMS[e.target.value]) {
    campoValor.value = VALORES_PADRAO_HMS[e.target.value];
  }
});

// Dropdown "Outros…" — procedimento HMC
el("hmcProcedimento").addEventListener("change", (e) => {
  const outro = el("campo-hmc-procedimento-outro");
  if (e.target.value === "Outros") {
    outro.classList.remove("oculto");
    el("hmcProcedimentoOutro").focus();
  } else {
    outro.classList.add("oculto");
  }
});

// Dropdown "Outro…" — chefe HMC
el("hmcChefe").addEventListener("change", (e) => {
  const outro = el("campo-hmc-chefe-outro");
  if (e.target.value === "Outro") {
    outro.classList.remove("oculto");
    el("hmcChefeOutro").focus();
  } else {
    outro.classList.add("oculto");
  }
});

el("btnVoltar").addEventListener("click", () => mostrarTela("captura"));

/* ---------- Validação e envio ---------- */
el("formCirurgia").addEventListener("submit", (e) => {
  e.preventDefault();
  document.querySelectorAll(".invalido").forEach((i) => i.classList.remove("invalido"));

  registroPendente = (getHospital() === "HMC") ? coletarHMC() : coletarHMS();
  if (!registroPendente) return; // erros já reportados por toast

  tipoPendente = "cirurgia";
  enviarRegistro(false);
});

function marcarInvalido(id) { el(id).classList.add("invalido"); }

function coletarHMS() {
  const nome = el("nome").value.trim();
  let procedimento = el("procedimento").value;
  const procedimentoOutro = el("procedimentoOutro").value.trim();
  const valor = el("valorProcedimento").value.trim();
  const dataProc = el("dataProcedimento").value.trim();
  const nascimento = el("nascimento").value.trim();

  const erros = [];
  if (!nome) { erros.push("nome"); marcarInvalido("nome"); }

  if (!procedimento) { erros.push("procedimento"); marcarInvalido("procedimento"); }
  if (procedimento === "Outra") {
    if (!procedimentoOutro) { erros.push("procedimento"); marcarInvalido("procedimentoOutro"); }
    else procedimento = procedimentoOutro;
  }

  if (!dataValida(dataProc)) { erros.push("data do procedimento"); marcarInvalido("dataProcedimento"); }
  if (nascimento && !dataValida(nascimento)) { erros.push("data de nascimento"); marcarInvalido("nascimento"); }
  if (!valorValido(valor)) { erros.push("valor do procedimento"); marcarInvalido("valorProcedimento"); }

  if (erros.length) {
    toast("Verifique: " + [...new Set(erros)].join(", ") + ".");
    return null;
  }

  return {
    hospital: "HMS",
    nome_completo: nome,
    data_nascimento: nascimento,
    procedimento_realizado: procedimento,
    valor: valor,
    data_procedimento: dataProc,
    intercorrencias: el("intercorrencias").value.trim(),
  };
}

function coletarHMC() {
  const nome = el("hmcNome").value.trim();
  const data = el("hmcData").value.trim();
  const atendimento = el("hmcAtendimento").value.trim();
  let procedimento = el("hmcProcedimento").value;
  const procedimentoOutro = el("hmcProcedimentoOutro").value.trim();
  let chefe = el("hmcChefe").value;
  const chefeOutro = el("hmcChefeOutro").value.trim();
  const apartamento = el("hmcApartamento").value;

  const erros = [];
  if (!nome) { erros.push("nome"); marcarInvalido("hmcNome"); }
  if (!dataValida(data)) { erros.push("data"); marcarInvalido("hmcData"); }
  if (!atendimento) { erros.push("nº de atendimento"); marcarInvalido("hmcAtendimento"); }

  if (!procedimento) { erros.push("procedimento"); marcarInvalido("hmcProcedimento"); }
  if (procedimento === "Outros") {
    if (!procedimentoOutro) { erros.push("procedimento"); marcarInvalido("hmcProcedimentoOutro"); }
    else procedimento = procedimentoOutro;
  }

  if (!chefe) { erros.push("chefe"); marcarInvalido("hmcChefe"); }
  if (chefe === "Outro") {
    if (!chefeOutro) { erros.push("chefe"); marcarInvalido("hmcChefeOutro"); }
    else chefe = chefeOutro;
  }

  if (!apartamento) { erros.push("apartamento"); marcarInvalido("hmcApartamento"); }

  if (erros.length) {
    toast("Verifique: " + [...new Set(erros)].join(", ") + ".");
    return null;
  }

  return {
    hospital: "HMC",
    nome_completo: nome,
    data: data,
    numero_atendimento: atendimento,
    procedimento_realizado: procedimento,
    chefe: chefe,
    convenio: el("hmcConvenio").value.trim(),
    apartamento: apartamento,
  };
}

async function enviarRegistro(forcar) {
  const btn = el("btnSalvar");
  btn.disabled = true;
  btn.textContent = "Salvando…";
  try {
    const resp = await chamarEndpoint({
      action: "save",
      forcar: !!forcar,
      ...registroPendente,
    });

    if (resp && resp.duplicate && !forcar) {
      abrirModalDuplicata(resp.mensagem);
      return;
    }
    if (resp && resp.ok) {
      mostrarSucesso(registroPendente);
    } else {
      mostrarAvisoErro((resp && resp.erro) || "Não foi possível salvar. Tente novamente.");
      toast("Não foi possível salvar. Veja o aviso acima.");
    }
  } catch (err) {
    console.error(err);
    mostrarAvisoErro("Falha ao salvar: " + (err.message || "verifique a internet e tente de novo."));
    toast("Não foi possível salvar. Veja o aviso acima.");
  } finally {
    btn.disabled = false;
    btn.textContent = "Salvar registro";
  }
}

/* ---------- Modal de duplicata ---------- */
function abrirModalDuplicata(msg) {
  el("modalDuplicataTexto").textContent = msg ||
    "Já existe um registro semelhante. Deseja salvar mesmo assim?";
  el("modalDuplicata").classList.remove("oculto");
}
el("btnDupCancelar").addEventListener("click", () => el("modalDuplicata").classList.add("oculto"));
el("btnDupConfirmar").addEventListener("click", () => {
  el("modalDuplicata").classList.add("oculto");
  // O mesmo modal atende os dois fluxos (cirurgia e ambulatório)
  if (tipoPendente === "ambulatorio") enviarAmbulatorio(true);
  else enviarRegistro(true);
});

/* =========================================================================
   TELA AMBULATÓRIO — atendimentos do dia (somente HMS)
   Grava na aba "AMBU" da planilha (Número de Pacientes | Data), a mesma que
   o relatório mensal já lê para o card "Atendimentos no ambulatório".
   ========================================================================= */
function dataDeHojeBR() {
  const hoje = new Date();
  const dd = String(hoje.getDate()).padStart(2, "0");
  const mm = String(hoje.getMonth() + 1).padStart(2, "0");
  return dd + "/" + mm + "/" + hoje.getFullYear();
}

function abrirAmbulatorio() {
  if (!getEndpoint()) {
    toast("Configure a URL do app primeiro (ícone ⚙️).");
    abrirConfig();
    return;
  }
  el("ambuData").value = dataDeHojeBR();   // data de hoje já pré-selecionada
  el("ambuQuantidade").value = "";
  el("ambuAviso").classList.add("oculto");
  document.querySelectorAll(".invalido").forEach((i) => i.classList.remove("invalido"));
  mostrarTela("ambulatorio");
  el("ambuQuantidade").focus();
}

el("btnAmbulatorio").addEventListener("click", abrirAmbulatorio);
el("btnAmbuVoltar").addEventListener("click", () => mostrarTela("captura"));
el("ambuData").addEventListener("input", (e) => aplicarMascaraData(e.target));

el("formAmbulatorio").addEventListener("submit", (e) => {
  e.preventDefault();
  document.querySelectorAll(".invalido").forEach((i) => i.classList.remove("invalido"));
  el("ambuAviso").classList.add("oculto");

  const data = el("ambuData").value.trim();
  const qtdTexto = el("ambuQuantidade").value.trim();
  const qtd = Number(qtdTexto);

  const erros = [];
  if (!dataValida(data)) { erros.push("data"); el("ambuData").classList.add("invalido"); }
  if (!qtdTexto || !Number.isInteger(qtd) || qtd < 1) {
    erros.push("número de atendimentos");
    el("ambuQuantidade").classList.add("invalido");
  }
  if (erros.length) {
    toast("Verifique: " + erros.join(", ") + ".");
    return;
  }

  registroPendente = { hospital: "HMS", data: data, quantidade: qtd };
  tipoPendente = "ambulatorio";
  enviarAmbulatorio(false);
});

async function enviarAmbulatorio(forcar) {
  const btn = el("btnAmbuSalvar");
  btn.disabled = true;
  btn.textContent = "Enviando…";
  try {
    const resp = await chamarEndpoint({
      action: "saveAmbu",
      forcar: !!forcar,
      ...registroPendente,
    });

    if (resp && resp.duplicate && !forcar) {
      abrirModalDuplicata(resp.mensagem);
      return;
    }
    if (resp && resp.ok) {
      mostrarSucessoAmbulatorio(registroPendente);
    } else {
      mostrarAvisoAmbu((resp && resp.erro) || "Não foi possível salvar. Tente novamente.");
    }
  } catch (err) {
    console.error(err);
    mostrarAvisoAmbu("Falha ao salvar: " + (err.message || "verifique a internet e tente de novo."));
  } finally {
    btn.disabled = false;
    btn.textContent = "Enviar";
  }
}

function mostrarAvisoAmbu(msg) {
  const aviso = el("ambuAviso");
  aviso.textContent = msg;
  aviso.classList.remove("oculto");
  toast("Não foi possível salvar. Veja o aviso acima.");
}

function mostrarSucessoAmbulatorio(r) {
  el("sucessoResumo").textContent =
    "Ambulatório — " + r.quantidade + " atendimento(s) em " + r.data;
  el("btnNova").textContent = "Voltar ao início";
  mostrarTela("sucesso");
}

/* =========================================================================
   TELA 3 — Sucesso
   ========================================================================= */
function mostrarSucesso(r) {
  const data = r.hospital === "HMC" ? r.data : r.data_procedimento;
  let resumo = r.nome_completo + " — " + r.procedimento_realizado + " (" + data + ")";
  if (r.hospital === "HMC") resumo += " — Atendimento " + r.numero_atendimento;
  el("sucessoResumo").textContent = resumo;
  el("btnNova").textContent = "Registrar nova cirurgia";
  mostrarTela("sucesso");
}
el("btnNova").addEventListener("click", () => {
  registroPendente = null;
  tipoPendente = "cirurgia";
  mostrarTela("captura");
});

/* =========================================================================
   TELA 4 — Relatório mensal
   Mostra um relatório diferente conforme o hospital ativo (escolhido na
   Tela 1): cards de resumo + valores por procedimento no HMS, tabela com
   os registros do mês no HMC.
   ========================================================================= */
function abrirRelatorio() {
  el("relatorioHospitalBadge").textContent = getHospital();
  el("relatorioErro").classList.add("oculto");
  el("relatorioHMS").classList.add("oculto");
  el("relatorioHMC").classList.add("oculto");

  if (!el("relatorioMes").value) {
    const hoje = new Date();
    const mm = String(hoje.getMonth() + 1).padStart(2, "0");
    el("relatorioMes").value = hoje.getFullYear() + "-" + mm;
  }

  mostrarTela("relatorio");
  buscarRelatorio();
}
el("btnRelatorio").addEventListener("click", abrirRelatorio);
el("btnRelatorioVoltar").addEventListener("click", () => mostrarTela("captura"));
el("btnBuscarRelatorio").addEventListener("click", buscarRelatorio);

async function buscarRelatorio() {
  const mes = el("relatorioMes").value; // "AAAA-MM"
  if (!mes) { toast("Escolha um mês."); return; }
  if (!getEndpoint()) { toast("Configure a URL do app primeiro (⚙️)."); abrirConfig(); return; }

  el("relatorioErro").classList.add("oculto");
  el("relatorioHMS").classList.add("oculto");
  el("relatorioHMC").classList.add("oculto");
  el("relatorioCarregando").classList.remove("oculto");

  try {
    const resp = await chamarEndpoint({ action: "report", hospital: getHospital(), mes });
    el("relatorioCarregando").classList.add("oculto");

    if (!resp || resp.ok === false) {
      el("relatorioErro").textContent = (resp && resp.erro) || "Não foi possível carregar o relatório.";
      el("relatorioErro").classList.remove("oculto");
      return;
    }

    if (getHospital() === "HMC") renderRelatorioHMC(resp);
    else renderRelatorioHMS(resp);
  } catch (err) {
    console.error(err);
    el("relatorioCarregando").classList.add("oculto");
    el("relatorioErro").textContent = "Falha ao buscar o relatório: " + (err.message || err);
    el("relatorioErro").classList.remove("oculto");
  }
}

function renderRelatorioHMS(resp) {
  el("rTotalCirurgias").textContent = resp.totalCirurgias;
  el("rColecistectomias").textContent = resp.colecistectomiasAbertas;
  el("rHernioplastias").textContent = resp.hernioplastias;
  el("rAmbulatorio").textContent = resp.atendimentosAmbulatorio;
  el("rValorTotal").textContent = resp.valorTotal || "R$ 0,00";

  const corpo = el("rTabelaProcedimentos");
  corpo.innerHTML = "";
  (resp.porProcedimento || []).forEach((p) => {
    corpo.appendChild(criarLinhaTabela([p.nome, String(p.qtd), p.valor || "R$ 0,00"]));
  });

  el("relatorioHMS").classList.remove("oculto");
}

function renderRelatorioHMC(resp) {
  const corpo = el("rTabelaHMC");
  corpo.innerHTML = "";
  const registros = resp.registros || [];
  registros.forEach((r) => {
    corpo.appendChild(criarLinhaTabela([
      r.data, r.nome_completo, r.numero_atendimento, r.procedimento_realizado,
      r.chefe, r.convenio, r.apartamento
    ]));
  });
  el("rHmcVazio").classList.toggle("oculto", registros.length > 0);
  el("relatorioHMC").classList.remove("oculto");
}

/* Monta uma linha de tabela a partir de uma lista de textos, usando
   textContent (nunca innerHTML) para não correr risco de interpretar
   caracteres especiais em nomes de pacientes como HTML. */
function criarLinhaTabela(valores) {
  const tr = document.createElement("tr");
  valores.forEach((v) => {
    const td = document.createElement("td");
    td.textContent = v || "";
    tr.appendChild(td);
  });
  return tr;
}

/* =========================================================================
   Comunicação com o Apps Script
   Usa Content-Type text/plain para evitar preflight CORS.
   ========================================================================= */
async function chamarEndpoint(payload) {
  const url = getEndpoint();
  if (!url) throw new Error("Endpoint não configurado");
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(payload),
    redirect: "follow",
  });
  if (!resp.ok) throw new Error("HTTP " + resp.status);

  const texto = await resp.text();
  try {
    return JSON.parse(texto);
  } catch (err) {
    // O servidor respondeu algo que não é JSON. Isso quase sempre significa
    // que o Apps Script não foi reimplantado depois da última atualização
    // do Codigo.gs, ou que a URL configurada (⚙️) não é a mais recente.
    throw new Error(
      "o servidor respondeu algo inesperado (não era o resultado esperado). " +
      "Normalmente isso acontece quando o Apps Script foi editado mas não foi " +
      "reimplantado (Implantar → Gerenciar implantações → editar (lápis) → " +
      "Nova versão → Implantar), ou quando a URL configurada aqui no app não " +
      "é a URL /exec mais recente."
    );
  }
}

/* =========================================================================
   Configuração (URL do endpoint)
   ========================================================================= */
el("btnConfig").addEventListener("click", abrirConfig);
function abrirConfig() {
  el("inputEndpoint").value = getEndpoint();
  el("configErro").classList.add("oculto");
  el("modalConfig").classList.remove("oculto");
}
el("btnConfigCancelar").addEventListener("click", () => el("modalConfig").classList.add("oculto"));
el("btnConfigSalvar").addEventListener("click", () => {
  const url = el("inputEndpoint").value.trim();
  const erro = el("configErro");
  if (!/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec/.test(url)) {
    erro.textContent = "URL inválida. Deve começar com https://script.google.com/macros/s/ e terminar com /exec";
    erro.classList.remove("oculto");
    return;
  }
  setEndpoint(url);
  el("modalConfig").classList.add("oculto");
  toast("Configuração salva.");
});

/* =========================================================================
   Service Worker (instalação / offline do app)
   ========================================================================= */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch((e) => console.warn("SW:", e));
  });
  // Assim que uma versão nova do app assumir o controle da página, recarrega
  // automaticamente — evita o app "ficar preso" numa versão antiga no celular.
  let jaRecarregou = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (jaRecarregou) return;
    jaRecarregou = true;
    window.location.reload();
  });
}

/* Abre a configuração automaticamente no primeiro uso */
if (!getEndpoint()) {
  setTimeout(abrirConfig, 400);
}
