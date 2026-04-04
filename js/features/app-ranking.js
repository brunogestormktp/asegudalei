// app-ranking.js — Mixin: Ranking / Gamificação page
// Extends HabitTrackerApp.prototype

Object.assign(HabitTrackerApp.prototype, {

    // ── State ────────────────────────────────────────────────────────────
    _rankingCache: {},          // chave "tab:page" → { data, count, timestamp }
    _rankingCacheTTL: 5 * 60 * 1000, // 5 minutos
    _rankingCurrentTab: 'global',
    _rankingCurrentPage: 0,
    _rankingPageSize: 50,
    _rankingInited: false,
    _rankingRealtimeChannel: null,

    // ── Entry point ──────────────────────────────────────────────────────
    async renderRankingView() {
        if (!this._rankingInited) {
            this._initRankingTabs();
            this._subscribeRankingRealtime();
            this._rankingInited = true;
        }
        // Throttled call to Edge Function to recalculate own stats
        this._maybeRefreshMyRanking();
        await this._renderRankingTab(this._rankingCurrentTab, 0);
    },

    // ── Tab events ───────────────────────────────────────────────────────
    _initRankingTabs() {
        const tabsContainer = document.querySelector('.ranking-tabs');
        if (!tabsContainer) return;
        tabsContainer.addEventListener('click', (e) => {
            const btn = e.target.closest('.ranking-tab');
            if (!btn) return;
            const tab = btn.dataset.tab;
            if (!tab) return;
            this._rankingCurrentTab = tab;
            this._renderRankingTab(tab, 0);
        });
    },

    // ── Render a tab ─────────────────────────────────────────────────────
    async _renderRankingTab(tab, page) {
        this._rankingCurrentTab = tab;
        this._rankingCurrentPage = page;

        // Update active tab button
        document.querySelectorAll('.ranking-tab').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === tab);
        });

        // Show loading
        const listEl = document.getElementById('rankingList');
        if (listEl) listEl.innerHTML = '<div class="ranking-loading">Carregando ranking...</div>';

        // Fetch data
        const result = await this._fetchRanking(tab, page);
        if (!result) {
            if (listEl) listEl.innerHTML = '<div class="ranking-empty">Não foi possível carregar o ranking.</div>';
            return;
        }

        // Render own card
        await this._renderMyCard();

        // Render list
        this._renderRankingList(result.data || [], tab, page);

        // Render pagination
        this._renderRankingPagination(result.count || 0, tab, page);
    },

    // ── Fetch ranking data (with cache) ──────────────────────────────────
    async _fetchRanking(tab, page) {
        const cacheKey = `${tab}:${page}`;
        const now = Date.now();
        const cached = this._rankingCache[cacheKey];
        if (cached && (now - cached.timestamp) < this._rankingCacheTTL) {
            return cached;
        }

        const sb = StorageManager.getSupabase();
        if (!sb) return null;

        const from = page * this._rankingPageSize;
        const to = from + this._rankingPageSize - 1;

        // Determine sort column
        let orderCol = 'total_completed';
        if (tab === 'weekly') orderCol = 'weekly_score';
        if (tab === 'monthly') orderCol = 'monthly_score';

        try {
            // Select only public fields — NEVER expose user_id or email
            const { data, error, count } = await sb
                .from('user_rankings')
                .select('display_name, avatar_url, total_completed, current_streak, best_streak, completion_rate, weekly_score, monthly_score', { count: 'exact' })
                .eq('show_in_ranking', true)
                .order(orderCol, { ascending: false })
                .range(from, to);

            if (error) {
                console.error('Ranking fetch error:', error);
                return null;
            }

            const result = { data: data || [], count: count || 0, timestamp: now };
            this._rankingCache[cacheKey] = result;
            return result;
        } catch (err) {
            console.error('Ranking fetch exception:', err);
            return null;
        }
    },

    // ── Render own card ──────────────────────────────────────────────────
    async _renderMyCard() {
        const container = document.getElementById('rankingMyCard');
        if (!container) return;

        const sb = StorageManager.getSupabase();
        const userId = StorageManager.getUserId();
        if (!sb || !userId) {
            container.innerHTML = '';
            return;
        }

        try {
            // RLS allows reading own row even with show_in_ranking = false
            const { data, error } = await sb
                .from('user_rankings')
                .select('display_name, avatar_url, total_completed, current_streak, best_streak, completion_rate, weekly_score, monthly_score, show_in_ranking')
                .eq('user_id', userId)
                .single();

            if (error || !data) {
                container.innerHTML = '<div class="ranking-my-card-empty">Seus dados de ranking ainda estão sendo calculados...</div>';
                return;
            }

            container.innerHTML = '';
            const card = this._buildRankingCard(data, true);
            container.appendChild(card);
        } catch (err) {
            console.error('My ranking card error:', err);
            container.innerHTML = '';
        }
    },

    // ── Build a single ranking card (DOM only, never innerHTML with user data) ──
    _buildRankingCard(row, isOwnCard) {
        const card = document.createElement('div');
        card.className = 'ranking-card' + (isOwnCard ? ' ranking-card--own' : '');

        // Avatar (initial letter or photo)
        const avatar = document.createElement('div');
        avatar.className = 'ranking-avatar';
        const displayName = row.display_name || 'Anônimo';
        if (row.avatar_url) {
            const img = document.createElement('img');
            img.src = row.avatar_url;
            img.alt = '';
            img.className = 'ranking-avatar-img';
            img.loading = 'lazy';
            avatar.appendChild(img);
        } else {
            avatar.textContent = displayName.charAt(0).toUpperCase();
        }
        card.appendChild(avatar);

        // Info block
        const info = document.createElement('div');
        info.className = 'ranking-card-info';

        const nameEl = document.createElement('div');
        nameEl.className = 'ranking-card-name';
        nameEl.textContent = displayName; // textContent — XSS safe
        info.appendChild(nameEl);

        const statsEl = document.createElement('div');
        statsEl.className = 'ranking-card-stats';

        const completedEl = document.createElement('span');
        completedEl.className = 'ranking-stat';
        completedEl.textContent = `✅ ${row.total_completed || 0} concluídos`;
        statsEl.appendChild(completedEl);

        const streakEl = document.createElement('span');
        streakEl.className = 'ranking-stat';
        streakEl.textContent = `🔥 ${row.current_streak || 0} dias`;
        statsEl.appendChild(streakEl);

        const bestEl = document.createElement('span');
        bestEl.className = 'ranking-stat';
        bestEl.textContent = `⭐ Recorde: ${row.best_streak || 0}`;
        statsEl.appendChild(bestEl);

        const rateEl = document.createElement('span');
        rateEl.className = 'ranking-stat';
        rateEl.textContent = `📊 ${Number(row.completion_rate || 0).toFixed(1)}%`;
        statsEl.appendChild(rateEl);

        info.appendChild(statsEl);

        // Weekly / Monthly scores
        const scoresEl = document.createElement('div');
        scoresEl.className = 'ranking-card-scores';

        const weekEl = document.createElement('span');
        weekEl.className = 'ranking-score-badge';
        weekEl.textContent = `Semana: ${row.weekly_score || 0}`;
        scoresEl.appendChild(weekEl);

        const monthEl = document.createElement('span');
        monthEl.className = 'ranking-score-badge';
        monthEl.textContent = `Mês: ${row.monthly_score || 0}`;
        scoresEl.appendChild(monthEl);

        info.appendChild(scoresEl);

        if (isOwnCard && row.show_in_ranking === false) {
            const hiddenBadge = document.createElement('span');
            hiddenBadge.className = 'ranking-hidden-badge';
            hiddenBadge.textContent = '👁️ Oculto no ranking';
            info.appendChild(hiddenBadge);
        }

        card.appendChild(info);
        return card;
    },

    // ── Render ranking list ──────────────────────────────────────────────
    _renderRankingList(rows, tab, page) {
        const listEl = document.getElementById('rankingList');
        if (!listEl) return;
        listEl.innerHTML = '';

        if (!rows || rows.length === 0) {
            listEl.innerHTML = '<div class="ranking-empty">Nenhum usuário no ranking ainda.</div>';
            return;
        }

        const startPos = page * this._rankingPageSize + 1;

        rows.forEach((row, idx) => {
            const position = startPos + idx;
            const item = document.createElement('div');
            item.className = 'ranking-list-item';
            if (position === 1) item.classList.add('ranking-top-1');
            else if (position === 2) item.classList.add('ranking-top-2');
            else if (position === 3) item.classList.add('ranking-top-3');

            // Rank number / medal
            const rankEl = document.createElement('div');
            rankEl.className = 'ranking-rank';
            if (position === 1) rankEl.textContent = '🥇';
            else if (position === 2) rankEl.textContent = '🥈';
            else if (position === 3) rankEl.textContent = '🥉';
            else rankEl.textContent = `#${position}`;
            item.appendChild(rankEl);

            // Avatar
            const avatar = document.createElement('div');
            avatar.className = 'ranking-avatar ranking-avatar--sm';
            const displayName = row.display_name || 'Anônimo';
            if (row.avatar_url) {
                const img = document.createElement('img');
                img.src = row.avatar_url;
                img.alt = '';
                img.className = 'ranking-avatar-img';
                img.loading = 'lazy';
                avatar.appendChild(img);
            } else {
                avatar.textContent = displayName.charAt(0).toUpperCase();
            }
            item.appendChild(avatar);

            // Name
            const nameEl = document.createElement('div');
            nameEl.className = 'ranking-item-name';
            nameEl.textContent = displayName; // textContent — XSS safe
            item.appendChild(nameEl);

            // Score
            const scoreWrap = document.createElement('div');
            scoreWrap.className = 'ranking-item-score-wrap';

            let mainScore = row.total_completed || 0;
            let mainLabel = 'concluídos';
            if (tab === 'weekly') { mainScore = row.weekly_score || 0; mainLabel = 'pts/semana'; }
            if (tab === 'monthly') { mainScore = row.monthly_score || 0; mainLabel = 'pts/mês'; }

            const scoreNum = document.createElement('span');
            scoreNum.className = 'ranking-item-score';
            scoreNum.textContent = String(mainScore);
            scoreWrap.appendChild(scoreNum);

            const scoreLabel = document.createElement('span');
            scoreLabel.className = 'ranking-item-score-label';
            scoreLabel.textContent = mainLabel;
            scoreWrap.appendChild(scoreLabel);

            item.appendChild(scoreWrap);

            // Streak badge
            const streakBadge = document.createElement('span');
            streakBadge.className = 'ranking-item-streak';
            streakBadge.textContent = `🔥${row.current_streak || 0}`;
            item.appendChild(streakBadge);

            listEl.appendChild(item);
        });
    },

    // ── Pagination ───────────────────────────────────────────────────────
    _renderRankingPagination(count, tab, page) {
        const container = document.getElementById('rankingPagination');
        if (!container) return;
        container.innerHTML = '';

        const totalPages = Math.ceil(count / this._rankingPageSize);
        if (totalPages <= 1) return;

        if (page > 0) {
            const prevBtn = document.createElement('button');
            prevBtn.className = 'ranking-page-btn';
            prevBtn.textContent = '← Anterior';
            prevBtn.addEventListener('click', () => this._renderRankingTab(tab, page - 1));
            container.appendChild(prevBtn);
        }

        const pageInfo = document.createElement('span');
        pageInfo.className = 'ranking-page-info';
        pageInfo.textContent = `Página ${page + 1} de ${totalPages}`;
        container.appendChild(pageInfo);

        if (page < totalPages - 1) {
            const nextBtn = document.createElement('button');
            nextBtn.className = 'ranking-page-btn';
            nextBtn.textContent = 'Próxima →';
            nextBtn.addEventListener('click', () => this._renderRankingTab(tab, page + 1));
            container.appendChild(nextBtn);
        }
    },

    // ── Throttled call to Edge Function ──────────────────────────────────
    _maybeRefreshMyRanking() {
        const THROTTLE_KEY = 'ranking-last-calc';
        const THROTTLE_MS = 60_000; // 60 seconds
        const now = Date.now();
        const last = parseInt(localStorage.getItem(THROTTLE_KEY) || '0', 10);

        if (now - last < THROTTLE_MS) return;
        localStorage.setItem(THROTTLE_KEY, String(now));
        this._callCalculateRanking();
    },

    async _callCalculateRanking() {
        const sb = StorageManager.getSupabase();
        if (!sb) return;

        try {
            // IMPORTANTE: usar getSession(), NÃO refreshSession()
            // refreshSession() conflita com o auto-refresh do SDK (causa 401 race condition)
            const { data: { session } } = await sb.auth.getSession();
            if (!session?.access_token) return;

            const resp = await fetch(
                `${SUPABASE_CONFIG.url}/functions/v1/calculate-ranking`,
                {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${session.access_token}`,
                        'Content-Type': 'application/json',
                    },
                }
            );

            if (resp.status === 429) {
                console.log('Ranking EF rate limited');
                return;
            }

            // Se ainda 401 (token em processo de refresh), aguardar e tentar uma vez
            if (resp.status === 401) {
                console.log('Ranking EF 401 — aguardando refresh e retentando...');
                await new Promise(r => setTimeout(r, 2000));
                const { data: { session: fresh } } = await sb.auth.getSession();
                if (!fresh?.access_token) return;

                const retry = await fetch(
                    `${SUPABASE_CONFIG.url}/functions/v1/calculate-ranking`,
                    {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${fresh.access_token}`,
                            'Content-Type': 'application/json',
                        },
                    }
                );
                if (!retry.ok) {
                    console.warn('Ranking EF retry failed:', retry.status);
                    return;
                }
            } else if (!resp.ok) {
                const body = await resp.text();
                console.warn('Ranking EF error:', resp.status, body);
                return;
            }

            this._rankingCache = {};
            console.log('✅ Ranking recalculado via Edge Function');
        } catch (err) {
            console.error('Ranking EF call failed:', err);
        }
    },

    // ── Realtime subscription ────────────────────────────────────────────
    _subscribeRankingRealtime() {
        const sb = StorageManager.getSupabase();
        if (!sb) return;

        // Avoid duplicate subscriptions
        if (this._rankingRealtimeChannel) return;

        try {
            this._rankingRealtimeChannel = sb
                .channel('ranking-changes')
                .on('postgres_changes', {
                    event: '*',
                    schema: 'public',
                    table: 'user_rankings',
                }, () => {
                    // Invalidate cache and re-render if ranking view is active
                    this._rankingCache = {};
                    if (this.currentView === 'ranking') {
                        this._renderRankingTab(this._rankingCurrentTab, this._rankingCurrentPage);
                    }
                })
                .subscribe();
            console.log('📡 Ranking Realtime subscription active');
        } catch (err) {
            console.error('Ranking realtime subscription error:', err);
        }
    },

    // ── Debounced ranking refresh (called on every status change) ────────
    // Groups multiple quick status changes into a single Edge Function call.
    _rankingRefreshTimer: null,
    _RANKING_REFRESH_DEBOUNCE: 5000, // 5 seconds after last status change

    _debouncedRankingRefresh() {
        if (this._rankingRefreshTimer) {
            clearTimeout(this._rankingRefreshTimer);
        }
        this._rankingRefreshTimer = setTimeout(async () => {
            this._rankingRefreshTimer = null;
            console.log('📊 Ranking refresh triggered after status change');
            // Camada 1: atualização instantânea via dados locais (sem JWT timing issues)
            await this._updateMyRankingFromLocal();
            // Camada 2: EF roda em background para calcular streak corretamente
            // Não awaitar — não bloqueia a UI, falha silenciosamente se JWT inválido
            this._callCalculateRanking();
        }, this._RANKING_REFRESH_DEBOUNCE);
    },

    // ── Camada 1: Atualização instantânea do ranking via dados locais ────
    // Calcula métricas (total_completed, scores, completion_rate) direto dos
    // dados locais e faz upsert em user_rankings via Supabase JS client.
    // Sem Edge Function → sem JWT timing issues (o SDK gerencia o token).
    // current_streak e best_streak NÃO são recalculados aqui (fica a cargo do EF).
    async _updateMyRankingFromLocal() {
        const sb = StorageManager.getSupabase();
        const userId = StorageManager.getUserId();
        if (!sb || !userId) return;

        const blob = await StorageManager.getData() || {};
        const today = new Date();
        const todayStr = today.toISOString().slice(0, 10);

        // Janelas de tempo
        const d7 = new Date(today); d7.setDate(today.getDate() - 6);
        const d30 = new Date(today); d30.setDate(today.getDate() - 29);
        const week7Str = d7.toISOString().slice(0, 10);
        const month30Str = d30.toISOString().slice(0, 10);

        let totalCompleted = 0, totalNonSkipped = 0;
        let weeklyCompleted = 0, monthlyCompleted = 0;

        for (const dateKey of Object.keys(blob)) {
            if (dateKey.startsWith('_') || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) continue;
            const dayData = blob[dateKey];
            if (!dayData || typeof dayData !== 'object') continue;

            for (const cat of Object.keys(dayData)) {
                const catData = dayData[cat];
                if (!catData || typeof catData !== 'object') continue;

                for (const itemId of Object.keys(catData)) {
                    const item = catData[itemId];
                    const status = typeof item === 'string' ? item : (item?.status || 'none');
                    if (!status || status === 'none' || status === 'pular') continue;

                    totalNonSkipped++;

                    if (status === 'concluido' || status === 'concluido-ongoing') {
                        totalCompleted++;
                        if (dateKey >= week7Str && dateKey <= todayStr) weeklyCompleted++;
                        if (dateKey >= month30Str && dateKey <= todayStr) monthlyCompleted++;
                    }
                }
            }
        }

        const completionRate = totalNonSkipped > 0
            ? Math.round((totalCompleted / totalNonSkipped) * 10000) / 100
            : 0;

        try {
            await sb.from('user_rankings').upsert({
                user_id: userId,
                total_completed: totalCompleted,
                completion_rate: completionRate,
                weekly_score: weeklyCompleted * 10,
                monthly_score: monthlyCompleted * 10,
                // current_streak e best_streak ficam a cargo do Edge Function
                updated_at: new Date().toISOString(),
            }, { onConflict: 'user_id' });

            // Invalida cache para próxima leitura buscar valores frescos
            this._rankingCache = {};
            console.log('📊 Ranking local atualizado:', totalCompleted, 'concluídos');
        } catch (err) {
            console.warn('Ranking local update error:', err);
        }
    },

});
