// Edge Function: ai-assistant v2
// Filtra itens ativos via _settings, permite markdown, max_tokens 3000.
// Token da IA nunca no frontend. Rate limit: 30 req/60s por user.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const rateLimitMap = new Map<string, number[]>();
const RATE_LIMIT_WINDOW = 60_000;
const RATE_LIMIT_MAX = 30;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Max-Age': '86400',
};

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return jsonResp({ error: 'Method not allowed' }, 405);
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return jsonResp({ error: 'Missing or invalid Authorization header' }, 401);
    }
    const jwt = authHeader.replace('Bearer ', '');

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;

    const supabaseUser = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });
    const { data: { user }, error: userError } = await supabaseUser.auth.getUser();
    if (userError || !user) return jsonResp({ error: 'Invalid token' }, 401);
    const userId = user.id;

    const now = Date.now();
    const hits = (rateLimitMap.get(userId) || []).filter(t => now - t < RATE_LIMIT_WINDOW);
    if (hits.length >= RATE_LIMIT_MAX) {
      const retryAfter = Math.ceil((RATE_LIMIT_WINDOW - (now - hits[0])) / 1000);
      return new Response(JSON.stringify({ error: 'Rate limited', retryAfter }), {
        status: 429,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Retry-After': String(retryAfter) },
      });
    }
    hits.push(now);
    rateLimitMap.set(userId, hits);

    let body: { message?: string; history?: unknown[]; context_hint?: unknown };
    try { body = await req.json(); } catch { return jsonResp({ error: 'Invalid JSON body' }, 400); }

    const message = String(body.message || '').trim();
    const rawHistory = Array.isArray(body.history) ? body.history : [];
    const contextHint = body.context_hint || null;
    if (!message) return jsonResp({ error: 'message is required' }, 400);

    const history = rawHistory
      .filter((m: any) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map((m: any) => ({ role: m.role as string, content: m.content as string }))
      .slice(-20);

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);
    const { data: userData, error: dataError } = await supabaseAdmin
      .from('user_data').select('data').eq('user_id', userId).single();
    if (dataError || !userData) return jsonResp({ error: 'User data not found' }, 404);

    const allData = userData.data || {};
    const todayStr = todayInSP();
    const context = buildContext(allData, todayStr, contextHint);
    const sysPrompt = buildSystemPrompt(context);

    const openrouterKey = Deno.env.get('OPENROUTER_API_KEY');
    if (!openrouterKey) return jsonResp({ error: 'OpenRouter key not configured' }, 500);

    const orResp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openrouterKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://fajbxgvqptrnynpqkitx.supabase.co',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        messages: [
          { role: 'system', content: sysPrompt },
          ...history,
          { role: 'user', content: message },
        ],
        max_tokens: 3000,
        temperature: 0.7,
      }),
    });

    if (!orResp.ok) {
      const errText = await orResp.text().catch(() => '');
      console.error('OpenRouter error:', orResp.status, errText);
      return jsonResp({ error: 'AI service error', detail: orResp.status }, 502);
    }

    const orData = await orResp.json();
    const rawText: string = orData?.choices?.[0]?.message?.content || '';
    const { cleanText, actions } = parseActions(rawText);
    return jsonResp({ reply: cleanText, actions });

  } catch (err) {
    console.error('Edge Function error:', err);
    return jsonResp({ error: 'Internal server error' }, 500);
  }
});

function jsonResp(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function fmtDate(d: Date): string {
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}

// Retorna a data "hoje" no fuso de São Paulo (America/Sao_Paulo)
function todayInSP(): string {
  const now = new Date();
  // Intl é suportado no Deno — extraímos ano/mês/dia no fuso SP
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now); // retorna "YYYY-MM-DD" no locale en-CA
  return parts;
}

// Retorna dia da semana (0-6) para uma data YYYY-MM-DD (usando UTC noon para evitar DST edge)
function dayOfWeekForDate(dateStr: string): number {
  return new Date(dateStr + 'T12:00:00Z').getUTCDay();
}

