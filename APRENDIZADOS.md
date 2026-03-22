# Aba Aprendizados — Documentação Técnica

## Visão Geral

A aba **Aprendizados** é um bloco de notas vinculado a itens do tracker. Cada item (cliente, empresa ou atividade pessoal) tem sua própria nota com linhas independentes. As notas podem ser enviadas para a nota do dia na aba **Hoje**.

Todo o código vive em `aprendizados.js`, encapsulado num IIFE (`const Aprendizados = (() => { ... })()`).

---

## Layout

```
┌─────────────────────────────────────────────────────┐
│  [ 🔍 Buscar... ]                                   │
│                                                     │
│  CLIENTES                                           │
│  ┌──────────────────┐   ┌────────────────────────┐ │
│  │ João Silva       │   │ João Silva             │ │
│  │ preview texto... │   │ 👥 Clientes            │ │
│  ├──────────────────┤   │                        │ │
│  │ Maria Souza  2d  │   │ [Importar para hoje] 🗑️│ │
│  └──────────────────┘   │                        │ │
│                         │ ○ linha 1              │ │
│  EMPRESA                │ ✓ linha 2 (verde)      │ │
│  ┌──────────────────┐   │ ○ linha 3              │ │
│  │ ...              │   │                        │ │
│  └──────────────────┘   └────────────────────────┘ │
│       Lista (esquerda)       Editor (direita)        │
└─────────────────────────────────────────────────────┘
```

Em **mobile** (≤768px), lista e editor alternam — ao clicar num item a lista some e o editor aparece. O botão "← Voltar" retorna para a lista.

---

## Estrutura de Dados

Armazenado em `localStorage['aprendizadosData']` e espelhado no Supabase (`data['_aprendizados']` na tabela `user_data`).

```json
{
  "clientes": {
    "item-uuid-123": {
      "content": "linha 1\nlinha 2\nlinha 3",
      "checkedLines": {
        "1": true
      },
      "updatedAt": "2026-03-22T14:35:00.000Z"
    }
  },
  "categorias": { ... },
  "atividades": { ... }
}
```

| Campo | Tipo | Descrição |
|---|---|---|
| `content` | `string` | Texto completo, linhas separadas por `\n` |
| `checkedLines` | `object` | Mapa `{ índice: true }` das linhas marcadas como ✓ |
| `updatedAt` | `ISO string` | Timestamp da última edição (usado no merge) |

---

## Categorias

| Chave | Label | Cor |
|---|---|---|
| `clientes` | 👥 Clientes | `#95d3ee` |
| `categorias` | 🏢 Empresa | `#6bb8d9` |
| `atividades` | 👤 Pessoal | `#4a9cc4` |

Os itens dentro de cada categoria vêm de `APP_DATA` (definido em `data.js`).

---

## Fluxo Principal

### 1. Inicialização (`init`)

```
init()
  ├── renderList()          → monta a lista da esquerda
  ├── renderEditor()        → mostra estado vazio ("Selecione um item")
  ├── escuta #aprendSearch  → filtra lista em tempo real
  ├── escuta #aprendBtnBack → mobile: volta para lista
  └── syncFromSupabase()    → merge background (não bloqueia UI)
        └── após sync: re-renderiza lista e editor
```

### 2. Selecionar item (`selectItem`)

```
clique em item da lista
  ├── flushSave()           → salva nota atual (se havia item selecionado)
  ├── selectedItem = { category, itemId, itemName }
  ├── renderList()          → marca item como "selected"
  ├── renderEditor()        → constrói o editor para o item
  └── (mobile) showMobileEditor()
```

### 3. Editor de linhas (`renderEditor` → `buildLineRows` → `createLineRow`)

Cada linha do `content` vira uma `.aprendLineRow`:

```
.aprendLineRow
  ├── .btn-line-check   → botão ○/✓ (marca/desmarca)
  └── .aprendLineText   → div contenteditable
```

#### Interações por linha

| Ação | Resultado |
|---|---|
| Digitar | `scheduleSave` (debounce 600ms) — salva e atualiza preview na lista |
| `Enter` | Cria nova linha abaixo (`insertLineAfter`) |
| `Backspace` em linha vazia | Remove a linha (`removeLineRow`), foca na anterior |
| Colar texto simples (1 linha) | Inserido no cursor normalmente |
| Colar texto com múltiplas linhas | Cada linha vira uma `.aprendLineRow` na ordem correta; salva uma vez só no final |
| Clicar ○ | Marca linha como ✓ verde + adiciona à nota do Hoje (`adicionarNotaHoje`) |
| Clicar ✓ | Desmarca linha (remove de `checkedLines`), **não** remove da nota do Hoje |

#### Texto puro (sem HTML colorido)

