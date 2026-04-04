# 🛡️ Correções de Segurança — 28/03/2026

## ✅ CORRIGIDO — O que foi feito nesta sessão

---

### 1. Headers de Segurança via `<meta>` — `index.html` + `app.html`

Adicionados em ambos os arquivos:

- **`Content-Security-Policy`** — restringe origens de scripts, estilos, fontes e conexões; proíbe `frame-ancestors` (clickjacking)
- **`X-Content-Type-Options: nosniff`** — bloqueia MIME sniffing
- **`Referrer-Policy: strict-origin-when-cross-origin`** — evita vazamento de URL nos headers de requisição
- **`Permissions-Policy`** — desabilita câmera/microfone/geolocalização em `index.html`; permite câmera e microfone somente na própria origem em `app.html` (onde existe gravação de voz)

Também **removido `user-scalable=no, maximum-scale=0.75`** do viewport em ambos os arquivos.

---

### 2. XSS via `.innerHTML` com dados do usuário — `app.js`

- **`linkifyText()`** — reescrita para escapar todas as partes de texto com `_escapeHtml()` antes de montar o HTML; URLs são linkificadas de forma segura via split por captura de regex
- **`_buildNoteHtml()`** — corrigido o branch `else` (linhas de texto puro) para escapar o conteúdo antes de montar o HTML com links
- **`lineEl.innerHTML` com `lineText` (2 ocorrências)** — agora o SVG é gerado via `innerHTML` estático e o texto do usuário é inserido via `textContent`
- **`inline-editor` textarea** — removido `${noteText}` do `innerHTML`; agora usa `.value = noteText` após criar o elemento, evitando quebra de HTML se a nota contiver `</textarea>`
- **Highlight de busca** — usa `this._escapeHtml()` em cada parte antes de montar o `<mark>`
- **`title="Vinculado a ${name}"`** — escapado com `_escapeHtml()`

---

### 3. Polling agressivo — `storage.js`

Intervalo alterado de **3 segundos → 30 segundos**.

Redução de ~1200 para ~120 requisições/hora por usuário logado.

---

### 4. `console.log` com dados pessoais — `app-auth.js` + `config.js`

- Removido: `console.log('Usuário autenticado:', session.user.email)` — `app-auth.js`
- Removido: `console.log('Cliente Supabase criado com sucesso')` — `config.js`

---

### 5. `supabase-schema.sql` exposto publicamente

- Arquivo movido de `/` para `_private/supabase-schema.sql`
- Criado `_private/.gitignore` bloqueando todos os arquivos da pasta do tracking git
- Executado `git rm --cached supabase-schema.sql` — arquivo removido do histórico de commits futuros

---

## ⏳ PENDENTE — Requer mudança de infraestrutura

---

### 1. 🔴 `anonKey` hardcoded no código-fonte público

**Arquivo:** `config.js`

**Problema:** A chave JWT do Supabase está visível no repositório público do GitHub Pages. Qualquer pessoa pode acessar `config.js` diretamente via URL.

**Por que não foi corrigido agora:** GitHub Pages não suporta variáveis de ambiente — a chave precisa estar no código para o site funcionar nessa plataforma.

**Como corrigir:**
1. Migrar o deploy para **Cloudflare Pages** ou **Netlify**
2. Criar variável de ambiente: `SUPABASE_ANON_KEY`
3. Substituir em `config.js`:
```javascript
const SUPABASE_CONFIG = {
    url: process.env.SUPABASE_URL,
    anonKey: process.env.SUPABASE_ANON_KEY
};
```
4. A chave deixa de aparecer no código-fonte público

---

### 2. 🔴 Headers HTTP via servidor (`X-Frame-Options`, `Strict-Transport-Security`, `X-XSS-Protection`)

**Problema:** GitHub Pages não permite configurar headers de resposta HTTP do servidor.

**Como corrigir após migrar para Cloudflare Pages ou Netlify:**

Criar arquivo `_headers` (Netlify) ou `_headers` (Cloudflare Pages) na raiz do projeto:

```
/*
  X-Frame-Options: DENY
  X-XSS-Protection: 1; mode=block
  Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
```

---

### 3. 🟠 Sessão JWT e dados em `localStorage` sem criptografia

**Problema:** O Supabase JS SDK v2 armazena o token de sessão (`access_token` + `refresh_token`) no `localStorage` por padrão. Se houver qualquer XSS remanescente, o atacante consegue roubar a sessão completa.

**Por que não foi corrigido agora:** O SDK não expõe forma nativa de mudar o storage sem substituição completa.

**Como mitigar:**
- Os fixes de XSS feitos nesta sessão reduzem drasticamente o vetor de ataque
- Opção avançada: passar `storage` customizado ao criar o cliente Supabase, apontando para `sessionStorage` (sessão expira ao fechar o browser) — porém perde persistência entre abas:
```javascript
supabase.createClient(url, key, {
    auth: { storage: sessionStorage }
});
```
- Para dados do app (`habit-tracker-data`): avaliar criptografia com `crypto.subtle` antes de gravar no localStorage — adiciona complexidade considerável

---

### 4. 🔴 Token JWT válido até 2036 sem rotação

**Problema:** O `anonKey` tem `exp: 2089701480` (março de 2036). Se comprometido, não há como revogar facilmente.

**Como corrigir:**
1. No painel do Supabase → **Settings → API → JWT Secret** → gerar novo secret
2. Isso invalida **todos** os tokens existentes e gera uma nova `anonKey`
3. Atualizar `config.js` (ou variável de ambiente) com a nova chave
4. Fazer isso após migrar para Cloudflare/Netlify com variáveis de ambiente

---

## 📋 Checklist de Prioridades

| # | Ação | Urgência | Depende de |
|---|---|---|---|
| 1 | Migrar deploy para Cloudflare Pages ou Netlify | 🔴 Alta | — |
| 2 | Mover `anonKey` para variável de ambiente | 🔴 Alta | Item 1 |
| 3 | Adicionar `_headers` file com headers HTTP completos | 🔴 Alta | Item 1 |
| 4 | Rotacionar JWT Secret no painel Supabase | 🟠 Média | Item 2 |
| 5 | Avaliar `sessionStorage` para token de sessão | 🟡 Baixa | — |
| 6 | Avaliar criptografia dos dados no localStorage | 🟡 Baixa | — |