// Retorna o dia do mês para uma data YYYY-MM-DD
function dayNumForDate(dateStr: string): number {
  return new Date(dateStr + 'T12:00:00Z').getUTCDate();
}

const DIAS_SEMANA = ['domingo','segunda','terça','quarta','quinta','sexta','sábado'];

function humanDate(dateStr: string, todayStr: string): string {
  const d = new Date(dateStr + 'T12:00:00Z');
  const t = new Date(todayStr + 'T12:00:00Z');
  const dayName = DIAS_SEMANA[dayOfWeekForDate(dateStr)];
  const dayNum = dayNumForDate(dateStr);
  const diffDays = Math.round((t.getTime() - d.getTime()) / 86400000);
  if (diffDays === 0) return 'hoje (' + dayName + ' dia ' + dayNum + ')';
  if (diffDays === 1) return 'ontem (' + dayName + ' dia ' + dayNum + ')';
  if (diffDays <= 6) return dayName + ' dia ' + dayNum + ' (esta semana)';
  if (diffDays <= 13) return dayName + ' dia ' + dayNum + ' (semana passada)';
  return dayName + ' dia ' + dayNum + ' (' + diffDays + ' dias atrás)';
}

// Retorna o domingo (início) da semana de uma data YYYY-MM-DD
function weekStart(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00Z');
  const day = d.getUTCDay(); // 0=dom
  d.setUTCDate(d.getUTCDate() - day);
  // Formatar manualmente em UTC para evitar problemas de fuso
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth()+1).padStart(2,'0') + '-' + String(d.getUTCDate()).padStart(2,'0');
}

interface ActiveItem { id: string; name: string; }

// Base items — espelho de APP_DATA_ORIGINAL em data.js
const BASE_ITEMS: Record<string, ActiveItem[]> = {
  clientes: [
    { id: 'wolf', name: 'Wolf' }, { id: 'bronx', name: 'Bronx' },
    { id: 'beeyond', name: 'BEEyond' }, { id: 'xenon', name: 'Xenon' },
    { id: 'amcc', name: 'Grupo AMCC' }, { id: 'tiger', name: 'Tiger Saut' },
    { id: 'gaia', name: 'Instituto Gaia Soul' }, { id: 'marcelo', name: 'Marcelo D Telles' },
    { id: 'ferny', name: 'Ferny Boutique' }, { id: 'premium', name: 'Premium' },
    { id: 'lia', name: 'Lia toss' }, { id: 'aa-flooring', name: 'A&A flooring' },
  ],
  categorias: [
    { id: 'empresa', name: 'Empresa' }, { id: 'time', name: 'Time' },
    { id: 'comercial', name: 'Comercial' }, { id: 'clientes-cat', name: 'Clientes' },
    { id: 'app', name: 'App' }, { id: 'vendas', name: 'Vendas' },
    { id: 'financeiro', name: 'Financeiro' }, { id: 'bsc', name: 'BSC' },
    { id: 'referencias', name: 'Referências' }, { id: 'ia', name: 'IA/Ferramentas' },
    { id: 'ghl', name: 'GHL - Mediagrowth' }, { id: 'mkt-usa', name: 'Mkt Contractors - USA' },
  ],
  atividades: [
    { id: 'oratoria', name: 'Oratória' }, { id: 'meditacao', name: 'Meditação' },
    { id: 'aleatorios', name: 'Segunda lei App' }, { id: 'organizar', name: 'Organizar algo' },
    { id: 'segunda-lei-conteudo', name: 'A segunda lei (CONTEÚDO)' },
    { id: 'networking', name: 'Networking Down & Up' }, { id: 'ingles', name: 'Ingles' },
    { id: 'programacao', name: 'Programação/Cyber' }, { id: 'mais-dinheiro', name: 'Mais Dinheiro' },
    { id: 'oracao', name: 'Oração/palavra de deus' },
    { id: 'investimentos', name: 'Investimentos/renda/juros/bancos' },
    { id: 'ler', name: 'Ler' }, { id: 'dj', name: 'Sovc - DJ' },
    { id: 'conexoes', name: 'Conexões/amizades' },
    { id: 'criar-video', name: 'Criar/editar/publicar um vídeo' },
    { id: 'ads', name: 'Ads/Marketing' }, { id: 'algoritmo', name: 'Algoritmo' },
    { id: 'agua', name: '2 litros d\'água' }, { id: 'sol', name: '30 min sol' },
    { id: 'fruta', name: 'Eating Fruit' }, { id: 'abdomen', name: 'Abdomen definido' },
    { id: 'academia', name: 'Academia' }, { id: 'walk', name: 'Walk' },
  ],
};

