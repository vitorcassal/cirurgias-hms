# Cirurgias HSM — Guia de configuração e instalação

Este guia leva você do zero ao app funcionando no celular. Não é preciso saber
programar: é copiar, colar e clicar. Faça os blocos **na ordem**. Leva ~20 min.

Este app funciona para **dois hospitais** — HMS e HMC — cada um com sua
própria aba na planilha e seus próprios campos. Na tela inicial do app você
escolhe qual hospital está usando antes de tirar a foto.

Você vai configurar três peças:

1. **A planilha** (já existe) — expandimos as colunas do HMS e criamos uma
   aba nova para o HMC, preservando tudo o que já existia.
2. **O Apps Script** — o "motor" que lê a etiqueta com IA e grava na aba
   certa da planilha, conforme o hospital escolhido.
3. **O app** — a tela que você instala no celular.

---

## Por que esta arquitetura (a escolha técnica)

Escolhemos a opção **100% Google: Apps Script + Gemini Vision**. Motivos:

- O **mesmo** script que grava na planilha também faz a leitura da etiqueta.
  Uma peça a menos para manter.
- **Uma única chave de API** (a do Gemini), e ela fica guardada **no servidor
  do Google (Apps Script)** — nunca no celular. Isso é importante para a LGPD.
- Integração nativa com o Google Sheets, sem servidor extra para hospedar.

A alternativa (backend próprio chamando a API da Anthropic/Claude) leria a
etiqueta muito bem também, mas exigiria manter um servidor adicional e uma
segunda chave — complexidade desnecessária para este caso.

---

## PARTE 1 — Obter a chave do Gemini (≈ 3 min)

A "chave de API" é uma senha que autoriza o app a usar a IA do Google.

1. Acesse **https://aistudio.google.com/apikey** e entre com a conta
   **vitor.cassal@live.com** (a mesma dona da planilha).
2. Clique em **"Create API key" / "Criar chave de API"**.
3. Copie a chave (uma sequência longa começando com `AIza...`).
4. Guarde-a por enquanto num lugar seguro — você vai colá-la na Parte 2.

> O nível gratuito do Gemini é suficiente para o volume de cirurgias do dia a dia.

---

## PARTE 2 — Instalar o Apps Script na planilha (≈ 8 min)

1. Abra a planilha de cirurgias no Google Sheets.
2. No menu, clique em **Extensões → Apps Script**. Abre um editor de código.
3. Apague qualquer conteúdo que estiver lá. Abra o arquivo **`Codigo.gs`**
   (entregue junto deste guia), **copie tudo** e **cole** no editor.
4. Clique no ícone de **salvar** (disquete) ou `Ctrl/Cmd + S`.

### 2.1 — Guardar a chave do Gemini com segurança

1. No editor do Apps Script, clique na **engrenagem ⚙️ (Configurações do
   projeto)**, na barra lateral esquerda.
2. Role até **"Propriedades do script"** → **"Adicionar propriedade do script"**.
3. Em **Propriedade**, escreva exatamente: `GEMINI_API_KEY`
4. Em **Valor**, cole a chave que você copiou na Parte 1.
5. Clique em **Salvar propriedades do script**.

### 2.2 — Reorganizar a planilha (rodar 1 vez) — **não-destrutivo**

Esta função **não toca** na sua aba original "CIRURGIAS" (ela vira backup).
Ela apenas **cria uma aba nova e limpa chamada "CIRURGIAS APP"** com as 5
colunas e seus registros já migrados. É essa aba nova que o app usa.

1. No topo do editor, na lista de funções, selecione **`configurarPlanilha`**.
2. Clique em **Executar** (▶).
3. Na primeira vez o Google pede autorização: clique em **Revisar permissões**,
   escolha a conta **vitor.cassal@live.com**, clique em **Avançado → Acessar
   (nome do projeto)** e depois **Permitir**.
   *(Esse aviso é normal: é o seu próprio script pedindo acesso à sua planilha.)*
4. Volte à planilha. Deve aparecer uma nova aba **"CIRURGIAS APP"** com as
   colunas: **Nome Completo | Data de Nascimento | Procedimento Realizado |
   Data do Procedimento | Intercorrências**, e seus registros antigos migrados
   (Data de Nascimento e Intercorrências em branco neles). A aba original
   "CIRURGIAS" continua intacta.

> Pode rodar `configurarPlanilha` quantas vezes quiser: ela sempre recria a aba
> "CIRURGIAS APP" a partir da original, sem risco para os dados.

> **Recuperou dados?** Se em algum teste a planilha ficou bagunçada, use
> **Arquivo → Histórico de versões → Ver histórico de versões**, escolha uma
> versão anterior e clique em **Restaurar**. Nada se perde de verdade.

