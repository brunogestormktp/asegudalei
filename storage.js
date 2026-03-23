// LocalStorage management with Supabase sync
const StorageManager = {
    STORAGE_KEY: 'habit-tracker-data',
    BACKUP_KEY:  'habit-tracker-data-backup',   // backup automático
    syncInProgress: false,
    lastSyncTime: null,
    _syncTimer: null,

    // ID único desta sessão/dispositivo — persiste enquanto a aba estiver aberta
    // Usado para identificar pushes próprios no Realtime (evitar loop)
    // Fica dentro de data._lastDeviceId, que o banco não modifica (só updated_at é sobrescrito pelo trigger)
    _deviceId: (() => {
        let id = sessionStorage.getItem('ht-device-id');
        if (!id) {
            id = 'dev-' + Math.random().toString(36).slice(2) + '-' + Date.now();
            sessionStorage.setItem('ht-device-id', id);
        }
        return id;
    })(),

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
    deepMerge(base, incoming) {
        if (!incoming || typeof incoming !== 'object') return base;
        const result = { ...base };

        for (const dateKey of Object.keys(incoming)) {
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
        if (this.syncInProgress) return;
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
    async saveItemStatus(dateStr, category, itemId, status, note = '') {
        const allData = await this.getData();
        
        if (!allData[dateStr]) allData[dateStr] = {};
        if (!allData[dateStr][category]) allData[dateStr][category] = {};
        
        allData[dateStr][category][itemId] = {
            status: status,
            note: note,
            updatedAt: new Date().toISOString()
        };
        
        // immediate=true: push para Supabase sem debounce — nota nunca se perde
        await this.saveData(allData, true);
    },

    // Get status for a specific item on a specific date
    async getItemStatus(dateStr, category, itemId) {
        const dateData = await this.getDateData(dateStr);
        const itemData = dateData[category]?.[itemId];
        
        if (!itemData) return { status: 'none', note: '' };
        
        // Handle old format (just status string)
        if (typeof itemData === 'string') return { status: itemData, note: '' };
        
        return {
            status: itemData.status || 'none',
            note: itemData.note || ''
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
        for (const dateStr in allData) {
            const date = new Date(dateStr);
            if (date >= startDate && date <= endDate) {
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
    // Os dados ficam em data['_aprendizados'] — nunca são apagados pelo merge
    async saveAprendizados(aprendizadosObj) {
        const allData = await this.getData();
        allData['_aprendizados'] = aprendizadosObj;
        await this.saveData(allData);
    },

    async getAprendizados() {
        const allData = await this.getData();
        return allData['_aprendizados'] || null;
    },

    // ─── Force sync from Supabase (após login) ──────────────────────────
    // Usa merge profundo: nunca sobrescreve dados locais mais recentes
    async forceSyncFromSupabase() {
        const userId = this.getUserId();
        if (!userId) {
            console.log('No user logged in');
            return false;
        }

        try {
            const supabase = this.getSupabase();
            if (supabase) {
                const { data: remoteData, error } = await supabase
                    .from('user_data')
                    .select('data')
                    .eq('user_id', userId)
                    .single();

                if (!error && remoteData?.data) {
                    // Ler dados locais atuais
                    const localRaw = localStorage.getItem(this.STORAGE_KEY);
                    const local = localRaw ? JSON.parse(localRaw) : {};

                    // Remover _lastDeviceId do remoto antes de mesclar (não é dado do app)
                    const { _lastDeviceId: _ignored, ...cleanRemote } = remoteData.data;

                    // MERGE PROFUNDO: local + remoto, o mais recente por item vence
                    const merged = this.deepMerge(local, cleanRemote);

                    // Salvar merged APENAS no localStorage — sem push de volta ao Supabase
                    // (evita loop: forceSyncFromSupabase → push → Realtime event → forceSyncFromSupabase)
                    const mergedJson = JSON.stringify(merged);
                    localStorage.setItem(this.STORAGE_KEY, mergedJson);
                    localStorage.setItem(this.BACKUP_KEY, mergedJson);

                    if (merged['_aprendizados']) {
                        try {
                            localStorage.setItem('aprendizadosData', JSON.stringify(merged['_aprendizados']));
                        } catch(e) {}
                    }

                    console.log('✅ Data merged from Supabase (deep merge, no data lost)');
                    return true;
                } else if (error && error.code !== 'PGRST116') {
                    console.error('Error fetching from Supabase:', error);
                    return false;
                } else if (error?.code === 'PGRST116') {
                    // Nenhum dado no Supabase ainda — fazer push do local
                    console.log('Sem dados no Supabase — fazendo push do local');
                    const local = await this.getData();
                    if (this.hasRealData(local)) {
                        await this._pushToSupabase(local);
                    }
                    return true;
                }
            }
        } catch (error) {
            console.error('Error syncing from Supabase:', error);
            return false;
        }
        return true;
    },

    // ─── Realtime: subscribe para sincronização instantânea entre dispositivos ───
    _realtimeChannel: null,
    _realtimeUserId: null,   // userId do canal ativo — evita recriar canal desnecessariamente

    startRealtime(userId) {
        const supabase = this.getSupabase();
        if (!supabase || !userId) return;

        // Já está subscrito para este userId com canal ativo — não recriar
        if (this._realtimeChannel && this._realtimeUserId === userId) {
            console.log('📡 Realtime: canal já ativo para este usuário.');
            return;
        }

        // Remover canal anterior (seja de outro userId ou de reconnect)
        if (this._realtimeChannel) {
            try { supabase.removeChannel(this._realtimeChannel); } catch(e) {}
            this._realtimeChannel = null;
        }

        this._realtimeUserId = userId;
        console.log('📡 Iniciando Realtime sync...');

        const deviceId = this._deviceId;

        this._realtimeChannel = supabase
            .channel(`user_data_${userId}_${deviceId.slice(-6)}`)
            .on(
                'postgres_changes',
                {
                    event: '*',
                    schema: 'public',
                    table: 'user_data',
                    filter: `user_id=eq.${userId}`
                },
                async (payload) => {
                    // Anti-loop: ignorar eventos gerados por ESTE dispositivo.
                    // O campo _lastDeviceId é gravado dentro do JSON de dados no push —
                    // o banco não o altera, então chega intacto no payload do Realtime.
                    const remoteDeviceId = payload.new?.data?._lastDeviceId;
                    console.log('📡 Realtime evento recebido:', {
                        eventType: payload.eventType,
                        remoteDeviceId,
                        myDeviceId: deviceId,
                        isSelf: remoteDeviceId === deviceId,
                        hasData: !!payload.new?.data
                    });
                    if (remoteDeviceId === deviceId) {
                        console.log('📡 Realtime: evento ignorado (próprio push)');
                        return;
                    }

                    const remoteData = payload.new?.data;
                    if (!remoteData || !this.hasRealData(remoteData)) {
                        console.warn('📡 Realtime: dados remotos vazios ou inválidos — ignorado');
                        return;
                    }

                    console.log('📡 Realtime: mudança recebida de outro dispositivo — mergeando...');

                    // Cancelar qualquer push debounced pendente: evita sobrescrever os dados
                    // recém-chegados com uma versão antiga que ainda estava na fila
                    clearTimeout(this._syncTimer);

                    // Merge profundo: local + remoto, mais recente vence por updatedAt
                    const localRaw = localStorage.getItem(this.STORAGE_KEY);
                    const local = localRaw ? JSON.parse(localRaw) : {};
                    // Remover _lastDeviceId dos dados antes de mesclar (não é dado do app)
                    const { _lastDeviceId: _ignored, ...cleanRemote } = remoteData;
                    const merged = this.deepMerge(local, cleanRemote);

                    // Debug: mostrar o que mudou no merge
                    const today = new Date().toISOString().slice(0, 10);
                    console.log('📡 Merge resultado (hoje):', JSON.stringify(merged[today] || {}).slice(0, 300));

                    // Salvar merged no localStorage SEM acionar push (evitar loop)
                    const mergedJson = JSON.stringify(merged);
                    localStorage.setItem(this.STORAGE_KEY, mergedJson);
                    localStorage.setItem(this.BACKUP_KEY, mergedJson);

                    if (merged['_aprendizados']) {
                        try { localStorage.setItem('aprendizadosData', JSON.stringify(merged['_aprendizados'])); } catch(e) {}
                    }

                    // Re-renderizar a view atual do app
                    if (typeof app !== 'undefined' && app.renderCurrentView) {
                        console.log('📡 Realtime: re-renderizando view...');
                        // Sinalizar que o re-render vem do Realtime — app.js usa isso
                        // para não disparar saves automáticos (exitCurrentEditMode sem save)
                        this._realtimeSyncing = true;
                        try {
                            app.renderCurrentView();
                        } finally {
                            this._realtimeSyncing = false;
                        }
                    }
                }
            )
            .subscribe((status) => {
                console.log('📡 Realtime status:', status);
                // Reconectar em caso de erro de rede
                if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
                    console.log('📡 Realtime: reconectando em 3s...');
                    // Limpar referências ANTES de reagendar — evita loop na idempotency check
                    this._realtimeChannel = null;
                    this._realtimeUserId = null;
                    setTimeout(() => this.startRealtime(userId), 3000);
                }
            });
    },

    stopRealtime() {
        const supabase = this.getSupabase();
        if (supabase && this._realtimeChannel) {
            try { supabase.removeChannel(this._realtimeChannel); } catch(e) {}
            this._realtimeChannel = null;
            this._realtimeUserId = null;
            console.log('📡 Realtime desconectado');
        }
    }
};