function getActiveItems(allData: Record<string, any>): Record<string, ActiveItem[]> {
  const s = allData['_settings'] || {};
  const result: Record<string, ActiveItem[]> = {};

  for (const cat of ['clientes', 'categorias', 'atividades']) {
    // Start from hardcoded base items (same as APP_DATA_ORIGINAL)
    const base: ActiveItem[] = (BASE_ITEMS[cat] || []).map(i => ({ ...i }));
    const hidden = new Set<string>((s.hiddenItems && s.hiddenItems[cat]) || []);
    const customs: any[] = (s.customItems && s.customItems[cat]) || [];
    const names: Record<string, string> = (s.itemNames && s.itemNames[cat]) || {};
    const order: string[] = (s.itemOrder && s.itemOrder[cat]) || [];

    // Apply custom names, filter hidden
    const items: ActiveItem[] = base
      .filter(it => !hidden.has(it.id))
      .map(it => ({ id: it.id, name: names[it.id] !== undefined ? names[it.id] : it.name }));

    // Add custom items
    const ids = new Set(items.map(i => i.id));
    for (const ci of customs) {
      if (!ids.has(ci.id) && !hidden.has(ci.id)) {
        items.push({ id: ci.id, name: names[ci.id] !== undefined ? names[ci.id] : ci.name });
      }
    }

    // Apply custom order
    if (order.length > 0) {
      items.sort((a, b) => {
        const ai = order.indexOf(a.id);
        const bi = order.indexOf(b.id);
        return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
      });
    }

    result[cat] = items;
  }
  return result;
}