- `setPlainText(el, text)` → usa `el.textContent` para escrever (evita HTML)
- `getPlainText(el)` → clona o nó, converte `<br>`→`\n` e `<div>`→`\n`, retorna `textContent`
- Handler `paste` → captura `text/plain` do clipboard, bloqueia HTML colado

---

## Botões do Header do Editor

### "Importar para hoje" (`importarParaHoje`)

Copia o conteúdo **inteiro** da nota para a nota do dia do item na aba Hoje, adicionando um separador com hora:

```
--- importado de Aprendizados 14:35 ---
```

- Não sobrescreve nota existente — concatena abaixo
- Mantém o status atual do item (não altera)
- Exibe feedback verde "✓ Importado com sucesso!" por 2,5s

### 🗑️ Apagar nota (`btnApagarNota`)

Apaga todo o `content` e `checkedLines` do item selecionado.

**Requer 2 cliques** (proteção contra acidente):
1. **1º clique** → botão fica vermelho pulsante, ícone vira ✓, tooltip muda para "Clique novamente para confirmar"
2. **2º clique** → apaga e limpa o editor
3. **Sem 2º clique em 3s** → cancela automaticamente, botão volta ao normal

---

## Sincronização com Supabase

### Escrita (`saveAllSync`)

Toda vez que o usuário edita ou marca uma linha:
1. Salva **imediatamente** no `localStorage` (síncrono)
2. Dispara `StorageManager.saveAprendizados(data)` **sem `await`** (fire and forget)
   - `StorageManager` tem debounce interno — não manda requisição para cada tecla

### Leitura/Merge (`syncFromSupabase`)

Chamado no `init()`. Algoritmo:

```
remoto = Supabase.getAprendizados()
local  = localStorage['aprendizadosData']

se remoto não existe:
  → migra dados locais para o Supabase (primeira vez)

senão:
  merged = mergeAprendizados(local, remoto)
    → para cada item: mantém o que tiver updatedAt mais recente
  salva merged no localStorage
  se merged ≠ remoto → envia merged de volta para Supabase
```

### Recuperação no login (`forceSyncFromSupabase` em `storage.js`)

Quando o usuário faz login e os dados são carregados do Supabase, se `data['_aprendizados']` existir, é copiado para `localStorage['aprendizadosData']` automaticamente.

---

## Integração com a Aba Hoje

### Pelo botão ○ em cada linha (aba Aprendizados)

Clicar no círculo ○ de uma linha:
1. Marca a linha como `checkedLines[idx] = true` (fica verde ✓)
2. Chama `adicionarNotaHoje(category, itemId, lineText)`:
   - Lê a nota atual do item no dia de hoje
   - Adiciona a linha **sem duplicar**
   - Mantém o status atual do item
   - Se a aba Hoje estiver aberta, re-renderiza

### Pelo dropdown 📚 na aba Hoje (chamado de `app.js`)

Cada item na aba Hoje tem um botão 📚 que abre um dropdown com todas as linhas de aprendizados do item. Ao clicar em uma linha:
1. Insere o texto na nota inline do item (no campo `noteEditable`)
2. Salva via `StorageManager.saveItemStatus`
3. Chama `Aprendizados.setLineChecked(category, itemId, idx, true)` → marca verde no aprendizados
4. Ao reabrir o dropdown, linhas já presentes na nota do hoje aparecem verdes automaticamente

---

## API Pública

```javascript
Aprendizados.init()              // Inicializa a aba (chamado uma vez no boot)
Aprendizados.onShow()            // Chamado ao entrar na aba (re-renderiza)
Aprendizados.onHide()            // Chamado ao sair da aba (flushSave)
Aprendizados.setLineChecked(     // Marca/desmarca linha de fora (usado pelo app.js)
  category,   // 'clientes' | 'categorias' | 'atividades'
  itemId,     // string UUID do item
  lineIndex,  // número do índice da linha no content.split('\n')
  checked     // boolean
)
```

---

## Arquivos Relacionados

| Arquivo | Responsabilidade |
|---|---|
| `aprendizados.js` | Toda a lógica da aba (UI + storage + sync) |
| `storage.js` | `saveAprendizados` / `getAprendizados` — bridge Supabase |
| `app.js` | `_toggleItemAprendDropdown`, `_addAprendLineToHoje` — integração com aba Hoje |
| `styles.css` | `.aprendLineRow`, `.aprendLineText`, `.btn-line-check`, `.item-aprend-dropdown`, `.btn-apagar-nota`, etc. |
| `app.html` | Estrutura base da aba (`#aprendLeft`, `#aprendRight`, `#aprendList`, `#aprendEditor`) |
| `data.js` | `APP_DATA` — lista de clientes, categorias e atividades |
