// Edge Function: calculate-ranking
// Recalcula métricas de gamificação a partir dos dados reais do user_data.
// O user_id é extraído exclusivamente do JWT — nunca do body (anti-cheat).
// Rate limit: 1 chamada por 60s por user_id (mapa em memória).

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Rate limiting: mapa em memória (user_id → timestamp da última chamada)
const rateLimitMap = new Map<string, number>();
const RATE_LIMIT_MS = 60_000; // 60 segundos

serve(async (req: Request) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      },
    });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  try {
    // Extrair JWT do header Authorization
    const authHeader = req.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'Missing or invalid Authorization header' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    const jwt = authHeader.replace('Bearer ', '');

    // Criar cliente Supabase com o JWT do usuário para extrair o user_id
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    // Cliente autenticado como usuário (para extrair user_id do token)
    const supabaseUser = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });

    const { data: { user }, error: userError } = await supabaseUser.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Invalid token' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    const userId = user.id;

    // Rate limiting por user_id
    const now = Date.now();
    const lastCall = rateLimitMap.get(userId) || 0;
    if (now - lastCall < RATE_LIMIT_MS) {
      const retryAfter = Math.ceil((RATE_LIMIT_MS - (now - lastCall)) / 1000);
      return new Response(JSON.stringify({ error: 'Rate limited', retryAfter }), {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Retry-After': String(retryAfter),
        },
      });
    }
    rateLimitMap.set(userId, now);

    // Cliente com service role key para ler user_data (contorna RLS)
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    // Ler user_data do usuário
    const { data: userData, error: dataError } = await supabaseAdmin
      .from('user_data')
      .select('data')
      .eq('user_id', userId)
      .single();

    if (dataError || !userData) {
      return new Response(JSON.stringify({ error: 'User data not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    const allData = userData.data || {};

    // Calcular métricas a partir dos dados reais
    const today = new Date();
    const todayStr = formatDateStr(today);

    // Obter todas as datas válidas (ignorar chaves especiais como _settings, _aprendizados)
    const dateKeys = Object.keys(allData).filter(k => !k.startsWith('_') && /^\d{4}-\d{2}-\d{2}$/.test(k));
    dateKeys.sort(); // ordem cronológica

    // Datas dos últimos 7 e 30 dias
    const last7 = new Set<string>();
    const last30 = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const ds = formatDateStr(d);
      last30.add(ds);
      if (i < 7) last7.add(ds);
    }

    let totalCompleted = 0;
    let totalNonSkipped = 0;
    let weeklyCompleted = 0;
    let monthlyCompleted = 0;

    // Para streak: mapear data → tem pelo menos 1 concluído?
    const daysWithCompleted = new Set<string>();

    for (const dateKey of dateKeys) {
      const dayData = allData[dateKey];
      if (!dayData || typeof dayData !== 'object') continue;

      let dayCompleted = 0;
      let dayTotal = 0;

      for (const catKey of Object.keys(dayData)) {
        const catData = dayData[catKey];
        if (!catData || typeof catData !== 'object') continue;

        for (const itemId of Object.keys(catData)) {
          const item = catData[itemId];
          // Suporta itens legados em formato string ("item": "concluido")
          const status = typeof item === 'string' ? item : item?.status;
          if (!status || status === 'none') continue;

          // Não contar "pular" nos totais
          if (status === 'pular') continue;

          dayTotal++;

          if (status === 'concluido' || status === 'concluido-ongoing') {
            dayCompleted++;
            totalCompleted++;
            if (last7.has(dateKey)) weeklyCompleted++;
            if (last30.has(dateKey)) monthlyCompleted++;
          }

          totalNonSkipped++;
        }
      }

      if (dayCompleted > 0) {
        daysWithCompleted.add(dateKey);
      }
    }

    // Calcular streaks
    const { currentStreak, bestStreak } = calculateStreaks(daysWithCompleted, todayStr);

    // Taxa de conclusão
    const completionRate = totalNonSkipped > 0
      ? Math.round((totalCompleted / totalNonSkipped) * 10000) / 100
      : 0;

    // Scores (pontos × 10 para mais granularidade)
    const weeklyScore = weeklyCompleted * 10;
    const monthlyScore = monthlyCompleted * 10;

    // Upsert no user_rankings via service role
    const { error: upsertError } = await supabaseAdmin
      .from('user_rankings')
      .upsert({
        user_id: userId,
        total_completed: totalCompleted,
        current_streak: currentStreak,
        best_streak: bestStreak,
        completion_rate: completionRate,
        weekly_score: weeklyScore,
        monthly_score: monthlyScore,
      }, { onConflict: 'user_id', ignoreDuplicates: false });

    if (upsertError) {
      console.error('Upsert error:', upsertError);
      return new Response(JSON.stringify({ error: 'Failed to update ranking' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    return new Response(JSON.stringify({
      ok: true,
      total_completed: totalCompleted,
      current_streak: currentStreak,
      best_streak: bestStreak,
      completion_rate: completionRate,
      weekly_score: weeklyScore,
      monthly_score: monthlyScore,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });

  } catch (err) {
    console.error('Edge Function error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
});

// ── Helpers ──────────────────────────────────────────────────────────

function formatDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function calculateStreaks(
  daysWithCompleted: Set<string>,
  todayStr: string
): { currentStreak: number; bestStreak: number } {
  if (daysWithCompleted.size === 0) return { currentStreak: 0, bestStreak: 0 };

  // Ordenar datas
  const sortedDates = [...daysWithCompleted].sort();

  // Best streak: maior sequência de dias consecutivos
  let bestStreak = 1;
  let currentRun = 1;

  for (let i = 1; i < sortedDates.length; i++) {
    const prev = new Date(sortedDates[i - 1] + 'T12:00:00Z');
    const curr = new Date(sortedDates[i] + 'T12:00:00Z');
    const diffDays = Math.round((curr.getTime() - prev.getTime()) / (1000 * 60 * 60 * 24));

    if (diffDays === 1) {
      currentRun++;
      if (currentRun > bestStreak) bestStreak = currentRun;
    } else {
      currentRun = 1;
    }
  }

  // Current streak: contar de hoje (ou ontem, se hoje não tiver dados) para trás
  let streak = 0;
  const checkDate = new Date(todayStr + 'T12:00:00Z');

  // Se hoje não tem dados, começar de ontem (não quebra streak)
  if (!daysWithCompleted.has(todayStr)) {
    checkDate.setDate(checkDate.getDate() - 1);
  }

  while (true) {
    const ds = formatDateStr(checkDate);
    if (daysWithCompleted.has(ds)) {
      streak++;
      checkDate.setDate(checkDate.getDate() - 1);
    } else {
      break;
    }
  }

  if (streak > bestStreak) bestStreak = streak;

  return { currentStreak: streak, bestStreak };
}
