// Edge Function: ai-assistant v3 (token-optimized)
// Filtra itens ativos via _settings, permite markdown, max_tokens 2000.
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
      .slice(-12);

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);
    const { data: userData, error: dataError } = await supabaseAdmin
      .from('user_data').select('data').eq('user_id', userId).single();
    if (dataError || !userData) return jsonResp({ error: 'User data not found' }, 404);

    const allData = userData.data || {};
    const todayStr = todayInSP();
    const activeItems = getActiveItems(allData);
    const context = buildContext(allData, todayStr, contextHint);
    const sysPrompt = buildSystemPrompt(context, activeItems);

    // Respostas mais longas quando modo analise profunda (sem nota no item)
    const isDeepMode = !!(contextHint as any)?.focusedItemAprend?.noNoteMode;
    const maxTokens = isDeepMode ? 3000 : 2000;

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
        max_tokens: maxTokens,
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
        if (note) line += ' → "' + note.slice(0,150) + '"';
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
    L.push('\n⚪ SEM STATUS HOJE (' + noStatus.length + '): ' + noStatus.slice(0, 10).join(', ') + (noStatus.length > 10 ? '...' : ''));
  }
  if (noNote.length) {
    L.push('📝 COM STATUS SEM NOTA (' + noNote.length + '): ' + noNote.slice(0, 10).join(', ') + (noNote.length > 10 ? '...' : ''));
  }

  const thisWeekStart = weekStart(todayStr);
  const thisWeekEntries: string[] = [];
  const olderEntries: string[] = [];

  // Dados recentes em tempo real do frontend (mais atualizados que Supabase)
  const hintRecentData = (hint as any)?.recentData || null;

  // 7 dias detalhados + dias 8-14 apenas contagem
  for (let i = 1; i <= 14; i++) {
    const d = new Date(todayStr + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() - i);
    const ds = d.getUTCFullYear() + '-' + String(d.getUTCMonth()+1).padStart(2,'0') + '-' + String(d.getUTCDate()).padStart(2,'0');
    const dd = (hintRecentData && hintRecentData[ds]) ? hintRecentData[ds] : allData[ds];
    if (!dd || typeof dd !== 'object') continue;

    if (i <= 7) {
      // Últimos 7 dias: detalhes com notas
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
            if (note) entry += ' → "' + note.slice(0, 120) + '"';
            dayLines.push(entry);
          }
        }
      }
      if (dayLines.length) {
        const label = humanDate(ds, todayStr);
        const block = '  📅 ' + label + ':\n' + dayLines.map(l => '    ' + l).join('\n');
        if (ds >= thisWeekStart) thisWeekEntries.push(block);
        else olderEntries.push(block);
      }
    } else {
      // Dias 8-14: apenas contagem resumida
      let cCount = 0, bCount = 0, nfCount = 0;
      for (const c of ['clientes','categorias','atividades']) {
        const cd = dd[c];
        if (!cd) continue;
        for (const [id, v] of Object.entries(cd)) {
          if (!idSets[c].has(id)) continue;
          const st = typeof v === 'string' ? v : (v as any)?.status || 'none';
          if (st === 'concluido' || st === 'concluido-ongoing') cCount++;
          else if (st === 'bloqueado') bCount++;
          else if (st === 'nao-feito') nfCount++;
        }
      }
      if (cCount + bCount + nfCount > 0) {
        const label = humanDate(ds, todayStr);
        olderEntries.push(`  📅 ${label}: ${cCount}✓ ${bCount}🔴 ${nfCount}✗`);
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
    L.push('\n=== APRENDIZADOS (notas permanentes — contexto de cada demanda) ===');
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
          const ct = ((item as any)?.content || '').slice(0, 200);
          if (ct.trim()) catLines.push('  [' + nm + ']: ' + ct);
          continue;
        }
        for (const n of validNotes.slice(0, 5)) {
          const ct = (n.content || '').slice(0, 300);
          if (!ct.trim()) continue;
          const lines = ct.split('\n').filter((l: string) => l.trim());
          const checked = n.checkedLines || {};
          const total = lines.length;
          const done = Object.values(checked).filter(Boolean).length;
          const pending = lines.filter((_: string, idx: number) => !checked[String(idx)]).map((l: string) => l.trim());
          let tag = '';
          if (total > 0 && done > 0) {
            tag = done >= total ? ' ✅ALL' : ` (${done}/${total}✓)`;
          }
          // Only show pending lines (save tokens by skipping concluded)
          const preview = pending.length > 0 ? pending.slice(0, 6).join('; ') : '(tudo concluido)';
          catLines.push('  [' + nm + '] ' + (n.title || 'nota') + tag + ': ' + preview);
        }
      }
      if (catLines.length) {
        L.push('[' + catNm + ']');
        catLines.forEach(l => L.push(l));
      }
    }
  }

  // Monthly summary: just counts per day (items already shown in weekly detail)
  const monthStart = todayStr.slice(0, 8) + '01';
  const monthSummary: string[] = [];
  let monthTotalC = 0, monthTotalB = 0;
  for (const [dateKey, dayData] of Object.entries(allData)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) continue;
    if (dateKey < monthStart || dateKey > todayStr) continue;
    if (dateKey >= thisWeekStart) continue;
    if (typeof dayData !== 'object') continue;
    let cCount = 0, bCount = 0;
    for (const c of ['clientes','categorias','atividades']) {
      const cd = (dayData as any)[c];
      if (!cd) continue;
      for (const [id, v] of Object.entries(cd)) {
        if (!idSets[c].has(id)) continue;
        const st = typeof v === 'string' ? v : (v as any)?.status || 'none';
        if (st === 'concluido' || st === 'concluido-ongoing') cCount++;
        else if (st === 'bloqueado') bCount++;
      }
    }
    if (cCount + bCount > 0) {
      monthTotalC += cCount;
      monthTotalB += bCount;
      monthSummary.push(`  ${humanDate(dateKey, todayStr)}: ${cCount}✓ ${bCount}🔴`);
    }
  }
  if (monthSummary.length) {
    L.push(`\n=== MES (fora da semana): ${monthTotalC}✓ ${monthTotalB}🔴 total ===`);
    monthSummary.forEach(e => L.push(e));
  }

  // Metadata leve do frontend (sem duplicar todayData/recentData já processados acima)
  if (hint) {
    const dow = (hint as any)?.dayOfWeek;
    const dlw = (hint as any)?.daysLeftInWeek;
    const pc = (hint as any)?.pendingCount;
    const bc = (hint as any)?.blockedCount;
    if (dow != null || dlw != null) {
      const dayName = DIAS_SEMANA[dow ?? 0] || '';
      L.push(`\n=== CONTEXTO DO DIA ===`);
      L.push(`  Dia: ${dayName} | Dias até sábado: ${dlw ?? '?'} | Pendentes na tela: ${pc ?? '?'} | Bloqueados na tela: ${bc ?? '?'}`);
    }
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
        contextLines.push(`  [${itemName}]: ${(ctx as string).slice(0, 300)}`);
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
    L.push('\n=== 🎯 ITEM EM FOCO (usuario clicou para pedir ajuda) ===');
    L.push(`  Demanda: "${focusedItem.itemName}" | categoria: ${focusedItem.category}`);

    // ── Modo "sem nota": contexto rico pré-computado pelo frontend ──────
    if (focusedItem.noNoteMode) {
      const sl = focusedItem.statusLabel || 'sem status';
      const dn = focusedItem.dayName    || '';
      const wn = focusedItem.weekNum    || '';
      const mn = focusedItem.monthName  || '';
      L.push(`  Status: ${sl} | ${dn}, semana ${wn} de ${mn}`);

      if (focusedItem.settingsContext) {
        L.push(`  Contexto da demanda: ${focusedItem.settingsContext}`);
      }

      if (Array.isArray(focusedItem.aprendLines) && focusedItem.aprendLines.length > 0) {
        L.push('  --- APRENDIZADOS (linha por linha) ---');
        (focusedItem.aprendLines as string[]).forEach((l: string) => L.push('    ' + l));
      } else {
        L.push('  (Sem aprendizados registrados para esta demanda)');
      }

      if (Array.isArray(focusedItem.historyLines) && focusedItem.historyLines.length > 0) {
        L.push('  --- HISTORICO RECENTE (ultimas semanas) ---');
        (focusedItem.historyLines as string[]).forEach((l: string) => L.push('    ' + l));
      } else {
        L.push('  (Sem historico de atividades recente para esta demanda)');
      }

      // Instrução explícita para a IA
      const instruction = focusedItem.instruction || '';
      if (instruction) {
        L.push(`\n  ⚡ INSTRUCAO ESPECIAL PARA ESTA RESPOSTA: ${instruction}`);
      }

      L.push('\n  MODO ATIVO: ANALISE PROFUNDA SEM NOTA. Leia TODOS os aprendizados e historico acima linha por linha.');
      L.push('  Sugira lista concreta e util do que fazer HOJE. Priorize pendentes dos aprendizados.');
      L.push('  Se nao houver dados, faca 3-5 perguntas inteligentes para levantar contexto.');
      L.push('  Neste modo PODE e DEVE usar listas detalhadas — nao aplique a regra de "sem dumps".');

    // ── Modo normal: apenas aprendizados resumidos ───────────────────
    } else {
      L.push('  Baseie resposta nos aprendizados abaixo. Sugira PENDENTES. NAO sugira concluidos. Pergunte se houve aprendizado.');
      if (Array.isArray(focusedItem.notes) && focusedItem.notes.length > 0) {
        (focusedItem.notes as string[]).forEach((n: string) => L.push('    - ' + n));
      } else {
        L.push('  (Sem aprendizados — sugira acoes com base nos dados da semana)');
      }
    }
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

    L.push('\n=== STATS ===');
    L.push(`  Geral: ${totalCompleted} concluidos (${completionRate}%) | Semana: ${weekCompleted}/${weekTotal} (${weekRate}%) | Mes: ${monthCompleted}/${monthTotal} (${monthRate}%)`);
    L.push(`  Streak: ${currentStreak} dias (melhor: ${bestStreak})`);
  } catch (e) {
    // Stats são opcionais, não falhar por causa delas
  }

  return L.join('\n');
}