### 2.2b — Criar a aba do HMC (rodar 1 vez)

O HMC não tinha aba antiga para migrar, então esta função só cria a aba nova
já com o cabeçalho formatado, pronta para receber os registros.

1. No topo do editor, na lista de funções, selecione **`configurarAbaHMC`**.
2. Clique em **Executar** (▶) e autorize se for pedido (mesmo aviso da 2.2).
3. Volte à planilha. Deve aparecer uma nova aba **"HMC"** com as colunas:
   **Data | Nome Completo | Número de Atendimento | Procedimento Realizado |
   Chefe | Convênio | Apartamento**.

> Se você pular esta etapa, a aba "HMC" é criada automaticamente no primeiro
> registro salvo pelo app — só não vem com a formatação do cabeçalho pronta.

### 2.3 — Publicar o "Aplicativo da Web" (o endereço que o app usa)

1. No editor, canto superior direito: **Implantar → Nova implantação**.
2. Clique na engrenagem ⚙️ ao lado de "Selecionar tipo" e escolha
   **Aplicativo da Web**.
3. Configure assim:
   - **Descrição:** Cirurgias HSM
   - **Executar como:** **Eu (vitor.cassal@live.com)**
   - **Quem pode acessar:** **Qualquer pessoa**
4. Clique em **Implantar** e autorize se for pedido.
5. Copie a **URL do aplicativo da Web** — termina em **`/exec`**. Guarde-a:
   é ela que você vai colar no app na Parte 3.

> "Qualquer pessoa" significa que quem tiver essa URL consegue chamar o
> endpoint. Trate a URL como uma senha: não a publique. Veja a seção
> **Privacidade** abaixo para reforçar o acesso.

> **Sempre que atualizar o `Codigo.gs`**, refaça a publicação por
> **Implantar → Gerenciar implantações → (lápis de editar) → Versão: Nova
> versão → Implantar**. A URL `/exec` continua a mesma.

---

## PARTE 3 — Hospedar e instalar o app no celular (≈ 8 min)

O app são arquivos estáticos (`index.html`, `app.js`, etc.). Para instalá-lo no
celular, ele precisa estar num endereço **https**. A forma gratuita e confiável
é o **GitHub Pages**.

### 3.1 — Publicar os arquivos no GitHub Pages

1. Crie uma conta gratuita em **https://github.com** (se ainda não tiver).
2. Clique em **+ → New repository**. Nome: `cirurgias-hsm`. Marque **Public**.
   Clique em **Create repository**.
3. Na página do repositório, clique em **"uploading an existing file"**.
4. Arraste **todos** os arquivos do app para a área de upload:
   `index.html`, `styles.css`, `app.js`, `manifest.json`,
   `service-worker.js` e a **pasta `icons`** inteira.
5. Clique em **Commit changes**.
6. Vá em **Settings → Pages**. Em **Branch**, escolha **`main`** e a pasta
   **`/ (root)`**, clique em **Save**.
7. Aguarde ~1 min e recarregue: aparecerá o endereço público, algo como
   **`https://SEU-USUARIO.github.io/cirurgias-hsm/`**.

### 3.2 — Abrir, configurar e instalar

1. No **celular**, abra esse endereço no **Chrome (Android)** ou **Safari (iPhone)**.
2. Na primeira vez o app abre a janela de **Configuração**. Cole ali a **URL do
   aplicativo da Web** (a `/exec` da Parte 2.3) e toque em **Salvar**.
   *(Depois, dá para reabrir isso pelo ícone ⚙️ no topo.)*
3. Instale na tela inicial:
   - **Android/Chrome:** menu **⋮ → Instalar app / Adicionar à tela inicial**.
   - **iPhone/Safari:** botão **Compartilhar → Adicionar à Tela de Início**.
4. Pronto: aparece o ícone **Cirurgias HSM**. Abra por ele — funciona como um
   app de verdade, em tela cheia.

---

## Como usar (fluxo do dia a dia)

1. Abra o app e, na tela inicial, toque em **HMS** ou **HMC** para escolher o
   hospital — o app lembra a última escolha na próxima vez que abrir.
2. Toque em **Enviar foto da etiqueta** (abre a câmera).
3. Aguarde **"Extraindo dados…"**. O app preenche os campos lidos da etiqueta.
4. Confira tudo e complete os campos que só você preenche:
   - **HMS:** escolha o **Procedimento** (ou "Outra…") e ajuste a **Data do
     procedimento** se preciso. Anote **Intercorrências** se houver.
   - **HMC:** escolha o **Procedimento** (ou "Outros…"), o **Chefe** (ou
     "Outro…") e se é **Apartamento** (Sim/Não — não vem pré-marcado, você
     sempre escolhe). Confira o **Convênio** lido da etiqueta.
