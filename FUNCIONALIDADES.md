# 📊 A Segunda Lei - Tracker de Entropia

Sistema de rastreamento diário para manter a entropia baixa nos pontos mais importantes da vida através do monitoramento e gestão de atividades.

---

## 🎯 **Para que serve o App**

O app **A Segunda Lei** é um tracker de hábitos e atividades diárias que ajuda você a:

- **Monitorar tarefas diárias** organizadas em 3 categorias principais
- **Visualizar o desempenho** através de relatórios e gráficos
- **Manter o foco** em clientes, projetos e rotinas importantes
- **Reduzir a entropia** mantendo controle sobre suas atividades
- **Registrar notas** por texto ou voz em cada item
- **Acompanhar o histórico** de execução ao longo do tempo

---

## 📱 **Abas e Navegação**

O app possui **3 telas principais** acessíveis através dos botões no header:

### 1. 🏠 **Hoje** (Tela Principal)
Visualização do dia atual com todas as atividades

### 2. 📅 **Histórico**
Visualização de dias anteriores e progresso

### 3. 📈 **Relatórios**
Análise estatística e gráficos de desempenho

---

## 🏠 **Tela: HOJE**

### O que você vê:
- **Seletor de Data** - Navegue entre dias (← Anterior | Próximo →)
- **Data Atual** - Dia sendo visualizado
- **3 Categorias de Items**:
  - 👥 **CLIENTES** - Acompanhamento de clientes e projetos
  - 🗂️ **CATEGORIAS** - Áreas de negócio e responsabilidades
  - 🎯 **ATIVIDADES / ROTINA** - Hábitos diários e tarefas recorrentes

### Como funciona:

#### **Para cada item você pode:**

1. **Definir Status** (dropdown)
   - Selecione o estado atual da tarefa
   - Opções disponíveis:
     - `—` (Neutro - sem status)
     - Em andamento
     - Bloqueado
     - Concluído
     - Aguardando
     - Não feito
     - Pular
     - Concluído/On going time
     - Parcialmente concluído
     - Prioridade

2. **Adicionar Notas** (clique no item)
   - Clique no card para entrar em modo de edição
   - Digite suas notas diretamente no campo
   - As notas são salvas automaticamente ao sair do campo
   - Suporta links (URLs são automaticamente clicáveis)

3. **Gravar Nota por Voz** 🎙️
   - Clique no ícone do microfone
   - Permita o acesso ao microfone do navegador
   - Fale sua nota
   - A transcrição é adicionada automaticamente com timestamp
   - Formato: `[voz HH:MM:SS] texto transcrito`

4. **Apagar Nota** ✖
   - Clique no X no canto inferior direito da nota
   - Confirme a exclusão no modal
   - A nota é removida (status permanece)

### Recursos visuais:
- **Cores de Status** - Cada item muda de cor conforme o status selecionado
- **Indicador de Nota** - Items com notas exibem o texto formatado
- **Modo de Edição** - Apenas um item pode ser editado por vez
- **Glassmorphism** - Efeito de vidro transparente nos cards

---

## 📅 **Tela: HISTÓRICO**

### O que você vê:
- **Seletor de Período** - Escolha quantos dias visualizar (7, 14, 30, 60, 90 dias)
- **Timeline reversa** - Dias mais recentes primeiro
- **Status de cada item por dia**
- **Notas registradas**

### Como funciona:
- Navegue pelo período usando o dropdown
- Veja o que foi feito em cada dia
- Identifique padrões e consistência
- Revise notas antigas

### Informações exibidas:
- Data completa (dia da semana, dia, mês, ano)
- Status de cada item naquele dia
- Notas completas com formatação
- Links clicáveis preservados

---

## 📈 **Tela: RELATÓRIOS**

### O que você vê:
- **Botões de Período** (Semanal | Mensal | Anual | Geral)
- **Taxa de Conclusão Geral** - Percentual médio de sucesso
- **Relatório por Categoria**:
  - Nome da categoria
  - Taxa de conclusão específica
  - Barra de progresso visual
  - Cor indicativa de performance

### Como funciona:

#### **Sistema de Pontuação:**
Cada status tem um valor (score):
- ✅ **Concluído** / **Concluído Ongoing** = 1.0 ponto (100%)
- 🟡 **Parcialmente** = 0.7 pontos (70%)
- 🟠 **Em andamento** = 0.5 pontos (50%)
- 🔵 **Aguardando** = 0.3 pontos (30%)
- ❌ **Não feito** / **Bloqueado** / **Prioridade** = 0 pontos
- ⚪ **Neutro** / **Pular** = Não conta (ignorado nos cálculos)

#### **Cores do Progresso:**
- 🟢 **Verde** (≥ 70%) - Excelente desempenho
- 🟡 **Amarelo** (50-69%) - Performance moderada
- 🔴 **Vermelho** (< 50%) - Precisa atenção

#### **Períodos disponíveis:**
- **Semanal** - Últimos 7 dias
- **Mensal** - Últimos 30 dias
- **Anual** - Últimos 365 dias
- **Geral** - Todo o histórico disponível

