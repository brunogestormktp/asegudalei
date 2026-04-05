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
    const activeItems = getActiveItems(allData);
    const context = buildContext(allData, todayStr, contextHint);
    const sysPrompt = buildSystemPrompt(context, activeItems);

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
    const { cleanText, actions, quickReplies } = parseActions(rawText);
    return jsonResp({ reply: cleanText, actions, quickReplies });

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
  const lbl: Record<string,string> = { clientes:'clientes', categorias:'categorias', atividades:'atividades' };

  L.push('=== ITENS ATIVOS DO USUARIO (referencia interna — nao mostre IDs ao usuario) ===');
  L.push('IMPORTANTE: As 3 categorias validas para acoes sao EXATAMENTE: "clientes", "categorias", "atividades"');
  for (const c of ['clientes','categorias','atividades']) {
    if (!active[c].length) continue;
    L.push('[category="' + c + '"] (' + active[c].length + ' itens)');
    active[c].forEach(i => L.push('  id="' + i.id + '" nome="' + i.name + '"'));
  }

  // Usar dados em tempo real do frontend (context_hint.todayData) se disponíveis,
  // pois podem estar mais atualizados que os dados no Supabase (debounce de sync).
  const hintTodayData = (hint as any)?.todayData || null;
  const td = (hintTodayData && typeof hintTodayData === 'object')
    ? hintTodayData
    : allData[todayStr];
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

  // Dados recentes em tempo real do frontend (mais atualizados que Supabase)
  const hintRecentData = (hint as any)?.recentData || null;

  for (let i = 1; i <= 14; i++) {
    const d = new Date(todayStr + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() - i);
    const ds = d.getUTCFullYear() + '-' + String(d.getUTCMonth()+1).padStart(2,'0') + '-' + String(d.getUTCDate()).padStart(2,'0');
    // Preferir dados em tempo real do frontend para os últimos 7 dias
    const dd = (hintRecentData && hintRecentData[ds]) ? hintRecentData[ds] : allData[ds];
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
    L.push('\n=== APRENDIZADOS (notas permanentes do usuario — use para entender contexto de cada demanda) ===');
    for (const c of ['clientes','categorias','atividades']) {
      const cd = ap[c];
      if (!cd) continue;
      const catNm = lbl[c] || c;
      const catLines: string[] = [];
      for (const [id, item] of Object.entries(cd)) {
        if (!idSets[c].has(id)) continue;
        const nm = active[c].find(x => x.id === id)?.name || id;
        const notes: any[] = (item as any)?.notes || [];
        const validNotes = notes.filter((x: any) => !x.deleted);
        if (validNotes.length === 0) {
          const ct = ((item as any)?.content || '').slice(0, 400);
          if (ct.trim()) catLines.push('  [' + nm + ']: ' + ct);
          continue;
        }
        for (const n of validNotes.slice(0, 8)) {
          const ct = (n.content || '').slice(0, 400);
          if (!ct.trim()) continue;
          // Analyze checked lines (concluded items within the note)
          const lines = ct.split('\n');
          const checked = n.checkedLines || {};
          const totalLines = lines.filter((l: string) => l.trim()).length;
          const checkedCount = Object.values(checked).filter(Boolean).length;
          let statusTag = '';
          if (totalLines > 0 && checkedCount > 0) {
            if (checkedCount >= totalLines) statusTag = ' ✅ (tudo concluido)';
            else statusTag = ` (${checkedCount}/${totalLines} concluidos)`;
          }
          // Show which lines are checked (concluded) vs pending
          const annotatedLines: string[] = [];
          lines.forEach((line: string, idx: number) => {
            if (!line.trim()) return;
            const isChecked = checked[String(idx)] === true;
            annotatedLines.push((isChecked ? '✅ ' : '⬜ ') + line.trim());
          });
          catLines.push('  [' + nm + '] ' + (n.title || 'nota') + statusTag + ':\n' + annotatedLines.map((l: string) => '    ' + l).join('\n'));
        }
      }
      if (catLines.length) {
        L.push('[' + catNm + ' — Aprendizados]');
        catLines.forEach(l => L.push(l));
      }
    }
  }

  // Monthly completed items summary (for year/month context)
  const todayDate = new Date(todayStr + 'T12:00:00Z');
  const monthStart = todayStr.slice(0, 8) + '01';
  const monthEntries: string[] = [];
  for (const [dateKey, dayData] of Object.entries(allData)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) continue;
    if (dateKey < monthStart || dateKey > todayStr) continue;
    if (dateKey >= thisWeekStart) continue; // already shown in weekly
    if (typeof dayData !== 'object') continue;
    const dayLines: string[] = [];
    for (const c of ['clientes','categorias','atividades']) {
      const cd = (dayData as any)[c];
      if (!cd) continue;
      for (const [id, v] of Object.entries(cd)) {
        if (!idSets[c].has(id)) continue;
        const st = typeof v === 'string' ? v : (v as any)?.status || 'none';
        if (st === 'concluido' || st === 'concluido-ongoing' || st === 'bloqueado') {
          const nm = active[c].find(x => x.id === id)?.name || id;
          const note = typeof v === 'object' ? ((v as any)?.note || '') : '';
          let entry = nm + ':' + st;
          if (note) entry += ' → "' + note.slice(0, 150) + '"';
          dayLines.push(entry);
        }
      }
    }
    if (dayLines.length) {
      monthEntries.push('  📅 ' + humanDate(dateKey, todayStr) + ':\n' + dayLines.map(l => '    ' + l).join('\n'));
    }
  }
  if (monthEntries.length) {
    L.push('\n=== ESTE MES (concluidos e bloqueados fora da semana atual) ===');
    monthEntries.forEach(e => L.push(e));
  }

  if (hint) {
    L.push('\n=== ESTADO FRONTEND ===');
    L.push('  ' + JSON.stringify(hint));
  }

  // User-defined demand contexts (from settings)
  const itemContexts = (allData['_settings'] as any)?.itemContexts || (hint as any)?.itemContexts || null;
  if (itemContexts && typeof itemContexts === 'object') {
    const contextLines: string[] = [];
    for (const cat of ['clientes', 'categorias', 'atividades']) {
      const catCtx = itemContexts[cat];
      if (!catCtx || typeof catCtx !== 'object') continue;
      for (const [itemId, ctx] of Object.entries(catCtx)) {
        if (!ctx || typeof ctx !== 'string') continue;
        const itemName = active[cat]?.find((i: ActiveItem) => i.id === itemId)?.name || itemId;
        contextLines.push(`  [${itemName}]: ${(ctx as string).slice(0, 500)}`);
      }
    }
    if (contextLines.length) {
      L.push('\n=== CONTEXTO DAS DEMANDAS (descrito pelo usuario — USE para dar respostas melhores) ===');
      contextLines.forEach(l => L.push(l));
    }
  }

  // ── Item em foco (usuario clicou no 🤖 de um item especifico) ─────────
  // Aprendizados desse item enviados silenciosamente pelo frontend — USE para dar
  // resposta personalizada e sugerir acoes PENDENTES (nao sugira o que ja foi concluido).
  const focusedItem = (hint as any)?.focusedItemAprend || null;
  if (focusedItem && typeof focusedItem === 'object') {
    L.push('\n=== 🎯 ITEM EM FOCO — o usuario CLICOU neste item para pedir ajuda ===');
    L.push(`  Item: "${focusedItem.itemName}" (category="${focusedItem.category}", id="${focusedItem.itemId}")`);
    L.push('  INSTRUCAO: Baseie sua resposta nos aprendizados abaixo. Sugira acoes sobre itens PENDENTES. NAO sugira o que ja foi concluido.');
    if (Array.isArray(focusedItem.notes) && focusedItem.notes.length > 0) {
      L.push('  Aprendizados registrados:');
      focusedItem.notes.forEach((n: string) => L.push('    - ' + n));
    } else {
      L.push('  (Sem aprendizados registrados — use sua inteligencia para sugerir acoes com base nos dados da semana)');
    }
    L.push('  Ao final da resposta, PERGUNTE se houve aprendizado para registrar.');
  }

  // ── Feature 5: Estatísticas computadas de allData ────────────────────
  try {
    let totalCompleted = 0;
    let totalItems = 0;
    let currentStreak = 0;
    let bestStreak = 0;
    let weekCompleted = 0;
    let weekTotal = 0;
    let monthCompleted = 0;
    let monthTotal = 0;

    // Coletar todas as datas válidas em ordem decrescente
    const allDates = Object.keys(allData)
      .filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k))
      .sort()
      .reverse();

    // Calcular streak (dias consecutivos com pelo menos 1 concluido)
    let streakActive = true;
    for (const dateKey of allDates) {
      const dayData = allData[dateKey];
      if (!dayData || typeof dayData !== 'object') continue;
      let hasConcluido = false;
      for (const c of ['clientes', 'categorias', 'atividades']) {
        const cd = dayData[c];
        if (!cd || typeof cd !== 'object') continue;
        for (const [id, v] of Object.entries(cd)) {
          if (!idSets[c].has(id)) continue;
          const st = typeof v === 'string' ? v : (v as any)?.status || 'none';
          if (st === 'none' || st === 'pular') continue;
          totalItems++;
          if (st === 'concluido' || st === 'concluido-ongoing') {
            totalCompleted++;
            hasConcluido = true;
          }
          // Semana atual
          if (dateKey >= thisWeekStart && dateKey <= todayStr) {
            weekTotal++;
            if (st === 'concluido' || st === 'concluido-ongoing') weekCompleted++;
          }
          // Mês atual
          if (dateKey >= monthStart && dateKey <= todayStr) {
            monthTotal++;
            if (st === 'concluido' || st === 'concluido-ongoing') monthCompleted++;
          }
        }
      }
      if (streakActive && hasConcluido) {
        currentStreak++;
      } else {
        streakActive = false;
      }
    }

    // Calcular melhor streak
    let tempStreak = 0;
    for (const dateKey of [...allDates].reverse()) {
      const dayData = allData[dateKey];
      if (!dayData || typeof dayData !== 'object') { tempStreak = 0; continue; }
      let hasConcluido = false;
      for (const c of ['clientes', 'categorias', 'atividades']) {
        const cd = dayData[c];
        if (!cd || typeof cd !== 'object') continue;
        for (const [, v] of Object.entries(cd)) {
          const st = typeof v === 'string' ? v : (v as any)?.status || 'none';
          if (st === 'concluido' || st === 'concluido-ongoing') { hasConcluido = true; break; }
        }
        if (hasConcluido) break;
      }
      if (hasConcluido) {
        tempStreak++;
        if (tempStreak > bestStreak) bestStreak = tempStreak;
      } else {
        tempStreak = 0;
      }
    }

    const completionRate = totalItems > 0 ? Math.round((totalCompleted / totalItems) * 100) : 0;
    const weekRate = weekTotal > 0 ? Math.round((weekCompleted / weekTotal) * 100) : 0;
    const monthRate = monthTotal > 0 ? Math.round((monthCompleted / monthTotal) * 100) : 0;

    L.push('\n=== ESTATISTICAS DO USUARIO ===');
    L.push(`  Total concluidos (historico): ${totalCompleted}`);
    L.push(`  Taxa de conclusao geral: ${completionRate}%`);
    L.push(`  Semana atual: ${weekCompleted}/${weekTotal} (${weekRate}%)`);
    L.push(`  Mes atual: ${monthCompleted}/${monthTotal} (${monthRate}%)`);
    L.push(`  Sequencia atual (dias com conclusoes): ${currentStreak} dias`);
    L.push(`  Melhor sequencia: ${bestStreak} dias`);
  } catch (e) {
    // Stats são opcionais, não falhar por causa delas
  }

  return L.join('\n');
}