function buildContext(allData: Record<string, any>, todayStr: string, hint: any): string {
  const L: string[] = [];
  const active = getActiveItems(allData);
  const idSets: Record<string, Set<string>> = {};
  for (const c of ['clientes','categorias','atividades']) {
    idSets[c] = new Set(active[c].map(i => i.id));
  }
  const lbl: Record<string,string> = { clientes:'Clientes', categorias:'Empresa', atividades:'Pessoal' };

  L.push('=== ITENS ATIVOS DO USUARIO (referencia interna — nao mostre IDs ao usuario) ===');
  for (const c of ['clientes','categorias','atividades']) {
    if (!active[c].length) continue;
    L.push('[' + lbl[c] + '] (' + active[c].length + ' itens)');
    active[c].forEach(i => L.push('  id="' + i.id + '" nome="' + i.name + '"'));
  }

  const td = allData[todayStr];
  const noStatus: string[] = [];
  const noNote: string[] = [];

  L.push('\n=== HOJE — ' + humanDate(todayStr, todayStr) + ' ===');
  if (td && typeof td === 'object') {
    for (const c of ['clientes','categorias','atividades']) {
      const cd = td[c] || {};
      if (!active[c].length) continue;
      L.push('[' + lbl[c] + ']');
      for (const it of active[c]) {
        const raw = cd[it.id];
        const st = raw == null ? 'none' : typeof raw === 'string' ? raw : (raw?.status || 'none');
        const note = typeof raw === 'object' ? (raw?.note || '') : '';
        let line = '  ' + it.name + ': ' + st;
        if (note) line += ' → "' + note.slice(0,200) + '"';
        L.push(line);
        if (st === 'none') noStatus.push(it.name);
        else if (!note) noNote.push(it.name);
      }
    }
  } else {
    L.push('Nenhum dado registrado para hoje.');
    for (const c of ['clientes','categorias','atividades']) {
      active[c].forEach(i => noStatus.push(i.name));
    }
  }

  if (noStatus.length) {
    L.push('\n=== ITENS SEM STATUS HOJE (' + noStatus.length + ') ===');
    noStatus.forEach(s => L.push('  ' + s));
  }
  if (noNote.length) {
    L.push('\n=== ITENS COM STATUS MAS SEM NOTA (' + noNote.length + ') ===');
    noNote.forEach(s => L.push('  ' + s));
  }

  const thisWeekStart = weekStart(todayStr);
  const thisWeekEntries: string[] = [];
  const olderEntries: string[] = [];

  for (let i = 1; i <= 14; i++) {
    const d = new Date(todayStr + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() - i);
    const ds = d.getUTCFullYear() + '-' + String(d.getUTCMonth()+1).padStart(2,'0') + '-' + String(d.getUTCDate()).padStart(2,'0');
    const dd = allData[ds];
    if (!dd || typeof dd !== 'object') continue;
    const dayLines: string[] = [];
    for (const c of ['clientes','categorias','atividades']) {
      const cd = dd[c];
      if (!cd) continue;
      for (const [id, v] of Object.entries(cd)) {
        if (!idSets[c].has(id)) continue;
        const st = typeof v === 'string' ? v : (v as any)?.status || 'none';
        if (st && st !== 'none') {
          const nm = active[c].find(x => x.id === id)?.name || id;
          const note = typeof v === 'object' ? ((v as any)?.note || '') : '';
          let entry = nm + ':' + st;
          if (note) entry += ' → "' + note.slice(0, 200) + '"';
          dayLines.push(entry);
        }
      }
    }
    if (dayLines.length) {
      const label = humanDate(ds, todayStr);
      const block = '  📅 ' + label + ':\n' + dayLines.map(l => '    ' + l).join('\n');
      if (ds >= thisWeekStart) {
        thisWeekEntries.push(block);
      } else {
        olderEntries.push(block);
      }
    }
  }

  if (thisWeekEntries.length) {
    L.push('\n=== ESTA SEMANA (com notas) ===');
    thisWeekEntries.forEach(e => L.push(e));
  }
  if (olderEntries.length) {
    L.push('\n=== SEMANA PASSADA / ANTERIOR (com notas) ===');
    olderEntries.forEach(e => L.push(e));
  }

  const ap = allData['_aprendizados'];
  if (ap && typeof ap === 'object') {
    L.push('\n=== APRENDIZADOS ===');
    let cnt = 0;
    for (const c of ['clientes','categorias','atividades']) {
      const cd = ap[c];
      if (!cd) continue;
      for (const [id, item] of Object.entries(cd)) {
        if (!idSets[c].has(id)) continue;
        if (cnt >= 20) break;
        const nm = active[c].find(x => x.id === id)?.name || id;
        const notes: any[] = (item as any)?.notes || [];
        if (notes.length) {
          for (const n of notes.filter((x: any) => !x.deleted).slice(0,3)) {
            const ct = (n.content || '').slice(0,200);
            if (ct.trim()) { L.push('  [' + nm + '] ' + (n.title || 'nota') + ': ' + ct); cnt++; }
          }
        } else {
          const ct = ((item as any)?.content || '').slice(0,200);
          if (ct.trim()) { L.push('  [' + nm + ']: ' + ct); cnt++; }
        }
      }
    }
  }

  if (hint) {
    L.push('\n=== ESTADO FRONTEND ===');
    L.push('  ' + JSON.stringify(hint));
  }

  return L.join('\n');
}