function buildSystemPrompt(context: string, activeItems: Record<string, ActiveItem[]>): string {
  const catRef: string[] = [];
  for (const [key, label] of [['clientes','Clientes'],['categorias','Categorias'],['atividades','Atividades']] as const) {
    const names = (activeItems[key] || []).slice(0, 6).map(i => i.name).join(', ');
    const extra = (activeItems[key] || []).length > 6 ? ', ...' : '';
    catRef.push(`"${key}" → ${names}${extra}`);
  }

  return `Assistente estrategico do app "A Segunda Lei" (produtividade). Responda em pt-BR.

## PERSONALIDADE
Consultor estrategico. Pensa antes de responder. Le notas+aprendizados, identifica padroes, prioriza.
Foco: ajudar usuario a ESCOLHER DEMANDA DO DIA → semana 100% concluida.

## REGRAS CRITICAS
- PROIBIDO dumps/planilhas/listas exaustivas. Analise, priorize, responda em texto corrido.
- Agrupe por tema/prioridade. Mencione so o relevante.
- Use NOTAS como fonte qualitativa ("Wolf teve reuniao pendente", nao "Wolf: nao-feito").
- Use APRENDIZADOS como base de conhecimento: pendentes→sugira retomar, concluidos→mencione conquista.
- Foque SEMANA ATUAL + MES. Use stats para motivar (streak, taxa).
- Quinta/sexta: ALERTE urgencia sobre pendentes.
- Use CONTEXTO DAS DEMANDAS para personalizar.
- Datas: NUNCA YYYY-MM-DD. Use "terca dia 4", "ontem". NUNCA mostre IDs.
- "a semana" = APENAS esta semana. NUNCA mencione itens fora dos ATIVOS.
- "SEM STATUS" = nao trabalhado.

## FORMATO
Resumo executivo (1-2 linhas) no inicio. Max 2-3 frases/paragrafo. Linha em branco entre blocos.
**Negrito** so para nomes. Emojis: 🔴bloqueado 🟡andamento 🟢concluido ⚪sem status.
Planos: numeros (1. 2. 3.). Markdown: ## titulos, **negrito**, listas -.

## QUICK REPLIES
Ao perguntar, ofereca botoes no final: <quick_replies>["Op1","Op2","Op3"]</quick_replies>
2-5 opcoes, max 25 chars, com emojis. Obrigatorio em perguntas de confirmacao/escolha.

## COMPORTAMENTO
CONFIRME com botoes se ambiguidade. NUNCA aja sem o usuario pedir. Excecao: contexto ja claro.

## ACOES (so no final, so quando pedido)
<actions>[{"action":"..."}]</actions>

### update_item
{"action":"update_item","category":"clientes|categorias|atividades","itemId":"id","status":"(opcional)","date":"hoje|amanha|ontem|segunda|...|YYYY-MM-DD","note":"texto"}
Categories: ${catRef.join(' | ')}
ERRADO: "pessoal","empresa". CERTO: "clientes","categorias","atividades"
- "status" OPCIONAL — so inclua se usuario PEDIR mudar. NUNCA mude por conta propria.
- "date": "hoje"(padrao), "amanha", "ontem", dia da semana, YYYY-MM-DD.
- Se item ja tem status no dia, preserve e adicione nota.

### create_aprendizado
{"action":"create_aprendizado","category":"clientes|categorias|atividades","itemId":"id","title":"titulo","content":"conteudo"}
- title+content OBRIGATORIOS.

### Quando usar:
- "anota"/"registra" → update_item | "salva aprendizado" → create_aprendizado | "marca concluido" → update_item+status
- Ambiguidade → pergunte antes. Use EXATAMENTE IDs dos ITENS ATIVOS.

DADOS:
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