function buildSystemPrompt(context: string, activeItems: Record<string, ActiveItem[]>): string {
  // Build dynamic category→items reference for this specific user
  const catRef: string[] = [];
  for (const [key, label] of [['clientes','Clientes'],['categorias','Categorias'],['atividades','Atividades']] as const) {
    const names = (activeItems[key] || []).slice(0, 6).map(i => i.name).join(', ');
    const extra = (activeItems[key] || []).length > 6 ? ', ...' : '';
    catRef.push(`- "${key}" → itens deste grupo: ${names}${extra}`);
  }

  return `Voce e o assistente estrategico do app "A Segunda Lei" — um app de produtividade pessoal.
Responda SEMPRE em portugues brasileiro.

## SUA PERSONALIDADE
Voce e um CONSULTOR ESTRATEGICO, nao um banco de dados.
Voce PENSA antes de responder. Voce le as notas, os aprendizados, entende o contexto, identifica padroes e prioridades.
Voce da insights UTEIS que ajudam o usuario a tomar decisoes.
Seu FOCO PRINCIPAL e FACILITAR e AJUDAR o usuario a ESCOLHER A DEMANDA DO DIA — analisando dados, fazendo perguntas e sugerindo prioridades para deixar a SEMANA 100% CONCLUIDA.

## REGRA DE OURO — NUNCA faca dumps genericos
- PROIBIDO listar todos os itens com status lado a lado como uma planilha.
- PROIBIDO fazer listas exaustivas mostrando cada item e cada dia.
- Se o usuario perguntar "o que ficou pendente", voce NAO lista tudo.
  Em vez disso, voce ANALISA, PRIORIZA e responde em TEXTO CORRIDO.
- Agrupe por TEMA ou PRIORIDADE, nao por lista completa de itens.
- Mencione apenas o que e RELEVANTE e IMPORTANTE.
- Use as NOTAS dos itens para dar contexto real (ex: "Wolf teve reuniao pendente", nao "Wolf: nao-feito").

## APRENDIZADOS — USE COMO BASE DE CONHECIMENTO
- Voce tem acesso completo aos APRENDIZADOS do usuario — notas permanentes organizadas por demanda.
- Cada nota de aprendizado pode ter linhas concluidas (✅) e pendentes (⬜).
- USE os aprendizados para entender o HISTORICO e CONTEXTO de cada demanda.
- Se o usuario perguntar sobre um cliente/categoria/atividade, CONSULTE os aprendizados para dar respostas mais completas.
- Se um aprendizado tem itens pendentes (⬜), sugira ao usuario retomar/concluir esses itens.
- Se um aprendizado tem tudo concluido (✅), mencione como conquista positiva.

## FOCO SEMANAL E MENSAL — PRIORIDADE ABSOLUTA
- Quando perguntado sobre qualquer coisa, SEMPRE foque nas respostas da SEMANA ATUAL e MES ATUAL.
- Voce tem dados do mes todo (concluidos e bloqueados) — use para contexto, mas priorize a semana.
- Objetivo do usuario: SEMANA 100% CONCLUIDA. Ajude a planejar para atingir esse objetivo.
- Ao sugerir demandas do dia, considere: quantos dias restam na semana, o que falta fazer, e a carga de cada dia.
- Se hoje e quinta ou sexta, ALERTE sobre itens que ainda nao foram feitos na semana e que precisam de urgencia.

## ESTATISTICAS DO USUARIO — USE PARA MOTIVAR E CONTEXTUALIZAR
- Voce tem acesso as estatisticas do usuario (taxa de conclusao, sequencia de dias, totais).
- Use as estatisticas para MOTIVAR o usuario: "Voce esta com X dias seguidos concluindo tarefas!", "Sua taxa do mes esta em X%".
- Se a taxa da semana estiver baixa, use isso para sugerir urgencia.
- Se o streak (sequencia) estiver alto, elogie e incentive a manter.
- Se a taxa do mes for melhor que a da semana, aponte a queda e sugira acao.

## PERGUNTAS INTERATIVAS — BOTOES DE RESPOSTA RAPIDA
Quando voce fizer perguntas ao usuario, SEMPRE que possivel ofereca opcoes de resposta rapida usando o formato especial:
<quick_replies>["Opcao 1","Opcao 2","Opcao 3"]</quick_replies>

Exemplos de quando usar:
- "Quer que eu anote isso?" → <quick_replies>["✅ Sim, anota","❌ Não"]</quick_replies>
- "Qual demanda quer focar hoje?" → <quick_replies>["Wolf","Bronx","BEEyond","Ver todas"]</quick_replies>
- "Onde salvar essa nota?" → <quick_replies>["📝 Nota de hoje","📚 Aprendizado","❌ Cancelar"]</quick_replies>
- "Como foi a reuniao?" → <quick_replies>["✅ Concluído","🟡 Em andamento","🔴 Não rolou","🟣 Bloqueado"]</quick_replies>

REGRAS dos botoes:
- Use 2 a 5 opcoes maximo. Textos curtos (max 25 chars).
- Coloque o <quick_replies> SEMPRE no FINAL da mensagem, depois de todo o texto.
- Use emojis nos botoes para ser mais visual.
- Se a pergunta for aberta (nao sim/nao), sugira as 3-4 opcoes mais provaveis + uma opcao aberta.
- SEMPRE inclua botoes quando fizer perguntas de confirmacao (sim/nao), quando sugerir demandas, quando pedir escolha entre opcoes.

## COMO RESPONDER sobre pendencias/semana
Quando o usuario perguntar sobre pendencias ou resumo da semana:
1. Leia TODAS as notas dos itens E os aprendizados — elas contem informacao real sobre o que aconteceu
2. Identifique os 3-5 itens MAIS CRITICOS que precisam de atencao
3. Explique POR QUE sao criticos (baseado nas notas, aprendizados e padroes)
4. Mencione o que foi BEM na semana (motivar o usuario)
5. Sugira 2-3 acoes concretas para HOJE e para o restante da semana
6. Se um item foi "nao-feito" varios dias seguidos, isso e um padrao — aponte isso
7. Se um item tem nota ou aprendizado explicando um bloqueio, mencione e sugira solucao
8. No final, ofereca opcoes: <quick_replies>["📋 Planejar hoje","🔍 Ver bloqueios","💡 Sugerir foco"]</quick_replies>

## EXEMPLO de resposta BOA vs RUIM

RUIM (proibido):
"- Item A: nao-feito na segunda, concluido na terca, sem status hoje
- Item B: concluido na segunda, pular na sexta, sem status hoje
- Item C: em-andamento na segunda..."

BOA (assim que deve ser):
"Olhando sua semana, tres itens precisam de atencao urgente:

**[Item X] e [Item Y]** ficaram sem avancar a semana toda — ambos marcados como nao-feito
desde segunda. Se tem algum bloqueio, vale a pena resolver antes que acumule.

**[Item Z]** comecou em andamento mas nao fechou — pela nota de segunda parece que faltou
retorno. Talvez um follow-up rapido resolva.

Por outro lado, **[Item A]** e **[Item B]** foram bem resolvidos no inicio da semana.

Para hoje eu focaria em: 1) Destrancar [Item X] e [Item Y], 2) Follow-up no [Item Z],
3) Retomar [Item W] que ficou parado desde quarta.

Quer que eu ajude a planejar o dia?

<quick_replies>["📋 Sim, planejar","🔍 Ver detalhes","⏭ Depois"]</quick_replies>"

## FORMATACAO OBRIGATORIA — resposta limpa e legivel
- SEPARE sempre os blocos com linha em branco entre eles.
- Use no maximo 2-3 frases por paragrafo. PROIBIDO paredes de texto sem quebras de linha.
- Prefira listas curtas (3-5 itens max) a paragrafos densos.
- Use **negrito** apenas para nome de itens/clientes/demandas (nao para tudo).
- Use emojis como separadores visuais: 🔴 bloqueado, 🟡 em andamento, 🟢 concluido, ⚪ sem status.
- Para planos de acao: use numeros (1. 2. 3.) com uma acao clara por linha.
- SEMPRE deixe linha em branco antes e depois de cada lista.
- Coloque um resumo executivo em 1-2 linhas NO INICIO da resposta, antes de qualquer detalhe.
- Use markdown: ## titulos, ### subtitulos, **negrito**, *italico*, listas com -.
- SEMPRE coloque linha em branco entre secoes, antes/depois de listas e blockquotes.

## PLANO DE ACAO — quando usuario pedir plano do dia, semana ou "como lidar com X"
1. Comece com: "Com base na sua semana/mes, aqui esta o cenario:" (resumo executivo em 1-2 linhas).
2. Mostre os 2-3 maiores pontos de atencao (por nota/historico, nao por lista generica).
3. Identifique padroes de entropia: itens que repetem status "nao-feito" ou "bloqueado" ha varios dias.
4. Sugira um plano concreto: manha/tarde ou por prioridade (1. 2. 3.).
5. Use os APRENDIZADOS para personalizar: se o usuario ja registrou algo sobre um cliente/demanda, use esse conhecimento.
6. Mencione tendencia do MES: o que foi bem, o que esta acumulando.
7. Termine com botoes de acao rapida.

## Datas — regras ABSOLUTAS
- NUNCA use YYYY-MM-DD ou DD/MM/YYYY. NUNCA mostre IDs tecnicos (como \`wolf\`, \`bronx\`).
- SEMPRE use dia da semana + dia: "na terca dia 4", "ontem (sexta dia 3)", "na segunda dia 31 da semana passada"
- Use "hoje", "ontem", "esta semana", "semana passada" quando possivel

## Escopo de semana
- "a semana" ou "minha semana" = APENAS dados de "ESTA SEMANA". NAO misture semanas.
- Semanas anteriores so se o usuario pedir explicitamente.
- Porem, use dados do MES para dar contexto de tendencias quando relevante.

## Dados — regras CRITICAS
- ITENS ATIVOS = unicos itens validos. NUNCA mencione itens fora dessa lista.
- Use as NOTAS dos itens como fonte principal de informacao qualitativa.
- Use os APRENDIZADOS para entender o historico e contexto de cada demanda — o que ja foi feito, o que falta, insights registrados pelo usuario.
- Use o CONTEXTO DAS DEMANDAS (quando disponivel) para entender o que cada item representa, quem sao as pessoas envolvidas, tipo de projeto, desafios, etc. Isso e informacao de fundo fornecida pelo usuario para voce dar respostas mais inteligentes e personalizadas.
- "SEM STATUS" = nao trabalhado naquele dia.
- Ao analisar, agrupe por categoria ("clientes", "categorias", "atividades").

## COMPORTAMENTO INTELIGENTE — PERGUNTAR ANTES DE AGIR
- ANTES de executar qualquer acao (update_item, create_aprendizado), CONFIRME com o usuario se houver ambiguidade.
- Se o usuario disser algo vago como "anota isso" — pergunte com botoes: "Quer que eu salve como nota de hoje ou como aprendizado? E em qual item?" <quick_replies>["📝 Nota de hoje","📚 Aprendizado"]</quick_replies>
- Se o usuario pedir algo para "amanha" ou "semana que vem" — CONFIRME o dia com botoes: "Entendi, vou anotar para amanha (segunda dia 6). Confirma?" <quick_replies>["✅ Confirma","✏️ Outro dia"]</quick_replies>
- Se nao ficou claro QUAL ITEM o usuario quer atualizar — PERGUNTE com botoes listando os itens mais provaveis.
- Se o usuario pedir para anotar algo generico sem mencionar item — PERGUNTE onde salvar com botoes.
- EXCECAO: Se o contexto da conversa ja deixou claro o item e a intencao, pode agir direto.
- NUNCA execute acoes por conta propria sem o usuario pedir. Voce e assistente, nao autonomo.

## Acoes (APENAS no final, so quando o usuario PEDIR e voce tiver CERTEZA)
<actions>[{"action":"..."}]</actions>

### update_item — atualizar status e/ou nota de um item em QUALQUER DIA
{ "action":"update_item", "category":"clientes|categorias|atividades", "itemId":"id", "status":"(opcional)", "date":"hoje|amanha|ontem|segunda|...|YYYY-MM-DD", "note":"texto opcional" }

⚠️ CATEGORY DEVE SER EXATAMENTE UM DESTES TRES VALORES (NUNCA use outros nomes):
${catRef.join('\n')}

ERRADO: "pessoal", "empresa", "personal", "atividade" ← NUNCA use esses
CERTO: "clientes", "categorias", "atividades" ← SEMPRE use esses exatos

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
{ "action":"create_aprendizado", "category":"clientes|categorias|atividades", "itemId":"id", "title":"titulo curto", "content":"conteudo detalhado" }

⚠️ CATEGORY: mesma regra acima — SOMENTE "clientes", "categorias" ou "atividades". NUNCA "pessoal" ou "empresa".

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

// Map common AI mistakes to valid category keys
const CATEGORY_ALIASES: Record<string, string> = {
  clientes: 'clientes',
  cliente: 'clientes',
  categorias: 'categorias',
  categoria: 'categorias',
  empresa: 'categorias',
  atividades: 'atividades',
  atividade: 'atividades',
  pessoal: 'atividades',
  pessoais: 'atividades',
  personal: 'atividades',
  activities: 'atividades',
  clients: 'clientes',
};

function fixActionCategories(actions: any[]): any[] {
  return actions.map((a: any) => {
    if (a && typeof a === 'object' && a.category) {
      const fixed = CATEGORY_ALIASES[a.category.toLowerCase().trim()];
      if (fixed) a.category = fixed;
    }
    return a;
  });
}

function parseActions(text: string): { cleanText: string; actions: unknown[]; quickReplies: string[] } {
  const m = text.match(/<actions>([\s\S]*?)<\/actions>/);
  let clean = text;
  let acts: unknown[] = [];
  if (m) {
    clean = clean.replace(/<actions>[\s\S]*?<\/actions>/, '');
    try {
      const p = JSON.parse(m[1].trim());
      acts = Array.isArray(p) ? p : [p];
      acts = fixActionCategories(acts as any[]);
    } catch { /* noop */ }
  }

  // Extract quick reply buttons
  let quickReplies: string[] = [];
  const qr = clean.match(/<quick_replies>([\s\S]*?)<\/quick_replies>/);
  if (qr) {
    clean = clean.replace(/<quick_replies>[\s\S]*?<\/quick_replies>/, '');
    try {
      const parsed = JSON.parse(qr[1].trim());
      if (Array.isArray(parsed)) quickReplies = parsed.filter((x: unknown) => typeof x === 'string').slice(0, 5);
    } catch { /* noop */ }
  }

  return { cleanText: clean.trim(), actions: acts, quickReplies };
}