### Estatísticas exibidas:
- **Percentual geral** do período
- **Percentual por categoria** (Clientes, Categorias, Atividades)
- **Total de items concluídos**
- **Total de items em andamento**
- **Total de items aguardando**
- **Total de items não feitos**
- **Total de items pulados**

---

## 💾 **Armazenamento de Dados**

### Como os dados são salvos:
- **LocalStorage** do navegador (dados locais)
- Salvo automaticamente a cada mudança
- Não envia dados para servidor
- Privacidade total

### Formato dos dados:
```javascript
{
  "2026-03-21": {
    "clientes": {
      "wolf": {
        "status": "concluido",
        "note": "Reunião realizada com sucesso"
      }
    }
  }
}
```

### Backup:
- Dados permanecem enquanto não limpar cache do navegador
- **Importante**: Faça backup manual se necessário
- Pode exportar do console: `localStorage.getItem('habitTrackerData')`

---

## 🎤 **Reconhecimento de Voz**

### Requisitos:
- Navegador compatível (Chrome, Safari, Edge)
- Permissão de acesso ao microfone
- Conexão com internet (para transcrição)

### Como usar:
1. Clique no ícone 🎙️ ao lado do status
2. Autorize o microfone quando solicitado
3. Fale sua nota claramente
4. A transcrição aparece automaticamente
5. Formato: `[voz 17:30:45] Texto da nota`

### Limitações:
- Alguns navegadores não suportam (Firefox, navegadores antigos)
- Requer conexão para processar a fala
- Idioma configurado: Português do Brasil

---

## 🎨 **Identidade Visual**

### Paleta de Cores:
- **Azul Claro** (#95d3ee) - Destaques e acentos
- **Azul Médio** (#1c567e) - Cards e superfícies
- **Azul Escuro** (#013972) - Botões primários
- **Fundo** (#042235 → #0a4a7a) - Gradiente de profundidade

### Tipografia:
- **Quicksand** - Fonte principal (corpo, UI, botões)
- **Playfair Display Italic** - Títulos de categorias

### Efeitos:
- **Glassmorphism** - Transparência e blur nos cards
- **Sombras azuis** - Profundidade sem preto puro
- **Animações suaves** - Transições de 0.3s
- **Hover states** - Feedback visual em todos os botões

---

## ⚡ **Atalhos e Dicas**

### Navegação rápida:
- **Clique no item** = Entrar em modo de edição de nota
- **Clique fora** = Sair do modo de edição (salva automaticamente)
- **Dropdown de status** = Abre ao clicar, fecha ao selecionar
- **ESC** = Fecha modal de confirmação

### Produtividade:
- Defina status logo pela manhã
- Adicione notas durante o dia
- Use voz para notas rápidas
- Revise relatórios semanalmente
- Mantenha consistência no registro

### Boas práticas:
- **Neutro** (`—`) = Use quando não se aplica ao dia
- **Pular** = Use para items não relevantes temporariamente
- **Em andamento** = Tarefas que levam múltiplos dias
- **Aguardando** = Dependências externas
- **Bloqueado** = Impedimentos temporários

---

## 📱 **Compatibilidade**

### Navegadores suportados:
- ✅ **Chrome** (Desktop e Mobile) - Recomendado
- ✅ **Safari** (Desktop e Mobile)
- ✅ **Edge** (Desktop)
- ⚠️ **Firefox** (sem reconhecimento de voz)
- ❌ **Internet Explorer** (não suportado)

### Dispositivos:
- 📱 **Mobile** - Interface otimizada para toque
- 💻 **Desktop** - Experiência completa
- 📱 **Tablet** - Responsivo

### Requisitos:
- Navegador moderno (últimos 2 anos)
- JavaScript habilitado
- LocalStorage disponível
- Microfone (opcional, para voz)

---

## 🚀 **Como Começar**

1. **Abra o app** no navegador
2. **Familiarize-se** com as 3 categorias
3. **Defina os status** dos items de hoje
4. **Adicione notas** conforme necessário
5. **Use o microfone** para notas rápidas
6. **Navegue pelos dias** para ver histórico
7. **Confira relatórios** para análise de desempenho

---

## 🎯 **Filosofia: A Segunda Lei**

O app é baseado no conceito da **Segunda Lei da Termodinâmica** aplicado à vida pessoal:

> "A entropia de um sistema isolado nunca diminui"

**Tradução prática:**
- Sem ação constante, as coisas tendem à desordem
- Manter o controle requer esforço diário
- Monitoramento previne o caos
- Pequenas ações diárias = grande impacto acumulado

**Objetivo:**
Manter a **entropia baixa** nos aspectos mais importantes da vida através de:
- Acompanhamento diário estruturado
- Visibilidade total das atividades
- Identificação rápida de problemas
- Decisões baseadas em dados
- Hábitos consistentes

---

## 📞 **Suporte**

Para dúvidas ou problemas:
1. Verifique se o navegador é compatível
2. Limpe o cache se houver problemas
3. Recarregue a página (F5 ou Cmd+R)
4. Verifique permissões do microfone (para voz)
5. Teste em modo anônimo para isolar problemas

---

**Desenvolvido com foco em produtividade e controle pessoal.**

*"Ordem é manter a entropia sob controle, um dia de cada vez."*