5. Toque em **Salvar registro**.
   - No **HMS**, se já existir um registro com o mesmo nome e a mesma data,
     o app avisa e pede confirmação antes de gravar.
   - No **HMC**, o aviso aparece se já existir um registro com o mesmo nome
     e o mesmo **número de atendimento**.
6. Toque em **Registrar nova cirurgia** para o próximo paciente.

---

## Consultas do ambulatório (novo)

Com o hospital **HMS** selecionado, a tela inicial mostra um botão
**"🏥 Consultas Ambulatório"** logo abaixo de "Enviar foto da etiqueta".
(No HMC o botão não aparece — o registro de ambulatório existe só no HMS.)

1. Toque em **Consultas Ambulatório**.
2. A **Data** já vem preenchida com o dia de hoje — edite se o atendimento
   foi em outro dia.
3. Digite o **Número de atendimentos** do dia.
4. Toque em **Enviar**. O app grava uma linha nova na aba **"AMBU"** da
   planilha, no formato que ela já usa (Número de Pacientes | Data).

Se já existir um lançamento naquela mesma data, o app avisa quantos
atendimentos já constam e pede confirmação antes de gravar — evita lançar
o mesmo dia duas vezes por engano.

Esses números são exatamente os que alimentam o card **"Atendimentos no
ambulatório"** do relatório mensal.

---

## Relatório mensal (novo)

O app agora tem um botão **"📊 Ver relatório mensal"** na tela inicial (abaixo de
"Prefiro preencher manualmente"). Ele mostra um relatório diferente conforme o
hospital selecionado no momento:

**HMS** — escolha o mês e o app mostra: total de cirurgias, quantas
colecistectomias abertas, quantas hernioplastias, quantos atendimentos no
ambulatório, e uma tabela com a quantidade e o valor somado de cada
procedimento (Hernioplastia inguinal/umbilical/incisional/epigástrica,
Colecistectomia convencional, e "Outros" para textos digitados fora desse
padrão), com o total geral no final.

**HMC** — escolha o mês e o app mostra uma tabela com todos os registros
daquele mês (data, nome, atendimento, procedimento, chefe, convênio,
apartamento).

### De onde vêm os números

- **Cirurgias e valores (HMS):** da própria aba **"CIRURGIAS APP"**. Foi
  adicionada uma 6ª coluna, **Honorário** — que você já vinha preenchendo
  manualmente na planilha. Agora ela também aparece na Tela 2 do app
  (**"Valor do procedimento"**, opcional): ao escolher o procedimento, o
  campo já vem sugerido com o valor usual (R$ 220,00 para hernioplastias,
  R$ 450,00 para colecistectomia convencional) — edite se for diferente.
- **Atendimentos no ambulatório (HMS):** da aba **"AMBU"** (Número de
  Pacientes | Data). Agora o app **também grava** nessa aba, pelo botão
  "Consultas Ambulatório" — e continua lendo tudo o que já está lá, inclusive
  o que você lançou manualmente antes.
- **Registros (HMC):** da aba **"HMC"**, os mesmos dados que o app já grava
  ao salvar um registro.

> A aba **"Resumo Mensal"** que você mantinha manualmente não precisa mais
> ser atualizada à mão — o relatório do app calcula os mesmos números na
> hora, direto da aba "CIRURGIAS APP". Pode manter essa aba como estava
> (nada nela é apagado) ou simplesmente parar de atualizá-la.

### Importante: reimplante o Apps Script

Como o `Codigo.gs` mudou (ação "report", coluna Honorário e agora a ação
"saveAmbu", do botão Consultas Ambulatório), é
preciso reimplantar antes do relatório funcionar: **Implantar → Gerenciar
implantações → lápis de editar → Versão: Nova versão → Implantar** (veja a
seção "Se algo der errado" mais abaixo se tiver dúvida). A URL `/exec`
continua a mesma, não precisa colar de novo no app.

---

## Como atualizar o app depois

- **Mudou o `Codigo.gs`?** Cole o novo conteúdo no editor do Apps Script e
  refaça a publicação (Parte 2.3, "Gerenciar implantações → Nova versão").
- **Mudou algo no app (visual/telas)?** Suba os arquivos novos no GitHub
  (mesmo passo do upload, ele substitui) — o celular pega a versão nova ao
  reabrir.

---

## Privacidade e segurança (LGPD)

Os dados são **informações de saúde de pacientes** — dados pessoais sensíveis.
O app foi construído com estes cuidados:

