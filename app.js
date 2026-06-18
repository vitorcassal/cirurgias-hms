/* =========================================================================
   Cirurgias HSM — lógica do app (PWA)
   Conversa com um único endpoint (Apps Script Web App) que:
     • action "extract" → lê a etiqueta com IA (Gemini) e devolve JSON
     • action "save"    → confere duplicata e grava a linha na planilha
   ========================================================================= */

"use strict";

/* ---------- Estado e referências ---------- */
const CHAVE_ENDPOINT = "cirurgias_hsm_endpoint";
let dadosExtraidos = { prontuario: "" };   // guarda o prontuário lido para conferência
let registroPendente = null;               // dados aguardando confirmação de duplicata

const el = (id) => document.getElementById(id);

const telas = {
  captura: el("tela-captura"),
  loading: el("tela-loading"),
  form:    el("tela-form"),
  sucesso: el("tela-sucesso"),
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
      mimeType: arquivo.type || "image/jpeg",
      imageBase64: base64,
    });
    // a foto não é guardada: a variável sai de escopo após esta função
    preencherFormulario(resp || {});
    mostrarTela("form");
  } catch (err) {
    console.error(err);
    toast("Não consegui ler a etiqueta. Preencha manualmente.");
    preencherFormulario({});
    mostrarTela("form");
  }
});

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
   ========================================================================= */
function preencherFormulario(d) {
  dadosExtraidos = { prontuario: d.prontuario || "" };

  el("nome").value          = d.nome_completo || "";
  el("nascimento").value    = d.data_nascimento || "";
  el("procedimento").value  = "";
  el("procedimentoOutro").value = "";
  el("campo-procedimento-outro").classList.add("oculto");
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
    aviso.classList.remove("oculto");
  } else {
    aviso.classList.add("oculto");
  }

  // limpa marcas de erro
  document.querySelectorAll(".invalido").forEach((i) => i.classList.remove("invalido"));
}

// Máscara nas datas
["nascimento", "dataProcedimento"].forEach((id) => {
  el(id).addEventListener("input", (e) => aplicarMascaraData(e.target));
});

// Dropdown "Outra…"
el("procedimento").addEventListener("change", (e) => {
  const outro = el("campo-procedimento-outro");
  if (e.target.value === "Outra") {
    outro.classList.remove("oculto");
    el("procedimentoOutro").focus();
  } else {
    outro.classList.add("oculto");
  }
});

el("btnVoltar").addEventListener("click", () => mostrarTela("captura"));

/* ---------- Validação e envio ---------- */
el("formCirurgia").addEventListener("submit", (e) => {
  e.preventDefault();
  document.querySelectorAll(".invalido").forEach((i) => i.classList.remove("invalido"));

  const nome = el("nome").value.trim();
  let procedimento = el("procedimento").value;
  const procedimentoOutro = el("procedimentoOutro").value.trim();
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

  if (erros.length) {
    toast("Verifique: " + [...new Set(erros)].join(", ") + ".");
    return;
  }

  registroPendente = {
    nome_completo: nome,
    data_nascimento: nascimento,
    procedimento_realizado: procedimento,
    data_procedimento: dataProc,
    intercorrencias: el("intercorrencias").value.trim(),
  };

  enviarRegistro(false);
});

function marcarInvalido(id) { el(id).classList.add("invalido"); }

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
      toast((resp && resp.erro) || "Não foi possível salvar. Tente novamente.");
    }
  } catch (err) {
    console.error(err);
    toast("Falha de conexão ao salvar. Verifique a internet.");
  } finally {
    btn.disabled = false;
    btn.textContent = "Salvar registro";
  }
}

/* ---------- Modal de duplicata ---------- */
function abrirModalDuplicata(msg) {
  el("modalDuplicataTexto").textContent = msg ||
    "Já existe um registro com este paciente e esta data do procedimento. Deseja salvar mesmo assim?";
  el("modalDuplicata").classList.remove("oculto");
}
el("btnDupCancelar").addEventListener("click", () => el("modalDuplicata").classList.add("oculto"));
el("btnDupConfirmar").addEventListener("click", () => {
  el("modalDuplicata").classList.add("oculto");
  enviarRegistro(true);
});

/* =========================================================================
   TELA 3 — Sucesso
   ========================================================================= */
function mostrarSucesso(r) {
  el("sucessoResumo").textContent =
    r.nome_completo + " — " + r.procedimento_realizado + " (" + r.data_procedimento + ")";
  mostrarTela("sucesso");
}
el("btnNova").addEventListener("click", () => {
  registroPendente = null;
  mostrarTela("captura");
});

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
  return resp.json();
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
}

/* Abre a configuração automaticamente no primeiro uso */
if (!getEndpoint()) {
  setTimeout(abrirConfig, 400);
}
