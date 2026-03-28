// LocalStorage management with Supabase sync
const StorageManager = {
    STORAGE_KEY: 'habit-tracker-data',
    BACKUP_KEY:  'habit-tracker-data-backup',   // backup automático
    syncInProgress: false,
    lastSyncTime: null,
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
    async saveItemStatus(dateStr, category, itemId, status, note = '', links = null) {
        const allData = await this.getData();
        
        if (!allData[dateStr]) allData[dateStr] = {};
        if (!allData[dateStr][category]) allData[dateStr][category] = {};
        
        // Preserve existing links if not explicitly provided
        const existing = allData[dateStr][category][itemId];
        const existingLinks = (existing && typeof existing === 'object') ? (existing.links || []) : [];

        allData[dateStr][category][itemId] = {
            status: status,
            note: note,
            links: links !== null ? links : existingLinks,
            updatedAt: new Date().toISOString()
        };
        
        // immediate=true: push para Supabase sem debounce — nota nunca se perde
        await this.saveData(allData, true);
    },

    // Get status for a specific item on a specific date
    async getItemStatus(dateStr, category, itemId) {
        const dateData = await this.getDateData(dateStr);
        const itemData = dateData[category]?.[itemId];
        
        if (!itemData) return { status: 'none', note: '', links: [] };
        
        // Handle old format (just status string)
        if (typeof itemData === 'string') return { status: itemData, note: '', links: [] };
        
        return {
            status: itemData.status || 'none',
            note: itemData.note || '',
            links: itemData.links || []
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
            const { _lastDeviceId: _ign, ...cleanRemote } = row.data;
            const merged = this.deepMerge(local, cleanRemote);

            const mergedJson = JSON.stringify(merged);
            localStorage.setItem(this.STORAGE_KEY, mergedJson);
            localStorage.setItem(this.BACKUP_KEY, mergedJson);

            if (merged['_aprendizados']) {
                try { localStorage.setItem('aprendizadosData', JSON.stringify(merged['_aprendizados'])); } catch(e) {}
            }

            if (typeof app !== 'undefined' && app.renderCurrentView) {
                console.log('🔄 Sync: re-renderizando view...');
                this._realtimeSyncing = true;
                try { app.renderCurrentView(); } finally { this._realtimeSyncing = false; }
            }
        } catch(e) { /* rede offline — silencioso, tentará novamente em 10s */ }
    },

    // ─── Settings: labels de categorias, nomes e ordem de itens ────────
    SETTINGS_KEY: '_settings',

    getSettings() {
        try {
            const raw = localStorage.getItem(this.SETTINGS_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                // Garantir campos novos em dados antigos (retrocompatibilidade)
                if (!parsed.customItems) parsed.customItems = { clientes: [], categorias: [], atividades: [] };
                if (!parsed.hiddenItems) parsed.hiddenItems = { clientes: [], categorias: [], atividades: [] };
                return parsed;
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
            localStorage.setItem(this.SETTINGS_KEY, JSON.stringify(settings));
        } catch(e) {
            console.error('Erro ao salvar configurações:', e);
        }
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
    }
};
