// LocalStorage management with Supabase sync
const StorageManager = {
    STORAGE_KEY: 'habit-tracker-data',
    BACKUP_KEY:  'habit-tracker-data-backup',   // backup automático
    syncInProgress: false,
    lastSyncTime: null,
    syncReady: false,   // true após forceSyncFromSupabase completar (ou Supabase indisponível)
    _syncTimer: null,

    // ID único desta instância em memória — gerado a cada carregamento da página.
    // NÃO usa sessionStorage/localStorage para evitar que dois dispositivos herdem o mesmo ID.
    // Combina múltiplas fontes de entropia para garantir unicidade real.
    _deviceId: 'dev-' + Math.random().toString(36).slice(2, 10)
                      + Math.random().toString(36).slice(2, 10)
                      + '-' + Date.now(),

    // Get Supabase client
    getSupabase() {
        return window._supabaseClient || window.getSupabaseClient?.();
    },

    // Get current user ID
    getUserId() {
        return window.getCurrentUserId?.();
    },

    // ─── Merge profundo: nunca perde dados já existentes ────────────────
    // Estratégia: para cada data > categoria > item, mantém o registro
    // com updatedAt mais recente. Nunca apaga, apenas mescla.
    // Chaves especiais (_settings, _aprendizados) usam lógica própria.
    deepMerge(base, incoming) {
        if (!incoming || typeof incoming !== 'object') return base;
        const result = { ...base };

        // _settings: resolver por updatedAt no nível raiz (objeto único)
        if (incoming['_settings'] !== undefined) {
            const baseTs  = result['_settings']?.updatedAt  ? new Date(result['_settings'].updatedAt).getTime()  : 0;
            const incomTs = incoming['_settings']?.updatedAt ? new Date(incoming['_settings'].updatedAt).getTime() : 0;
            if (incomTs > baseTs || !result['_settings']) {
                result['_settings'] = incoming['_settings'];
            }
        }

        // _aprendizados: merge nota-a-nota por updatedAt (nunca tem updatedAt no raiz)
        if (incoming['_aprendizados'] !== undefined) {
            if (!result['_aprendizados']) {
                result['_aprendizados'] = incoming['_aprendizados'];
            } else {
                result['_aprendizados'] = this._mergeAprendizados(
                    result['_aprendizados'],
                    incoming['_aprendizados']
                );
            }
        }

        // _aiConversations: merge por id, mantém conversa com updatedAt mais recente
        if (incoming['_aiConversations'] !== undefined) {
            const baseArr = Array.isArray(result['_aiConversations']) ? result['_aiConversations'] : [];
            const incomArr = Array.isArray(incoming['_aiConversations']) ? incoming['_aiConversations'] : [];
            const map = new Map();
            for (const c of baseArr) { if (c?.id) map.set(c.id, c); }
            for (const c of incomArr) {
                if (!c?.id) continue;
                const existing = map.get(c.id);
                if (!existing || (c.updatedAt || 0) > (existing.updatedAt || 0)) {
                    map.set(c.id, c);
                }
            }
            result['_aiConversations'] = Array.from(map.values())
                .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
                .slice(0, 30);
        }

        const SPECIAL_KEYS = ['_settings', '_aprendizados', '_aiConversations'];

        for (const dateKey of Object.keys(incoming)) {
            // Ignorar chaves especiais já tratadas acima
            if (SPECIAL_KEYS.includes(dateKey)) continue;

            if (!result[dateKey]) {
                // Data nova no incoming — adicionar inteira
                result[dateKey] = incoming[dateKey];
                continue;
            }
            // Data existe em ambos — mesclar por categoria
            const mergedDate = { ...result[dateKey] };
            for (const cat of Object.keys(incoming[dateKey])) {
                if (!mergedDate[cat]) {
                    mergedDate[cat] = incoming[dateKey][cat];
                    continue;
                }
                // Categoria existe em ambos — mesclar por item
                const mergedCat = { ...mergedDate[cat] };
                for (const itemId of Object.keys(incoming[dateKey][cat])) {
                    const incomingItem = incoming[dateKey][cat][itemId];
                    const existingItem = mergedCat[itemId];

                    if (!existingItem) {
                        // Item novo — adicionar
                        mergedCat[itemId] = incomingItem;
                    } else {
                        // Item existe em ambos — manter o mais recente por updatedAt
                        const existTs = existingItem?.updatedAt
                            ? new Date(existingItem.updatedAt).getTime()
                            : 0;
                        const incomTs = incomingItem?.updatedAt
                            ? new Date(incomingItem.updatedAt).getTime()
                            : 0;

                        if (incomTs > existTs) {
                            mergedCat[itemId] = incomingItem;
                        }
                        // Se existente for mais recente ou igual, mantém o local
                    }
                }
                mergedDate[cat] = mergedCat;
            }
            result[dateKey] = mergedDate;
        }
        return result;
    },

    // ─── Verificar se objeto tem dados reais ────────────────────────────
    hasRealData(data) {
        if (!data || typeof data !== 'object') return false;
        return Object.keys(data).length > 0;
    },

    // Get all data — sempre do localStorage (rápido), Supabase só para sync
    async getData() {
        const raw = localStorage.getItem(this.STORAGE_KEY);
        if (raw) {
            try { return JSON.parse(raw); } catch { /* corrompido */ }
        }
        // Tentar recuperar do backup automático
        const backup = localStorage.getItem(this.BACKUP_KEY);
        if (backup) {
            // 🔒 SEGURANÇA: verificar se o backup pertence ao usuário atual
            const backupUid = localStorage.getItem('_data_backup_uid');
            const currentUid = this.getUserId();
            if (backupUid && currentUid && backupUid !== currentUid) {
                console.warn('🔒 [SEGURANÇA] Backup de outro usuário detectado — descartando para proteger dados');
                localStorage.removeItem(this.BACKUP_KEY);
                localStorage.removeItem('_data_backup_uid');
                return {};
            }
            try {
                const recovered = JSON.parse(backup);
                console.warn('⚠️ Dados principais ausentes — recuperando do backup automático');
                localStorage.setItem(this.STORAGE_KEY, backup);
                return recovered;
            } catch { /* backup também corrompido */ }
        }
        return {};
    },

    // Save all data: localStorage imediatamente + Supabase debounced (1500ms)
    async saveData(data, immediate = false) {
        // Proteção: nunca salvar objeto vazio se já houver dados
        if (!this.hasRealData(data)) {
            const existing = await this.getData();
            if (this.hasRealData(existing)) {
                console.warn('⛔ saveData bloqueado: tentativa de salvar dados vazios sobre dados existentes');
                return;
            }
        }

        // Salvar no localStorage principal — SEMPRE síncrono e imediato
        const json = JSON.stringify(data);
        localStorage.setItem(this.STORAGE_KEY, json);

        // Backup automático separado (sempre atualizado junto)
        localStorage.setItem(this.BACKUP_KEY, json);

        // 🔒 SEGURANÇA: marcar dono do backup com o user ID atual
        const ownerId = this.getUserId();
        if (ownerId) {
            localStorage.setItem('_data_backup_uid', ownerId);
        }

        const userId = this.getUserId();
        if (!userId) return;

        if (immediate) {
            // Push imediato (notas, status) — cancela debounce pendente
            clearTimeout(this._syncTimer);
            this._pushToSupabase(data);
        } else {
            // Debounce para operações em lote (ex: rollover de meia-noite)
            clearTimeout(this._syncTimer);
            this._syncTimer = setTimeout(() => this._pushToSupabase(data), 1500);
        }
    },

    // Push data to Supabase (internal)
    async _pushToSupabase(data) {
        if (this.syncInProgress) {
            // Se já há um sync em andamento, aguardar e tentar novamente
            await new Promise(resolve => setTimeout(resolve, 500));
            if (this.syncInProgress) {
                // Agendar retry após o sync atual terminar
                setTimeout(() => this._pushToSupabase(data), 600);
                return;
            }
        }
        if (!this.hasRealData(data)) {
            console.warn('⛔ _pushToSupabase bloqueado: dados vazios');
            return;
        }
        this.syncInProgress = true;
        // Marcar este push com o deviceId da sessão atual.
        // O campo _lastDeviceId fica dentro do JSON (o banco não o altera),
        // então o Realtime pode ignorar eventos gerados por ESTE dispositivo.
        const dataWithDevice = { ...data, _lastDeviceId: this._deviceId };
        try {
            const supabase = this.getSupabase();
            const userId = this.getUserId();
            if (supabase && userId) {
                const { error } = await supabase
                    .from('user_data')
                    .upsert({
                        user_id: userId,
                        data: dataWithDevice
                    }, { onConflict: 'user_id' });

                if (error) {
                    if (error.code === '404' || error.message?.includes('404') || error.details?.includes('relation') || error.hint?.includes('table')) {
                        console.warn('Tabela user_data não encontrada no Supabase. Execute o supabase-schema.sql no painel do Supabase.');
                    } else {
                        console.error('Error syncing to Supabase:', error);
                    }
                } else {
                    this.lastSyncTime = new Date();
                    console.log('Synced to Supabase ✓');
                }
            }
        } catch (error) {
            console.error('Error syncing to Supabase:', error);
        } finally {
            this.syncInProgress = false;
        }
    },

    // Get data for a specific date
    async getDateData(dateStr) {
        const allData = await this.getData();
        return allData[dateStr] || {};
    },

    // Save status for a specific item on a specific date
    async saveItemStatus(dateStr, category, itemId, status, note = '', links = null) {
        const allData = await this.getData();
        
        if (!allData[dateStr]) allData[dateStr] = {};
        if (!allData[dateStr][category]) allData[dateStr][category] = {};
        
        // Preserve existing links and attention if not explicitly provided
        const existing = allData[dateStr][category][itemId];
        const existingLinks = (existing && typeof existing === 'object') ? (existing.links || []) : [];
        const existingAttention = (existing && typeof existing === 'object') ? (existing.attention || false) : false;

        allData[dateStr][category][itemId] = {
            status: status,
            note: note,
            links: links !== null ? links : existingLinks,
            attention: existingAttention,
            updatedAt: new Date().toISOString()
        };
        
        // immediate=true: push para Supabase sem debounce — nota nunca se perde
        await this.saveData(allData, true);
    },

    // Toggle attention flag for a specific item on a specific date
    async toggleAttention(dateStr, category, itemId) {
        const allData = await this.getData();
        if (!allData[dateStr]) allData[dateStr] = {};
        if (!allData[dateStr][category]) allData[dateStr][category] = {};

        const existing = allData[dateStr][category][itemId];
        if (!existing || typeof existing === 'string') {
            const status = (typeof existing === 'string') ? existing : 'none';
            allData[dateStr][category][itemId] = {
                status: status,
                note: '',
                links: [],
                attention: true,
                updatedAt: new Date().toISOString()
            };
        } else {
            existing.attention = !existing.attention;
            existing.updatedAt = new Date().toISOString();
        }

        await this.saveData(allData, true);
        return allData[dateStr][category][itemId].attention;
    },

    // Get status for a specific item on a specific date
    async getItemStatus(dateStr, category, itemId) {
        const dateData = await this.getDateData(dateStr);
        const itemData = dateData[category]?.[itemId];
        
        if (!itemData) return { status: 'none', note: '', links: [], attention: false };
        
        // Handle old format (just status string)
        if (typeof itemData === 'string') return { status: itemData, note: '', links: [], attention: false };
        
        return {
            status: itemData.status || 'none',
            note: itemData.note || '',
            links: itemData.links || [],
            attention: itemData.attention || false
        };
    },

    // Get all dates with data
    async getAllDates() {
        const allData = await this.getData();
        return Object.keys(allData).sort().reverse();
    },

    // Get data for a date range
    async getDateRangeData(startDate, endDate) {
        const allData = await this.getData();
        const result = {};
        // Compara strings no formato YYYY-MM-DD para evitar bug de timezone UTC
        // (new Date("2026-03-31") retorna UTC midnight, que no Brasil (UTC-3) vira 30/03 21:00 local)
        const toStr = (d) => {
            const y = d.getFullYear();
            const m = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            return `${y}-${m}-${day}`;
        };
        const startStr = toStr(startDate);
        const endStr = toStr(endDate);
        for (const dateStr in allData) {
            if (dateStr >= startStr && dateStr <= endStr) {
                result[dateStr] = allData[dateStr];
            }
        }
        return result;
    },

    // Calculate statistics for a period
    async calculateStats(startDate, endDate) {
        const rangeData = await this.getDateRangeData(startDate, endDate);
        const stats = {
            totalDays: Object.keys(rangeData).length,
            byCategory: {},
            overall: { total: 0, completed: 0, inProgress: 0, notDone: 0, skipped: 0 }
        };

        ['clientes', 'categorias', 'atividades'].forEach(cat => {
            stats.byCategory[cat] = {
                total: 0, completed: 0, inProgress: 0, notDone: 0, skipped: 0, completionRate: 0
            };
        });

        for (const dateStr in rangeData) {
            const dayData = rangeData[dateStr];
            for (const category in dayData) {
                const categoryData = dayData[category];
                for (const itemId in categoryData) {
                    const itemData = categoryData[itemId];
                    const status = typeof itemData === 'string' ? itemData : itemData.status;
                    stats.byCategory[category].total++;
                    stats.overall.total++;
                    if (status === 'concluido' || status === 'concluido-ongoing') {
                        stats.byCategory[category].completed++;
                        stats.overall.completed++;
                    } else if (status === 'em-andamento' || status === 'parcialmente') {
                        stats.byCategory[category].inProgress++;
                        stats.overall.inProgress++;
                    } else if (status === 'nao-feito' || status === 'bloqueado') {
                        stats.byCategory[category].notDone++;
                        stats.overall.notDone++;
                    } else if (status === 'pular') {
                        stats.byCategory[category].skipped++;
                        stats.overall.skipped++;
                    }
                }
            }
        }

        for (const cat in stats.byCategory) {
            const catStats = stats.byCategory[cat];
            const totalNotSkipped = catStats.total - catStats.skipped;
            if (totalNotSkipped > 0)
                catStats.completionRate = ((catStats.completed / totalNotSkipped) * 100).toFixed(1);
        }
        const overallNotSkipped = stats.overall.total - stats.overall.skipped;
        if (overallNotSkipped > 0)
            stats.overall.completionRate = ((stats.overall.completed / overallNotSkipped) * 100).toFixed(1);

        return stats;
    },

    // Export data as JSON
    async exportData() {
        const data = await this.getData();
        const dataStr = JSON.stringify(data, null, 2);
        const blob = new Blob([dataStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const now = new Date();
        const y = now.getFullYear();
        const m = String(now.getMonth() + 1).padStart(2, '0');
        const d = String(now.getDate()).padStart(2, '0');
        a.download = `habit-tracker-backup-${y}-${m}-${d}.json`;
        a.click();
        URL.revokeObjectURL(url);
    },

    // Import data from JSON
    async importData(jsonStr) {
        try {
            const incoming = JSON.parse(jsonStr);
            // Merge com dados existentes em vez de sobrescrever
            const existing = await this.getData();
            const merged = this.deepMerge(existing, incoming);
            await this.saveData(merged);
            return true;
        } catch (e) {
            console.error('Error importing data:', e);
            return false;
        }
    },

    // Clear all data (requer confirmação dupla)
    async clearAllData() {
        if (confirm('Tem certeza que deseja apagar todos os dados? Esta ação não pode ser desfeita.')) {
            localStorage.removeItem(this.STORAGE_KEY);
            localStorage.removeItem(this.BACKUP_KEY);
            
            const userId = this.getUserId();
            if (userId) {
                try {
                    const supabase = this.getSupabase();
                    if (supabase) {
                        await supabase.from('user_data').delete().eq('user_id', userId);
                    }
                } catch (error) {
                    console.error('Error clearing Supabase data:', error);
                }
            }
            return true;
        }
        return false;
    },

    // ─── Flush imediato para o Supabase (antes do logout) ───────────────
    async flushToSupabase() {
        const data = await this.getData();
        if (!this.hasRealData(data)) return;
        clearTimeout(this._syncTimer); // cancelar debounce pendente
        await this._pushToSupabase(data);
    },

    // ─── Aprendizados: salvar no mesmo data do Supabase ─────────────────
    // Os dados ficam em data['_aprendizados'] — nunca são apagados pelo merge.
    // immediate=true garante push sem debounce para que outros dispositivos
    // recebam a atualização via Realtime o mais rápido possível.
    async saveAprendizados(aprendizadosObj) {
        const allData = await this.getData();
        allData['_aprendizados'] = aprendizadosObj;
        await this.saveData(allData, true); // immediate=true: sem debounce
    },

    async getAprendizados() {
        const allData = await this.getData();
        return allData['_aprendizados'] || null;
    },

    // ─── AI Conversations: salvar no Supabase via user_data._aiConversations ──
    async saveAIConversations(conversations) {
        const allData = await this.getData();
        // Limitar a 30 conversas, cada conversa max 40 mensagens
        const trimmed = (conversations || []).slice(0, 30).map(c => ({
            ...c,
            messages: (c.messages || []).slice(-40),
        }));
        allData['_aiConversations'] = trimmed;
        await this.saveData(allData, true); // immediate push
    },

    async getAIConversations() {
        const allData = await this.getData();
        return allData['_aiConversations'] || [];
    },

    // ─── Limpar TODOS os dados locais de outra conta ────────────────────
    // Chamado sempre que um usuário diferente faz login neste dispositivo.
    // Garante que nenhum dado de outra pessoa apareça na sessão atual.
    _clearForeignLocalData(newUserId) {
        const keysToCheck = [
            { dataKey: this.STORAGE_KEY,      uidKey: '_data_backup_uid' },
            { dataKey: this.BACKUP_KEY,        uidKey: '_data_backup_uid' },
            { dataKey: this.SETTINGS_KEY,      uidKey: '_settings_backup_uid' },
            { dataKey: 'aprendizadosData',     uidKey: '_aprendizados_backup_uid' },
        ];

        let foundForeign = false;

        for (const { dataKey, uidKey } of keysToCheck) {
            const ownerUid = localStorage.getItem(uidKey);
            // Se existe uma tag E ela pertence a outro usuário → remover
            if (ownerUid && ownerUid !== newUserId) {
                localStorage.removeItem(dataKey);
                foundForeign = true;
            }
        }

        // Limpar todas as tags de proprietário dos dados removidos
        if (foundForeign) {
            localStorage.removeItem('_data_backup_uid');
            localStorage.removeItem('_settings_backup_uid');
            localStorage.removeItem('_aprendizados_backup_uid');
        }

        // Caso extremo: dados sem nenhuma tag de proprietário (legacy/sem tag).
        // Nesses casos NÃO limpamos — são dados que existiam antes desta proteção.
        // Eles serão descartados pelo deepMerge se conflitarem com dados do Supabase.

        if (foundForeign) {
            console.warn(`🔒 [SEGURANÇA] Dados de outro usuário removidos do localStorage antes do login de ${newUserId}`);
        }
    },

    // ─── Force sync from Supabase (após login) ──────────────────────────
    // Usa merge profundo: nunca sobrescreve dados locais mais recentes
    async forceSyncFromSupabase() {
        const userId = this.getUserId();
        if (!userId) {
            console.log('No user logged in');
            this.syncReady = true;
            return false;
        }

        // 🔒 SEGURANÇA CRÍTICA: limpar dados de outra conta ANTES de qualquer merge.
        // Isso garante que a nova sessão começa com o localStorage limpo de dados alheios.
        this._clearForeignLocalData(userId);

        try {
            const supabase = this.getSupabase();
            if (supabase) {
                const { data: remoteData, error } = await supabase
                    .from('user_data')
                    .select('data')
                    .eq('user_id', userId)
                    .single();

                if (!error && remoteData?.data) {
                    // Ler dados locais atuais — agora garantidamente sem dados de outra conta
                    const localRaw = localStorage.getItem(this.STORAGE_KEY);
                    const local = localRaw ? JSON.parse(localRaw) : {};

                    // Incluir _settings local no objeto base para o deepMerge comparar corretamente
                    try {
                        const localSettingsRaw = localStorage.getItem(this.SETTINGS_KEY);
                        if (localSettingsRaw && !local['_settings']) {
                            local['_settings'] = JSON.parse(localSettingsRaw);
                        }
                    } catch(e) {}

                    // Remover _lastDeviceId do remoto antes de mesclar (não é dado do app)
                    const { _lastDeviceId: _ignored, ...cleanRemote } = remoteData.data;

                    // MERGE PROFUNDO: local + remoto, o mais recente por item vence
                    // deepMerge trata _settings por updatedAt e _aprendizados nota-a-nota
                    const merged = this.deepMerge(local, cleanRemote);

                    // Salvar merged APENAS no localStorage — sem push de volta ao Supabase
                    // (evita loop: forceSyncFromSupabase → push → Realtime event → forceSyncFromSupabase)
                    const mergedJson = JSON.stringify(merged);
                    localStorage.setItem(this.STORAGE_KEY, mergedJson);
                    localStorage.setItem(this.BACKUP_KEY, mergedJson);
                    // 🔒 Marcar dono do backup com userId após sync bem-sucedido
                    localStorage.setItem('_data_backup_uid', userId);

                    if (merged['_aprendizados']) {
                        try {
                            localStorage.setItem('aprendizadosData', JSON.stringify(merged['_aprendizados']));
                            localStorage.setItem('_aprendizados_backup_uid', userId);
                        } catch(e) {}
                    } else if (cleanRemote['_aprendizados']) {
                        // Caso raro: deepMerge não incluiu _aprendizados — garantir via cópia direta
                        try {
                            localStorage.setItem('aprendizadosData', JSON.stringify(cleanRemote['_aprendizados']));
                            localStorage.setItem('_aprendizados_backup_uid', userId);
                        } catch(e) {}
                    }

                    // Aplicar _settings vencedor (já resolvido pelo deepMerge)
                    if (merged['_settings']) {
                        try {
                            localStorage.setItem(this.SETTINGS_KEY, JSON.stringify(merged['_settings']));
                            localStorage.setItem('_settings_backup_uid', userId);
                            console.log('✅ Configurações sincronizadas do Supabase');
                        } catch(e) {}
                    }

                    console.log('✅ Data merged from Supabase (deep merge, no data lost)');
                    return true;
                } else if (error && error.code !== 'PGRST116') {
                    console.error('Error fetching from Supabase:', error);
                    return false;
                } else if (error?.code === 'PGRST116') {
                    // Nenhum dado no Supabase ainda para este usuário — conta nova e vazia.
                    // _clearForeignLocalData() já limpou qualquer resíduo de outra conta.
                    // Se ainda restar dados locais sem tag (legacy), fazer push para o Supabase.
                    console.log('Conta nova: sem dados no Supabase. Iniciando sessão limpa.');
                    const local = await this.getData();
                    if (this.hasRealData(local)) {
                        // Só fazer push se os dados locais pertencem a este usuário (ou não têm tag)
                        const backupUid = localStorage.getItem('_data_backup_uid');
                        if (!backupUid || backupUid === userId) {
                            console.log('Fazendo push dos dados locais (sem tag) para o Supabase');
                            await this._pushToSupabase(local);
                        }
                    }
                    return true;
                }
            }
        } catch (error) {
            console.error('Error syncing from Supabase:', error);
            return false;
        } finally {
            this.syncReady = true;
        }
        return true;
    },

    // ─── Sincronização entre dispositivos via polling ────────────────────
    // Estratégia: polling a cada 10s — simples, confiável, sem dependência de
    // WebSocket (Supabase Realtime tem limite de canais no free tier e causa
    // CHANNEL_ERROR loops que interrompem a sync depois de alguns minutos).
    _pollTimer: null,
    _pollUserId: null,
    _lastKnownRemoteAt: null,
    _realtimeSyncing: false,  // flag usada por app.js para não disparar push durante re-render

    startRealtime(userId) {
        // Alias para compatibilidade — delega para startPolling
        this.startPolling(userId);
    },

    stopRealtime() {
        this.stopPolling();
    },

    startPolling(userId) {
        if (!userId) return;
        // Idempotente: se já está rodando para o mesmo userId, não reiniciar
        if (this._pollTimer && this._pollUserId === userId) return;
        // Parar timer anterior se era de outro userId
        this.stopPolling();

        this._pollUserId = userId;
        console.log('🔄 Sync ativo (polling 30s)');

        // Executar imediatamente na primeira vez para pegar mudanças recentes
        this._doPoll(userId);

        this._pollTimer = setInterval(() => this._doPoll(userId), 30000);
    },

    stopPolling() {
        if (this._pollTimer) {
            clearInterval(this._pollTimer);
            this._pollTimer = null;
        }
        this._pollUserId = null;
        console.log('🔄 Sync pausado');
    },

    async _doPoll(userId) {
        const supabase = this.getSupabase();
        if (!supabase || !userId) return;
        try {
            const { data: row, error } = await supabase
                .from('user_data')
                .select('updated_at, data')
                .eq('user_id', userId)
                .single();

            if (error || !row) return;

            // Nada mudou desde a última checagem
            if (row.updated_at === this._lastKnownRemoteAt) return;
            this._lastKnownRemoteAt = row.updated_at;

            // Mudança veio deste próprio dispositivo — não re-renderizar
            const remoteDeviceId = row.data?._lastDeviceId;
            if (remoteDeviceId === this._deviceId) return;

            console.log('🔄 Sync: mudança de outro dispositivo detectada — mergeando...');

            // Cancelar debounce pendente para não sobrescrever dados recém-chegados
            clearTimeout(this._syncTimer);

            const localRaw = localStorage.getItem(this.STORAGE_KEY);
            const local = localRaw ? JSON.parse(localRaw) : {};

            // Incluir _settings local no base para deepMerge comparar corretamente
            try {
                const localSettingsRaw = localStorage.getItem(this.SETTINGS_KEY);
                if (localSettingsRaw && !local['_settings']) {
                    local['_settings'] = JSON.parse(localSettingsRaw);
                }
            } catch(e) {}

            const { _lastDeviceId: _ign, ...cleanRemote } = row.data;
            const merged = this.deepMerge(local, cleanRemote);

            const mergedJson = JSON.stringify(merged);
            localStorage.setItem(this.STORAGE_KEY, mergedJson);
            localStorage.setItem(this.BACKUP_KEY, mergedJson);

            // _aprendizados: aplicar via _applyRemoteAprendizados para garantir
            // merge nota-a-nota correto e re-render da aba se estiver aberta
            if (cleanRemote['_aprendizados']) {
                await this._applyRemoteAprendizados(cleanRemote['_aprendizados']);
            }

            // Aplicar _settings vencedor (já resolvido pelo deepMerge)
            let settingsChanged = false;
            if (merged['_settings']) {
                try {
                    const currentRaw = localStorage.getItem(this.SETTINGS_KEY);
                    const current = currentRaw ? JSON.parse(currentRaw) : {};
                    // Verificar se mudou de fato antes de marcar settingsChanged
                    if (JSON.stringify(current) !== JSON.stringify(merged['_settings'])) {
                        localStorage.setItem(this.SETTINGS_KEY, JSON.stringify(merged['_settings']));
                        settingsChanged = true;
                        console.log('🔄 Sync: configurações atualizadas de outro dispositivo');
                    }
                } catch(e) {}
            }

            if (typeof app !== 'undefined' && app.renderCurrentView) {
                console.log('🔄 Sync: re-renderizando view...');
                this._realtimeSyncing = true;
                try {
                    // Se as configurações mudaram, reconstruir APP_DATA antes de renderizar
                    if (settingsChanged && app.applySettings) {
                        app.applySettings();
                    }
                    app.renderCurrentView();
                } finally { this._realtimeSyncing = false; }
            }
        } catch(e) { /* rede offline — silencioso, tentará novamente em 30s */ }
    },

    // ─── Settings: labels de categorias, nomes e ordem de itens ────────
    SETTINGS_KEY: '_settings',

    getSettings() {
        try {
            // 🔒 SEGURANÇA: verificar se as settings pertencem ao usuário atual
            const settingsUid = localStorage.getItem('_settings_backup_uid');
            const currentUid  = this.getUserId();
            if (settingsUid && currentUid && settingsUid !== currentUid) {
                // Settings de outro usuário — descartar silenciosamente
                console.warn('🔒 [SEGURANÇA] getSettings: settings de outro usuário — retornando padrão');
                localStorage.removeItem(this.SETTINGS_KEY);
                localStorage.removeItem('_settings_backup_uid');
                // cai no return padrão abaixo
            } else {
                const raw = localStorage.getItem(this.SETTINGS_KEY);
                if (raw) {
                    const parsed = JSON.parse(raw);
                    // Garantir campos novos em dados antigos (retrocompatibilidade)
                    if (!parsed.customItems) parsed.customItems = { clientes: [], categorias: [], atividades: [] };
                    if (!parsed.hiddenItems) parsed.hiddenItems = { clientes: [], categorias: [], atividades: [] };
                    return parsed;
                }
            }
        } catch { /* corrompido */ }
        return {
            categoryLabels: { clientes: '👥 Clientes', categorias: '🏢 Empresa', atividades: '👤 Pessoal' },
            itemNames: { clientes: {}, categorias: {}, atividades: {} },
            itemOrder: { clientes: null, categorias: null, atividades: null },
            customItems: { clientes: [], categorias: [], atividades: [] },
            hiddenItems: { clientes: [], categorias: [], atividades: [] }
        };
    },

    saveSettings(settings) {
        try {
            // Timestamp para resolução de conflito multi-dispositivo
            settings.updatedAt = new Date().toISOString();
            localStorage.setItem(this.SETTINGS_KEY, JSON.stringify(settings));
            // 🔒 SEGURANÇA: marcar dono das settings com o user ID atual
            const ownerId = this.getUserId();
            if (ownerId) {
                localStorage.setItem('_settings_backup_uid', ownerId);
            }
            // Sync imediato para o Supabase — configurações são a base do app
            this._saveSettingsToSupabase(settings);
        } catch(e) {
            console.error('Erro ao salvar configurações:', e);
        }
    },

    // Push imediato das configurações para o Supabase (fire-and-forget)
    async _saveSettingsToSupabase(settings) {
        try {
            const allData = await this.getData();
            allData['_settings'] = settings;
            await this.saveData(allData, true); // immediate=true: sem debounce
        } catch(e) {
            console.error('Erro ao sincronizar configurações com Supabase:', e);
        }
    },

    // ─── Realtime dedicado para Aprendizados ────────────────────────────
    // Canal Supabase Realtime que escuta mudanças na tabela user_data.
    // Estratégia de segurança:
    //   1. Compara _lastDeviceId para ignorar eventos gerados pelo próprio dispositivo.
    //   2. Faz merge profundo apenas de _aprendizados (não toca nos dados de status do dia).
    //   3. Se o canal falhar (CHANNEL_ERROR / timeout), ativa fallback de polling a 5s.
    //   4. O canal é destruído ao sair da aba — evita acúmulo de listeners.
    _aprendRealtimeChannel: null,
    _aprendFallbackTimer: null,
    _aprendFallbackActive: false,
    _aprendLastRemoteAt: null,

    startAprendizadosRealtime(userId) {
        if (!userId) return;
        // Já está rodando para este usuário
        if (this._aprendRealtimeChannel && this._aprendLastUserId === userId) return;
        this._aprendLastUserId = userId;
        this._stopAprendFallback();

        const supabase = this.getSupabase();
        if (!supabase) {
            // Sem cliente Supabase — usar fallback diretamente
            this._startAprendFallback(userId);
            return;
        }

        // Destruir canal anterior se existir
        this.stopAprendizadosRealtime();

        try {
            const channel = supabase
                .channel(`aprend-sync-${userId}`)
                .on(
                    'postgres_changes',
                    { event: 'UPDATE', schema: 'public', table: 'user_data', filter: `user_id=eq.${userId}` },
                    (payload) => this._handleAprendRealtimeEvent(payload, userId)
                )
                .subscribe((status, err) => {
                    if (status === 'SUBSCRIBED') {
                        console.log('📡 Aprendizados Realtime: canal ativo');
                        this._aprendFallbackActive = false;
                        this._stopAprendFallback();
                    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
                        console.warn(`📡 Aprendizados Realtime: ${status} — ativando fallback polling 5s`);
                        this._startAprendFallback(userId);
                    }
                });

            this._aprendRealtimeChannel = channel;
        } catch(e) {
            console.warn('📡 Aprendizados Realtime: erro ao criar canal —', e.message);
            this._startAprendFallback(userId);
        }
    },

    stopAprendizadosRealtime() {
        this._stopAprendFallback();
        if (this._aprendRealtimeChannel) {
            try {
                const supabase = this.getSupabase();
                supabase?.removeChannel(this._aprendRealtimeChannel);
            } catch(e) {}
            this._aprendRealtimeChannel = null;
            console.log('📡 Aprendizados Realtime: canal encerrado');
        }
        this._aprendLastUserId = null;
    },

    _startAprendFallback(userId) {
        if (this._aprendFallbackActive) return;
        this._aprendFallbackActive = true;
        // Polling a cada 5s enquanto a aba estiver visível
        this._aprendFallbackTimer = setInterval(() => this._doPollAprendizados(userId), 5000);
        console.log('📡 Aprendizados: fallback polling 5s ativo');
    },

    _stopAprendFallback() {
        if (this._aprendFallbackTimer) {
            clearInterval(this._aprendFallbackTimer);
            this._aprendFallbackTimer = null;
        }
        this._aprendFallbackActive = false;
    },

    async _handleAprendRealtimeEvent(payload, userId) {
        try {
            const newData = payload?.new?.data;
            if (!newData) return;
            // Ignorar eventos do próprio dispositivo
            if (newData._lastDeviceId === this._deviceId) return;
            // Ignorar se não há _aprendizados no payload
            if (!newData._aprendizados) return;

            console.log('📡 Aprendizados Realtime: nova versão recebida — mergeando...');
            await this._applyRemoteAprendizados(newData._aprendizados);
        } catch(e) {
            console.warn('📡 Aprendizados Realtime: erro ao processar evento —', e);
        }
    },

    async _doPollAprendizados(userId) {
        const supabase = this.getSupabase();
        if (!supabase || !userId) return;
        try {
            const { data: row, error } = await supabase
                .from('user_data')
                .select('updated_at, data')
                .eq('user_id', userId)
                .single();

            if (error || !row) return;
            // Nada mudou
            if (row.updated_at === this._aprendLastRemoteAt) return;
            this._aprendLastRemoteAt = row.updated_at;
            // Evento do próprio dispositivo
            if (row.data?._lastDeviceId === this._deviceId) return;
            // Sem dados de aprendizados no remoto
            if (!row.data?._aprendizados) return;

            console.log('📡 Aprendizados polling: mudança detectada — mergeando...');
            await this._applyRemoteAprendizados(row.data._aprendizados);
        } catch(e) { /* rede offline — silencioso */ }
    },

    // Merge de _aprendizados remoto com local e re-render se a aba estiver aberta
    async _applyRemoteAprendizados(remote) {
        // Carregar local atual
        let local = {};
        try {
            const raw = localStorage.getItem('aprendizadosData');
            local = raw ? JSON.parse(raw) : {};
        } catch(e) {}

        // Merge profundo: a nota mais recente (updatedAt) por noteId vence
        const merged = this._mergeAprendizados(local, remote);

        // Só salvar e re-renderizar se houver diferença real
        const mergedStr = JSON.stringify(merged);
        const localStr  = JSON.stringify(local);
        if (mergedStr === localStr) return;

        localStorage.setItem('aprendizadosData', mergedStr);

        // Atualizar também o blob principal para manter consistência no deepMerge global
        try {
            const allData = await this.getData();
            allData['_aprendizados'] = merged;
            const json = JSON.stringify(allData);
            localStorage.setItem(this.STORAGE_KEY, json);
            localStorage.setItem(this.BACKUP_KEY, json);
        } catch(e) {}

        // Re-renderizar somente se a aba Aprendizados estiver visível
        const aprendView = document.getElementById('aprendizadosView');
        if (aprendView && !aprendView.classList.contains('hidden')) {
            if (typeof Aprendizados !== 'undefined' && Aprendizados.refreshFromRemote) {
                Aprendizados.refreshFromRemote();
            }
        }
        // Atualizar badge/botão 📚 se a aba Hoje estiver visível
        if (typeof app !== 'undefined' && app.currentView === 'today') {
            try { app.renderTodayView?.(); } catch(e) {}
        }
    },

    // Merge de dois objetos de aprendizados: categoria → itemId → notas por updatedAt.
    // Tombstones (deleted:true) são preservados: a versão com updatedAt mais recente vence,
    // seja ela a exclusão ou uma edição. Isso garante que deletar em um dispositivo
    // propaga a exclusão para todos os outros via sync.
    _mergeAprendizados(local, remote) {
        const result = JSON.parse(JSON.stringify(local));
        for (const cat of Object.keys(remote)) {
            if (!result[cat]) { result[cat] = remote[cat]; continue; }
            for (const itemId of Object.keys(remote[cat])) {
                const rItem = remote[cat][itemId];
                const lItem = result[cat][itemId];
                if (!lItem) { result[cat][itemId] = rItem; continue; }
                // Normalizar os dois lados para array de notas (incluindo tombstones)
                const lNotes = this._normalizeToNotesArr(lItem);
                const rNotes = this._normalizeToNotesArr(rItem);
                const map = {};
                for (const n of lNotes) map[n.id] = n;
                for (const n of rNotes) {
                    if (!map[n.id]) { map[n.id] = n; continue; }
                    // Comparar updatedAt: o mais recente vence (seja edição ou tombstone)
                    const lTs = map[n.id].updatedAt ? new Date(map[n.id].updatedAt).getTime() : 0;
                    const rTs = n.updatedAt ? new Date(n.updatedAt).getTime() : 0;
                    if (rTs > lTs) map[n.id] = n;
                    // Se igual: tombstone tem prioridade (evita ressurreição acidental)
                    else if (rTs === lTs && n.deleted && !map[n.id].deleted) map[n.id] = n;
                }
                result[cat][itemId] = {
                    notes: Object.values(map).sort((a, b) =>
                        (b.updatedAt || '').localeCompare(a.updatedAt || ''))
                };
            }
        }
        return result;
    },

    _normalizeToNotesArr(item) {
        if (!item) return [];
        if (Array.isArray(item.notes)) return item.notes;
        if (typeof item.content !== 'undefined') {
            const content = item.content || '';
            if (!content.trim()) return [];
            const id = 'n-legacy-' + Math.random().toString(36).slice(2, 8);
            return [{
                id,
                title: (content.split('\n').find(l => l.trim()) || 'Sem título').slice(0, 60),
                content,
                checkedLines: item.checkedLines || {},
                attachments: [],
                createdAt: item.updatedAt || new Date().toISOString(),
                updatedAt: item.updatedAt || new Date().toISOString(),
            }];
        }
        return [];
    },

    // ── Upload de imagem para o bucket note-images no Supabase Storage ──
    // Retorna a URL pública da imagem, ou null em caso de erro.
    async uploadNoteImage(file) {
        const supabase = this.getSupabase();
        const userId   = this.getUserId();
        if (!supabase || !userId) return null;

        // Extensão e nome único
        const ext  = file.type.split('/')[1]?.replace('jpeg','jpg') || 'png';
        const name = `${userId}/${Date.now()}_${Math.random().toString(36).slice(2,8)}.${ext}`;

        const { data, error } = await supabase.storage
            .from('note-images')
            .upload(name, file, { cacheControl: '3600', upsert: false, contentType: file.type });

        if (error) {
            console.error('❌ Erro ao fazer upload de imagem:', error.message);
            return null;
        }

        // Obter URL pública
        const { data: urlData } = supabase.storage.from('note-images').getPublicUrl(name);
        return urlData?.publicUrl || null;
    },

    // ── Upload de arquivo (qualquer tipo) para bucket note-files ─────────────
    // Path: {userId}/{noteId}/{attachId}_{safeName}
    async uploadNoteFile(file, noteId, attachId) {
        const supabase = this.getSupabase();
        const userId   = this.getUserId();
        if (!supabase || !userId) return null;

        const safeName = file.name.replace(/[^a-zA-Z0-9._\-]/g, '_');
        const path = `${userId}/${noteId}/${attachId}_${safeName}`;

        const { error } = await supabase.storage
            .from('note-files')
            .upload(path, file, {
                cacheControl: '3600',
                upsert: false,
                contentType: file.type || 'application/octet-stream',
            });

        if (error) {
            console.error('❌ Erro ao fazer upload de arquivo:', error.message);
            return null;
        }

        const { data: urlData } = supabase.storage.from('note-files').getPublicUrl(path);
        return urlData?.publicUrl || null;
    },

    // ── Deletar arquivo do bucket note-files ─────────────────────────────────
    async deleteNoteFile(publicUrl) {
        const supabase = this.getSupabase();
        if (!supabase || !publicUrl) return false;

        const marker = '/storage/v1/object/public/note-files/';
        const idx = publicUrl.indexOf(marker);
        if (idx === -1) return false;

        const path = decodeURIComponent(publicUrl.slice(idx + marker.length));
        const { error } = await supabase.storage.from('note-files').remove([path]);

        if (error) {
            console.error('❌ Erro ao deletar arquivo do storage:', error.message);
            return false;
        }
        return true;
    }
};