function buildSystemPrompt(context: string): string {
  return `Voce e o assistente estrategico do app "A Segunda Lei" — um app de produtividade pessoal.
Responda SEMPRE em portugues brasileiro.

## SUA PERSONALIDADE
Voce e um CONSULTOR ESTRATEGICO, nao um banco de dados.
Voce PENSA antes de responder. Voce le as notas, entende o contexto, identifica padroes e prioridades.
Voce da insights UTEIS que ajudam o usuario a tomar decisoes.

## REGRA DE OURO — NUNCA faca dumps genericos
- PROIBIDO listar todos os itens com status lado a lado como uma planilha.
- PROIBIDO fazer listas exaustivas mostrando cada item e cada dia.
- Se o usuario perguntar "o que ficou pendente", voce NAO lista tudo.
  Em vez disso, voce ANALISA, PRIORIZA e responde em TEXTO CORRIDO.
- Agrupe por TEMA ou PRIORIDADE, nao por lista completa de itens.
- Mencione apenas o que e RELEVANTE e IMPORTANTE.
- Use as NOTAS dos itens para dar contexto real (ex: "Wolf teve reuniao pendente", nao "Wolf: nao-feito").

## COMO RESPONDER sobre pendencias/semana
Quando o usuario perguntar sobre pendencias ou resumo da semana:
1. Leia TODAS as notas dos itens — elas contem informacao real sobre o que aconteceu
2. Identifique os 3-5 itens MAIS CRITICOS que precisam de atencao
3. Explique POR QUE sao criticos (baseado nas notas e padroes)
4. Mencione o que foi BEM na semana (motivar o usuario)
5. Sugira 2-3 acoes concretas para a proxima semana
6. Se um item foi "nao-feito" varios dias seguidos, isso e um padrao — aponte isso
7. Se um item tem nota explicando um bloqueio, mencione o bloqueio e sugira solucao

## EXEMPLO de resposta BOA vs RUIM

RUIM (proibido):
"- Wolf: nao-feito na segunda, concluido na terca, sem status hoje
- Bronx: concluido na segunda, pular na sexta, sem status hoje
- BEEyond: em-andamento na segunda..."

BOA (assim que deve ser):
"Olhando sua semana, tres clientes precisam de atencao urgente:

**Xenon e Grupo AMCC** ficaram sem avancar a semana toda — ambos marcados como nao-feito
desde segunda. Se tem algum bloqueio com eles, vale a pena resolver na proxima semana
antes que acumule.

**BEEyond** comecou em andamento mas nao fechou — pela nota de segunda parece que faltou
retorno deles. Talvez um follow-up rapido resolva.

Por outro lado, **Wolf** e **Tiger** foram bem resolvidos no inicio da semana, e Ferny e Premium
estao em dia. Sua area pessoal tambem ta boa — meditacao e fruta ficaram consistentes.

Para a proxima semana eu focaria em: 1) Destrancar Xenon e AMCC, 2) Follow-up no BEEyond,
3) Retomar academia que ficou parada desde quarta."

## Formatacao
Use markdown: ## titulos, ### subtitulos, **negrito**, *italico*, listas com -.
Use emojis relevantes mas com moderacao.
SEMPRE coloque linha em branco entre secoes, antes/depois de listas e blockquotes.

## Datas — regras ABSOLUTAS
- NUNCA use YYYY-MM-DD ou DD/MM/YYYY. NUNCA mostre IDs tecnicos (como \`wolf\`, \`bronx\`).
- SEMPRE use dia da semana + dia: "na terca dia 4", "ontem (sexta dia 3)", "na segunda dia 31 da semana passada"
- Use "hoje", "ontem", "esta semana", "semana passada" quando possivel

## Escopo de semana
- "a semana" ou "minha semana" = APENAS dados de "ESTA SEMANA". NAO misture semanas.
- Semanas anteriores so se o usuario pedir explicitamente.

## Dados — regras CRITICAS
- ITENS ATIVOS = unicos itens validos. NUNCA mencione itens fora dessa lista.
- Use as NOTAS dos itens como fonte principal de informacao qualitativa.
- "SEM STATUS" = nao trabalhado naquele dia.
- Ao analisar, agrupe por categoria (Clientes/Empresa/Pessoal).

## COMPORTAMENTO INTELIGENTE — PERGUNTAR ANTES DE AGIR
- ANTES de executar qualquer acao (update_item, create_aprendizado), CONFIRME com o usuario se houver ambiguidade.
- Se o usuario disser algo vago como "anota isso" — pergunte: "Quer que eu salve como nota de hoje ou como aprendizado? E em qual item?"
- Se o usuario pedir algo para "amanha" ou "semana que vem" — CONFIRME o dia: "Entendi, vou anotar para amanha (segunda dia 6). Confirma?"
- Se nao ficou claro QUAL ITEM o usuario quer atualizar — PERGUNTE. Nao assuma.
- Se o usuario pedir para anotar algo generico sem mencionar item — PERGUNTE onde salvar.
- EXCECAO: Se o contexto da conversa ja deixou claro o item e a intencao, pode agir direto.
- NUNCA execute acoes por conta propria sem o usuario pedir. Voce e assistente, nao autonomo.

## Acoes (APENAS no final, so quando o usuario PEDIR e voce tiver CERTEZA)
<actions>[{"action":"..."}]</actions>

### update_item — atualizar status e/ou nota de um item em QUALQUER DIA
{ "action":"update_item", "category":"clientes|categorias|atividades", "itemId":"id", "status":"(opcional)", "date":"hoje|amanha|ontem|segunda|...|YYYY-MM-DD", "note":"texto opcional" }
REGRAS:
- O campo "status" e OPCIONAL. SOMENTE inclua "status" se o usuario PEDIR para mudar o status.
- Se o usuario pediu apenas para adicionar uma nota/anotacao → NAO inclua "status". O sistema preserva o status existente automaticamente.
- NUNCA mude o status para "em-andamento" ou qualquer outro valor por conta propria. So mude se o usuario pedir explicitamente.
- O campo "date" indica QUANDO registrar. Valores aceitos:
  - "hoje" (padrao se omitido) — registra no dia atual
  - "amanha" — registra no dia seguinte
  - "ontem" — registra no dia anterior
  - "segunda", "terca", "quarta", "quinta", "sexta", "sabado", "domingo" — proximo dia da semana com esse nome
  - "YYYY-MM-DD" — data especifica (usar apenas se necessario)
- Se o usuario disser "amanha", "na segunda", "semana que vem" → use o campo "date" correto. NUNCA coloque demanda de amanha no dia de hoje.
- Se o item JA tem status no dia alvo (visivel nos dados), mantenha o mesmo status e apenas adicione a nota.
- O campo "note" aceita texto livre — use ele para registrar o que o usuario pediu.

### create_aprendizado — criar um aprendizado/anotacao permanente
{ "action":"create_aprendizado", "category":"clientes|atividades|categorias", "itemId":"id", "title":"titulo curto", "content":"conteudo detalhado" }
REGRAS:
- "title" e "content" sao OBRIGATORIOS. Nunca envie vazio.
- "title" deve ser curto e descritivo (ex: "Lembrar de criar campanhas no Google")
- "content" deve ter mais detalhes uteis (ex: "Criar campanhas de Google Ads para o cliente Xenon. Priorizar antes do proximo contato.")
- Se o usuario pedir para anotar/registrar algo como aprendizado, use ESTA acao.

### Quando usar cada acao:
- "faca uma nota" / "anota isso" / "registra que..." → use update_item com date correto
- "amanha preciso fazer X" / "na segunda tenho reuniao" → use update_item com date="amanha" ou date="segunda"
- "salva como aprendizado" / "anota nos aprendizados" / "guarda esse insight" → use create_aprendizado
- "marca como concluido" / "finaliza esse item" → use update_item com status adequado
- O usuario pode pedir AMBAS as acoes em sequencia. Execute todas que forem pedidas.
- Se nao ficou claro onde/quando salvar → PERGUNTE antes.

Regras gerais: nunca <actions> sem acao real. Use EXATAMENTE os IDs de ITENS ATIVOS.

DADOS DO USUARIO:
` + context;
}

function parseActions(text: string): { cleanText: string; actions: unknown[] } {
  const m = text.match(/<actions>([\s\S]*?)<\/actions>/);
  if (!m) return { cleanText: text.trim(), actions: [] };
  const clean = text.replace(/<actions>[\s\S]*?<\/actions>/, '').trim();
  let acts: unknown[] = [];
  try { const p = JSON.parse(m[1].trim()); acts = Array.isArray(p) ? p : [p]; } catch { /* noop */ }
  return { cleanText: clean, actions: acts };
}