- **As fotos das etiquetas não são guardadas.** A imagem é enviada, lida pela
  IA e descartada. O service worker nunca coloca fotos nem dados de pacientes
  em cache.
- **Todo o tráfego é por HTTPS** (GitHub Pages e Google usam https por padrão).
- **A chave da IA fica no servidor (Apps Script)**, nunca no celular.
- **Dados de pacientes não são gravados em logs.**

Suas responsabilidades como **controlador dos dados**:

- **Restrinja o acesso ao app.** Não divulgue o endereço do GitHub Pages nem a
  URL `/exec`. Para reforçar, em vez de "Qualquer pessoa" você pode reimplantar
  com **"Qualquer pessoa com conta Google"** — assim só logados acessam (exige
  ajuste no app para enviar o token; peça que eu implemente se desejar esse
  nível extra).
- Mantenha o celular com **bloqueio de tela** e o app fora de telas
  compartilhadas.
- Garanta que o uso está coberto pela base legal adequada do hospital
  (prestação de cuidado de saúde) e pela política de privacidade da instituição.

---

## Se algo der errado

- **"Configure a URL do app primeiro":** toque no ⚙️ e cole a URL `/exec`.
- **Não lê a etiqueta / erro da IA:** confira se a propriedade
  `GEMINI_API_KEY` foi salva corretamente (Parte 2.1) e se a foto está nítida.
  Você sempre pode tocar em **"Prefiro preencher manualmente"**.
- **Erro ao salvar:** confirme que a implantação está como **Aplicativo da Web**,
  **executar como você**, **acesso: qualquer pessoa**, e que a URL termina em
  `/exec`.
- **Campos de data reclamando:** use sempre **DD/MM/AAAA** (o app coloca as
  barras automaticamente).
- **Relatório do HMS com números estranhos:** confira se o texto do
  procedimento na planilha bate com um dos nomes padrão (ex.: contém
  "hernioplastia" ou "colecistectomia"); textos bem diferentes caem no grupo
  "Outros". Colecistectomia "VLP" conta como "Outros", não como "aberta".
- **`configurarPlanilha` não faz mais nada:** é proposital — essa função só
  existia para a migração única da aba antiga "CIRURGIAS", que já não existe
  mais. Rodá-la de novo poderia apagar os registros reais (com Honorário) que
  já estão em "CIRURGIAS APP", então ela agora se recusa a rodar. Edite a aba
  "CIRURGIAS APP" direto na planilha se precisar de algum ajuste manual.

### "O app não atualizou depois que você mudou algo"

Isso acontece porque o celular guarda os arquivos do app em cache para
funcionar offline, e nem sempre percebe a versão nova na hora. A partir desta
atualização o service worker passou a buscar HTML/JS/CSS direto da rede
primeiro (e recarrega sozinho quando percebe uma versão nova), o que já
reduz bastante o problema. Se mesmo assim o app parecer "antigo":

1. Confirme que os arquivos novos (`index.html`, `app.js`, `styles.css`,
   `service-worker.js`) foram realmente reenviados para onde o app está
   hospedado (Parte 3.1) — sem isso não há nada de novo para buscar.
2. **Feche o app de verdade** no celular (não só minimize — no Android,
   abra a lista de apps recentes e deslize para fechar; no iPhone, arraste
   para cima no seletor de apps) e abra de novo.
3. Se ainda parecer antigo, abra o endereço do app pelo **navegador** (Chrome
   ou Safari, não pelo ícone instalado), force uma atualização da página
   (puxar para baixo para recarregar) e depois reabra pelo ícone instalado.

### "Falha de conexão... (unexpected token / não é JSON válido)"

Esse erro significa que o servidor respondeu algo diferente de um JSON —
quase sempre porque o **Apps Script foi editado mas não foi reimplantado**.
Editar e salvar o `Codigo.gs` no editor **não** atualiza sozinho a URL
`/exec` que o app usa; é preciso publicar uma nova versão:

1. No editor do Apps Script: **Implantar → Gerenciar implantações**.
2. Clique no ícone de **lápis (editar)** na implantação existente.
3. Em **Versão**, escolha **Nova versão** e clique em **Implantar**.
4. A URL `/exec` continua a mesma — não precisa colar de novo no app.

Se o erro continuar depois de reimplantar, confira também: (a) se a URL
configurada no app (⚙️) é exatamente essa `/exec`, sem espaços ou texto
extra; e (b) se você consegue abrir essa mesma URL no navegador do
computador — a partir desta atualização ela responde com um JSON explicando
o que aconteceu, o que ajuda a confirmar se é o servidor certo.
