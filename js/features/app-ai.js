// app-ai.js — Mixin: Aba Assistente IA v2
// Extends HabitTrackerApp.prototype
// Markdown rendering, copy button, colored action feedback, conversation history.

Object.assign(HabitTrackerApp.prototype, {

    // ── Estado em memória (por sessão) ───────────────────────────────────
    _aiHistory:       [],      // [{ role: 'user'|'assistant', content: string }]
    _aiInited:        false,
    _aiPending:       false,
    _aiConvoId:       null,    // ID da conversa ativa
    _aiConvosLoaded:  false,   // conversas já foram carregadas do Supabase?

    // ── Persistência de conversas (Supabase via StorageManager) ──────────
    async _aiLoadConversations() {
        try {
            // Carregar do Supabase (cai no cache do localStorage internamente)
            const convos = await StorageManager.getAIConversations();
            return Array.isArray(convos) ? convos : [];
        } catch { return []; }
    },

    async _aiSaveConversations(convos) {
        try {
            // Manter no máximo 30 conversas
            const trimmed = (convos || []).slice(0, 30);
            await StorageManager.saveAIConversations(trimmed);
        } catch (e) { console.error('AI save conversations error:', e); }
    },

    async _aiSaveCurrentConvo() {
        if (!this._aiConvoId || this._aiHistory.length === 0) return;
        const convos = await this._aiLoadConversations();
        const idx = convos.findIndex(c => c.id === this._aiConvoId);
        const firstUserMsg = this._aiHistory.find(m => m.role === 'user');
        const title = firstUserMsg
            ? firstUserMsg.content.slice(0, 50) + (firstUserMsg.content.length > 50 ? '…' : '')
            : 'Nova conversa';
        const convo = {
            id: this._aiConvoId,
            title,
            messages: this._aiHistory.slice(),
            updatedAt: Date.now(),
        };
        if (idx >= 0) {
            convos[idx] = convo;
        } else {
            convos.unshift(convo);
        }
        // Sort by most recent
        convos.sort((a, b) => b.updatedAt - a.updatedAt);
        await this._aiSaveConversations(convos);
    },

    async _aiDeleteConvo(convoId) {
        let convos = await this._aiLoadConversations();
        convos = convos.filter(c => c.id !== convoId);
        await this._aiSaveConversations(convos);
        // Se deletou a conversa ativa, iniciar nova
        if (this._aiConvoId === convoId) {
            this._aiStartNewConvo();
        }
        this._aiRenderHistoryList();
    },

    async _aiStartNewConvo() {
        // Salvar conversa atual antes de criar nova
        await this._aiSaveCurrentConvo();
        this._aiConvoId = 'c_' + Date.now();
        this._aiHistory = [];
        // Limpar DOM
        const container = document.getElementById('aiMessages');
        if (container) container.innerHTML = '';
        // Mensagem de boas-vindas
        const now = new Date();
        const dias = ['domingo','segunda','terça','quarta','quinta','sexta','sábado'];
        const dia = dias[now.getDay()];
        const num = now.getDate();
        this._appendMessage('assistant',
            `## ✨ Nova conversa\nHoje é **${dia} dia ${num}** — como posso ajudar?`
        );
        this._aiRenderHistoryList();
    },

    async _aiLoadConvo(convoId) {
        // Salvar a conversa atual primeiro
        await this._aiSaveCurrentConvo();
        const convos = await this._aiLoadConversations();
        const convo = convos.find(c => c.id === convoId);
        if (!convo) return;
        this._aiConvoId = convo.id;
        this._aiHistory = convo.messages.slice();
        // Re-render messages
        const container = document.getElementById('aiMessages');
        if (container) container.innerHTML = '';
        for (const msg of this._aiHistory) {
            this._appendMessage(msg.role, msg.content);
        }
        this._aiScrollToBottom();
        this._aiRenderHistoryList();
        // Fechar drawer
        this._aiCloseHistory();
    },

    // ── History drawer ───────────────────────────────────────────────────
    _aiOpenHistory() {
        // On desktop (≥768px) the sidebar is always visible — skip
        if (window.innerWidth >= 768) return;
        document.getElementById('aiHistoryDrawer')?.classList.add('open');
        document.getElementById('aiHistoryOverlay')?.classList.add('active');
        this._aiRenderHistoryList();
    },

    _aiCloseHistory() {
        // On desktop (≥768px) the sidebar is always visible — skip
        if (window.innerWidth >= 768) return;
        document.getElementById('aiHistoryDrawer')?.classList.remove('open');
        document.getElementById('aiHistoryOverlay')?.classList.remove('active');
    },

    _aiRenderHistoryList() {
        const list = document.getElementById('aiHistoryList');
        if (!list) return;
        list.innerHTML = '<div class="ai-history-empty">Carregando...</div>';

        this._aiLoadConversations().then(convos => {
            list.innerHTML = '';

            if (convos.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'ai-history-empty';
                empty.textContent = 'Nenhuma conversa salva ainda.';
                list.appendChild(empty);
                return;
            }

            for (const convo of convos) {
                const item = document.createElement('div');
                item.className = 'ai-history-item' + (convo.id === this._aiConvoId ? ' active' : '');

                const textDiv = document.createElement('div');
                textDiv.className = 'ai-history-item-text';

                const title = document.createElement('div');
                title.className = 'ai-history-item-title';
                title.textContent = convo.title || 'Conversa';
                textDiv.appendChild(title);

                const date = document.createElement('div');
                date.className = 'ai-history-item-date';
                date.textContent = this._aiFormatConvoDate(convo.updatedAt);
                textDiv.appendChild(date);

                const delBtn = document.createElement('button');
                delBtn.className = 'ai-history-item-delete';
                delBtn.textContent = '🗑';
                delBtn.title = 'Apagar conversa';
                delBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this._aiDeleteConvo(convo.id);
                });

                item.appendChild(textDiv);
                item.appendChild(delBtn);
                item.addEventListener('click', () => this._aiLoadConvo(convo.id));
                list.appendChild(item);
            }
        });
    },

    _aiFormatConvoDate(ts) {
        if (!ts) return '';
        const d = new Date(ts);
        const now = new Date();
        const diffMs = now.getTime() - d.getTime();
        const diffMin = Math.floor(diffMs / 60000);
        if (diffMin < 1) return 'agora';
        if (diffMin < 60) return diffMin + ' min atrás';
        const diffH = Math.floor(diffMin / 60);
        if (diffH < 24) return diffH + 'h atrás';
        const diffD = Math.floor(diffH / 24);
        if (diffD === 1) return 'ontem';
        if (diffD < 7) return diffD + ' dias atrás';
        return d.getDate() + '/' + (d.getMonth()+1);
    },

    // ── Entrada principal: renderizar a aba ──────────────────────────────
    async renderAIView() {
        if (!this._aiInited) {
            this._aiAttachListeners();
            this._aiInited = true;
            // Iniciar conversa se não houver uma ativa
            if (!this._aiConvoId) {
                this._aiConvoId = 'c_' + Date.now();
            }

            // Tentar restaurar última conversa do Supabase
            if (!this._aiConvosLoaded) {
                this._aiConvosLoaded = true;
                try {
                    const convos = await this._aiLoadConversations();
                    if (convos.length > 0 && this._aiHistory.length === 0) {
                        // Restaurar a conversa mais recente
                        const latest = convos[0];
                        this._aiConvoId = latest.id;
                        this._aiHistory = latest.messages.slice();
                        const container = document.getElementById('aiMessages');
                        if (container) container.innerHTML = '';
                        for (const msg of this._aiHistory) {
                            this._appendMessage(msg.role, msg.content);
                        }
                        this._aiScrollToBottom();
                        return; // já renderizou
                    }
                } catch (e) { console.warn('AI: failed to load conversations from Supabase', e); }
            }

            if (this._aiHistory.length === 0) {
                const now = new Date();
                const dias = ['domingo','segunda','terça','quarta','quinta','sexta','sábado'];
                const dia = dias[now.getDay()];
                const num = now.getDate();
                this._appendMessage('assistant',
                    `## ✨ Olá!\nSou seu assistente inteligente. Posso:\n\n` +
                    `- **Analisar** seu dia e sugerir prioridades\n` +
                    `- **Identificar** pendências e bloqueios\n` +
                    `- **Atualizar** status de tarefas por você\n` +
                    `- **Criar** notas de aprendizados\n\n` +
                    `> Hoje é **${dia} dia ${num}** — como posso ajudar?`
                );
            }
        }
        this._aiScrollToBottom();
    },

    _aiAttachListeners() {
        const sendBtn  = document.getElementById('aiSendBtn');
        const input    = document.getElementById('aiInput');
        const quickBtns = document.querySelectorAll('.ai-quick-btn');

        sendBtn?.addEventListener('click', () => this._aiSendFromInput());

        // Slash menu state
        this._slashMenu = null;
        this._slashIdx = -1;       // highlighted item index
        this._slashStart = -1;     // cursor position where / was typed

        input?.addEventListener('keydown', (e) => {
            // If slash menu is open, intercept arrow/enter/escape
            if (this._slashMenu) {
                if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    this._slashNavigate(1);
                    return;
                }
                if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    this._slashNavigate(-1);
                    return;
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                    e.preventDefault();
                    this._slashSelectCurrent();
                    return;
                }
                if (e.key === 'Escape') {
                    e.preventDefault();
                    this._slashClose();
                    return;
                }
            }

            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this._aiSendFromInput();
            }
        });

        // Listen for input changes to trigger/update/close slash menu
        input?.addEventListener('input', () => this._slashOnInput());

        quickBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const prompt = btn.dataset.prompt;
                if (prompt) this.sendAIMessage(prompt);
            });
        });

        // History drawer
        document.getElementById('aiOpenHistory')?.addEventListener('click', () => this._aiOpenHistory());
        document.getElementById('aiHistoryClose')?.addEventListener('click', () => this._aiCloseHistory());
        document.getElementById('aiHistoryOverlay')?.addEventListener('click', () => this._aiCloseHistory());

        // New chat
        document.getElementById('aiNewChat')?.addEventListener('click', () => this._aiStartNewConvo());

        // ── Desktop / Mobile resize handler ──────────────────────────────
        let wasDesktop = window.innerWidth >= 768;
        window.addEventListener('resize', () => {
            const isDesktop = window.innerWidth >= 768;
            if (isDesktop === wasDesktop) return;
            wasDesktop = isDesktop;
            const drawer  = document.getElementById('aiHistoryDrawer');
            const overlay = document.getElementById('aiHistoryOverlay');
            if (isDesktop) {
                // Transitioning to desktop: clean up mobile drawer state
                drawer?.classList.remove('open');
                overlay?.classList.remove('active');
            }
            // On desktop the sidebar list should stay up to date
            if (isDesktop) this._aiRenderHistoryList();
        });

        // On desktop, render history list immediately so sidebar shows content
        if (window.innerWidth >= 768) {
            this._aiRenderHistoryList();
        }
    },

    _aiSendFromInput() {
        const input = document.getElementById('aiInput');
        if (!input) return;
        const msg = input.value.trim();
        if (!msg) return;
        input.value = '';
        input.style.height = '';
        this._slashClose();
        this.sendAIMessage(msg);
    },

    // ── Enviar mensagem para a Edge Function ─────────────────────────────
    async sendAIMessage(message) {
        if (this._aiPending || !message.trim()) return;
        this._aiPending = true;

        // Bug 2: Garantir que _aiConvoId está definido antes de qualquer operação
        if (!this._aiConvoId) this._aiConvoId = 'c_' + Date.now();

        // Remover quick replies anteriores antes de nova mensagem
        const container = document.getElementById('aiMessages');
        container?.querySelectorAll('.ai-quick-replies').forEach(el => el.remove());

        this._appendMessage('user', message);
        this._aiScrollToBottom();

        const typingEl = this._showTyping();
        this._aiScrollToBottom();

        const input   = document.getElementById('aiInput');
        const sendBtn = document.getElementById('aiSendBtn');
        if (input)   input.disabled   = true;
        if (sendBtn) sendBtn.disabled = true;

        try {
            const supabaseClient = window.getSupabaseClient();
            if (!supabaseClient) throw new Error('Supabase não disponível');

            // Obter sessão válida — tenta getSession() primeiro, se token expirado faz refresh
            let session;
            const { data: { session: cached } } = await supabaseClient.auth.getSession();
            if (cached?.access_token) {
                // Verificar se o token está próximo de expirar (menos de 60s restantes)
                const exp = cached.expires_at ? cached.expires_at * 1000 : 0;
                if (exp && exp - Date.now() < 60000) {
                    console.log('AI: token expirando em breve, forçando refresh...');
                    const { data: { session: refreshed } } = await supabaseClient.auth.refreshSession();
                    session = refreshed || cached;
                } else {
                    session = cached;
                }
            } else {
                // Sem sessão em cache — tentar refresh
                const { data: { session: refreshed } } = await supabaseClient.auth.refreshSession();
                session = refreshed;
            }
            if (!session?.access_token) throw new Error('Sessão expirada — faça login novamente');

            // Forçar sync dos dados locais para o Supabase ANTES de chamar a IA,
            // garantindo que a Edge Function leia os dados mais recentes.
            try {
                const localData = await StorageManager.getData();
                if (StorageManager.hasRealData(localData)) {
                    await StorageManager._pushToSupabase(localData);
                }
            } catch (e) { console.warn('AI: pre-sync failed (will use context_hint fallback)', e); }

            const aiHeaders = {
                'Authorization': `Bearer ${session.access_token}`,
                'Content-Type':  'application/json',
                'apikey':        SUPABASE_CONFIG.anonKey,
            };
            const contextHint = await this._buildAIContext();
            const aiBody = JSON.stringify({
                message,
                history:      this._aiHistory.slice(-20),
                context_hint: contextHint,
            });

            let resp = await fetch(`${SUPABASE_CONFIG.url}/functions/v1/ai-assistant`, {
                method: 'POST',
                headers: aiHeaders,
                body: aiBody,
            });

            // Se 401 (token expirado), forçar refresh e tentar uma vez
            if (resp.status === 401) {
                console.log('AI assistant 401 — forçando refreshSession e retentando...');
                const { data: { session: fresh } } = await supabaseClient.auth.refreshSession();
                if (!fresh?.access_token) throw new Error('Sessão expirada — faça login novamente');
                aiHeaders['Authorization'] = `Bearer ${fresh.access_token}`;
                resp = await fetch(`${SUPABASE_CONFIG.url}/functions/v1/ai-assistant`, {
                    method: 'POST',
                    headers: aiHeaders,
                    body: aiBody,
                });
            }

            this._removeTyping(typingEl);

            if (resp.status === 429) {
                const data = await resp.json().catch(() => ({}));
                const wait = data.retryAfter || 60;
                this._appendMessage('assistant',
                    `⏳ Muitas mensagens em pouco tempo. Aguarde **${wait}s** e tente novamente.`
                );
            } else if (!resp.ok) {
                const data = await resp.json().catch(() => ({}));
                this._appendMessage('assistant',
                    `❌ Erro ao contatar o assistente (**${resp.status}**). Tente novamente.`
                );
                console.error('AI error:', data);
            } else {
                const data = await resp.json();
                const reply = (data.reply || '').trim();

                if (reply) {
                    this._appendMessage('assistant', reply);
                    this._aiHistory.push({ role: 'user',      content: message });
                    this._aiHistory.push({ role: 'assistant', content: reply });
                    if (this._aiHistory.length > 40) {
                        this._aiHistory = this._aiHistory.slice(-40);
                    }

                    // Render quick reply buttons if present
                    const quickReplies = Array.isArray(data.quickReplies) ? data.quickReplies : [];
                    if (quickReplies.length > 0) {
                        this._renderQuickReplies(quickReplies);
                    }

                    // Persist conversation to Supabase
                    this._aiSaveCurrentConvo();
                }

                const actions = Array.isArray(data.actions) ? data.actions : [];
                if (actions.length > 0) {
                    await this._applyAIActions(actions);
                }
            }
        } catch (err) {
            this._removeTyping(typingEl);
            this._appendMessage('assistant',
                `❌ Não foi possível conectar ao assistente. Verifique sua conexão e tente novamente.`
            );
            console.error('sendAIMessage error:', err);
        } finally {
            this._aiPending = false;
            if (input)   input.disabled   = false;
            if (sendBtn) sendBtn.disabled = false;
            input?.focus();
            this._aiScrollToBottom();
        }
    },

    // ── Botões de resposta rápida (quick replies) ──────────────────────
    _renderQuickReplies(replies) {
        const container = document.getElementById('aiMessages');
        if (!container || !replies.length) return;

        // Remover quick replies anteriores
        container.querySelectorAll('.ai-quick-replies').forEach(el => el.remove());

        const wrapper = document.createElement('div');
        wrapper.className = 'ai-quick-replies';

        for (const text of replies) {
            const btn = document.createElement('button');
            btn.className = 'ai-quick-reply-btn';
            btn.textContent = text;
            btn.addEventListener('click', () => {
                // Remover os botões após clique
                wrapper.remove();
                // Enviar como mensagem do usuário
                this.sendAIMessage(text);
            });
            wrapper.appendChild(btn);
        }

        container.appendChild(wrapper);
        this._aiScrollToBottom();
    },

    // ── Contexto enviado como hint (itens ativos do APP_DATA + dados em tempo real) ─
    async _buildAIContext() {
        try {
            const todayStr = this.getDateString();
            const activeItems = {};
            for (const cat of ['clientes', 'categorias', 'atividades']) {
                const items = (typeof APP_DATA !== 'undefined' && APP_DATA[cat]) || [];
                activeItems[cat] = items.map(it => it.id);
            }
            const els = document.querySelectorAll('#todayView .item');
            let pendingCount = 0, blockedCount = 0;
            els.forEach(el => {
                const st = el.dataset.status || '';
                if (st === 'bloqueado') blockedCount++;
                if (!st || st === 'none' || st === 'nao-feito') pendingCount++;
            });

            // Include user-defined demand contexts for AI training
            let itemContexts = null;
            try {
                const s = StorageManager.getSettings();
                if (s.itemContexts) {
                    const ctx = {};
                    for (const cat of ['clientes', 'categorias', 'atividades']) {
                        if (s.itemContexts[cat] && Object.keys(s.itemContexts[cat]).length > 0) {
                            ctx[cat] = s.itemContexts[cat];
                        }
                    }
                    if (Object.keys(ctx).length > 0) itemContexts = ctx;
                }
            } catch {}

            // Include week day info for better planning
            const now = new Date();
            const dayOfWeek = now.getDay(); // 0=dom
            const daysLeftInWeek = 6 - dayOfWeek; // dias até sábado

            // ── DADOS EM TEMPO REAL: ler do localStorage todos os status/notas de hoje ──
            // Isso garante que a IA sempre veja os dados mais recentes,
            // mesmo que o Supabase ainda não tenha recebido o sync.
            let todayData = null;
            let recentData = null;
            try {
                const allData = await StorageManager.getData();
                const td = allData[todayStr];
                if (td && typeof td === 'object') {
                    todayData = {};
                    for (const cat of ['clientes', 'categorias', 'atividades']) {
                        const catData = td[cat];
                        if (!catData || typeof catData !== 'object') continue;
                        todayData[cat] = {};
                        for (const [itemId, raw] of Object.entries(catData)) {
                            const st = typeof raw === 'string' ? raw : (raw?.status || 'none');
                            const note = typeof raw === 'object' ? (raw?.note || '') : '';
                            todayData[cat][itemId] = { status: st, note: note };
                        }
                    }
                }

                // ── DADOS RECENTES: últimos 7 dias para contexto da semana ──
                recentData = {};
                for (let i = 1; i <= 7; i++) {
                    const d = new Date(todayStr + 'T12:00:00Z');
                    d.setUTCDate(d.getUTCDate() - i);
                    const ds = d.getUTCFullYear() + '-' + String(d.getUTCMonth()+1).padStart(2,'0') + '-' + String(d.getUTCDate()).padStart(2,'0');
                    const dd = allData[ds];
                    if (!dd || typeof dd !== 'object') continue;
                    recentData[ds] = {};
                    for (const cat of ['clientes', 'categorias', 'atividades']) {
                        const catData = dd[cat];
                        if (!catData || typeof catData !== 'object') continue;
                        recentData[ds][cat] = {};
                        for (const [itemId, raw] of Object.entries(catData)) {
                            const st = typeof raw === 'string' ? raw : (raw?.status || 'none');
                            const note = typeof raw === 'object' ? (raw?.note || '') : '';
                            if (st !== 'none' || note) {
                                recentData[ds][cat][itemId] = { status: st, note: note.slice(0, 200) };
                            }
                        }
                    }
                }
            } catch (e) { console.warn('AI context: failed to read local data', e); }

            return {
                today: todayStr,
                activeItems,
                pendingCount,
                blockedCount,
                itemContexts,
                dayOfWeek,
                daysLeftInWeek,
                todayData,
                recentData,
            };
        } catch {
            return { today: this.getDateString() };
        }
    },

    // ── Aplicar ações retornadas pela IA ─────────────────────────────────
    async _applyAIActions(actions) {
        const validCategories = ['clientes', 'categorias', 'atividades'];

        // Map common AI category mistakes to valid values
        const categoryAliases = {
            clientes: 'clientes', cliente: 'clientes', clients: 'clientes',
            categorias: 'categorias', categoria: 'categorias', empresa: 'categorias',
            atividades: 'atividades', atividade: 'atividades', pessoal: 'atividades', pessoais: 'atividades', personal: 'atividades',
        };

        // Helper: resolve category + verify itemId exists, with cross-category fallback
        const resolveCategory = (rawCat, itemId) => {
            // First try alias mapping
            const mapped = categoryAliases[(rawCat || '').toLowerCase().trim()];
            if (mapped) {
                const catItems = (typeof APP_DATA !== 'undefined' && APP_DATA[mapped]) || [];
                if (catItems.some(it => it.id === itemId)) return mapped;
            }
            // Fallback: search itemId across all categories
            for (const cat of validCategories) {
                const catItems = (typeof APP_DATA !== 'undefined' && APP_DATA[cat]) || [];
                if (catItems.some(it => it.id === itemId)) return cat;
            }
            return mapped || null; // return mapped even if itemId not found (will fail later with clear error)
        };

        let anyChange = false;
        const updates = [];
        const aprendizados = [];

        for (const action of actions) {
            if (!action || typeof action !== 'object') continue;

            if (action.action === 'update_item') {
                const { itemId, status, note } = action;
                const dateTarget = action.date || 'hoje';
                const category = resolveCategory(action.category, itemId);
                if (!category) { console.warn('AI: categoria inválida e sem fallback', action.category, itemId); continue; }
                const catItems = (typeof APP_DATA !== 'undefined' && APP_DATA[category]) || [];
                if (!catItems.some(it => it.id === itemId)) { console.warn('AI: itemId não encontrado', itemId, 'em', category); continue; }

                try {
                    const dateStr = this._aiResolveDateTarget(dateTarget);
                    const existing = await StorageManager.getItemStatus(dateStr, category, itemId);
                    const existingStatus = (existing && existing.status && existing.status !== 'none')
                        ? existing.status : null;

                    // NUNCA alterar status se a IA não mandou um explicitamente
                    // Se a IA mandou status → usar o que ela mandou
                    // Se a IA NÃO mandou status → preservar o existente (ou 'none' se não tinha)
                    let finalStatus;
                    if (status && status !== 'none') {
                        finalStatus = status;
                    } else {
                        finalStatus = existingStatus || 'none';
                    }

                    // Se tem nota, combinar com nota existente se houver
                    let finalNote = note || '';
                    if (finalNote) {
                        const existingNote = (existing && existing.note) || '';
                        if (existingNote) {
                            finalNote = existingNote + '\n' + finalNote;
                        }
                    }

                    await StorageManager.saveItemStatus(dateStr, category, itemId, finalStatus, finalNote || undefined);
                    const itemName = catItems.find(it => it.id === itemId)?.name || itemId;
                    const dateLabel = this._aiDateLabel(dateStr);
                    const statusChanged = status && status !== 'none';
                    updates.push({ itemName, status: statusChanged ? finalStatus : null, note: finalNote, dateLabel });
                    anyChange = true;
                } catch (err) { console.error('AI update_item error:', err); }

            } else if (action.action === 'create_aprendizado') {
                const { itemId, title, content } = action;
                const category = resolveCategory(action.category, itemId);
                if (!category) { console.warn('AI: categoria inválida para aprendizado', action.category, itemId); continue; }
                if (!title || !content) { console.warn('AI: title/content obrigatórios'); continue; }

                try {
                    let aprendData = await StorageManager.getAprendizados() || {};
                    if (!aprendData[category]) aprendData[category] = {};
                    if (!aprendData[category][itemId]) aprendData[category][itemId] = { notes: [] };
                    const item = aprendData[category][itemId];
                    if (!Array.isArray(item.notes)) {
                        item.notes = item.content ? [{
                            id: '__legacy__', title: '', content: item.content,
                            checkedLines: item.checkedLines || {}, updatedAt: new Date().toISOString()
                        }] : [];
                        delete item.content;
                        delete item.checkedLines;
                    }
                    const noteId = 'ai_' + Date.now();
                    item.notes.push({ id: noteId, title, content, checkedLines: {}, updatedAt: new Date().toISOString() });
                    await StorageManager.saveAprendizados(aprendData);
                    // Sincronizar com o localStorage do módulo Aprendizados
                    try { localStorage.setItem('aprendizadosData', JSON.stringify(aprendData)); } catch {}
                    const catItems = (typeof APP_DATA !== 'undefined' && APP_DATA[category]) || [];
                    const itemName = catItems.find(it => it.id === itemId)?.name || itemId;
                    aprendizados.push({ itemName, title });
                    anyChange = true;
                } catch (err) { console.error('AI create_aprendizado error:', err); }
            }
        }

        // Feedback visual com destaque colorido
        if (updates.length > 0) {
            const lines = updates.map(u => {
                const datePart = u.dateLabel && u.dateLabel !== 'hoje' ? ` (${u.dateLabel})` : '';
                if (u.status) {
                    return `✅ **${u.itemName}** → \`${u.status}\`${datePart}` + (u.note ? ` — _"${u.note}"_` : '');
                } else {
                    return `📝 **${u.itemName}**${datePart} — _"${u.note}"_`;
                }
            });
            this._appendActionFeedback('update', lines.join('\n'));
        }
        if (aprendizados.length > 0) {
            const lines = aprendizados.map(a => `📝 **${a.title}** criado para **${a.itemName}**`);
            this._appendActionFeedback('aprendizado', lines.join('\n'));
            // Marcar aprendizados como sujos para re-render ao abrir a aba
            this._aiAprendizadosDirty = true;
        }

        // Feature 1: Perguntar sobre aprendizado após concluir item
        const completedItems = updates.filter(u => u.status === 'concluido' || u.status === 'concluido-ongoing');
        if (completedItems.length > 0) {
            const names = completedItems.map(u => u.itemName).join(', ');
            const followUp = `📚 **${names}** concluído! O que você aprendeu ou quer registrar?`;
            this._appendMessage('assistant', followUp);
            this._renderQuickReplies(["📝 Registrar aprendizado", "✅ Nada por enquanto", "🔍 Ver aprendizados"]);
        }

        if (anyChange && this.currentView === 'today') {
            this._todayScrollTop = window.scrollY;
            this._pendingScrollRestore = true;
            this.renderTodayView();
        }
        if (anyChange && this.currentView === 'aprendizados') {
            if (typeof Aprendizados !== 'undefined') {
                Aprendizados.onShow();
            }
        }
    },

    // ── Resolver data relativa da IA para YYYY-MM-DD ─────────────────────
    _aiResolveDateTarget(target) {
        if (!target || target === 'hoje') return this.getDateString();

        const today = new Date();

        if (target === 'amanha') {
            const d = new Date(today);
            d.setDate(d.getDate() + 1);
            return this.getDateString(d);
        }

        if (target === 'ontem') {
            const d = new Date(today);
            d.setDate(d.getDate() - 1);
            return this.getDateString(d);
        }

        // Dia da semana: "segunda", "terca", "quarta", etc → próximo dia com esse nome
        const diasMap = {
            'domingo': 0, 'segunda': 1, 'terca': 2, 'terça': 2,
            'quarta': 3, 'quinta': 4, 'sexta': 5, 'sabado': 6, 'sábado': 6
        };
        const targetLower = target.toLowerCase().trim();
        if (diasMap[targetLower] !== undefined) {
            const targetDay = diasMap[targetLower];
            const currentDay = today.getDay();
            let diff = targetDay - currentDay;
            if (diff <= 0) diff += 7; // sempre o próximo (não hoje)
            const d = new Date(today);
            d.setDate(d.getDate() + diff);
            return this.getDateString(d);
        }

        // Se já é YYYY-MM-DD, usar direto
        if (/^\d{4}-\d{2}-\d{2}$/.test(target)) return target;

        // Fallback: hoje
        return this.getDateString();
    },

    // ── Label legível para a data ────────────────────────────────────────
    _aiDateLabel(dateStr) {
        const today = this.getDateString();
        if (dateStr === today) return 'hoje';

        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        if (dateStr === this.getDateString(tomorrow)) return 'amanhã';

        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        if (dateStr === this.getDateString(yesterday)) return 'ontem';

        // Dia da semana + dia
        const d = new Date(dateStr + 'T12:00:00');
        const dias = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
        return dias[d.getDay()] + ' dia ' + d.getDate();
    },

    // ── Slash Menu (/menção) ─────────────────────────────────────────────

    _slashGetAllItems() {
        const catLabels = { clientes: '👤 Clientes', categorias: '🏢 Empresa', atividades: '🎯 Pessoal' };
        const all = [];
        for (const cat of ['clientes', 'categorias', 'atividades']) {
            const items = (typeof APP_DATA !== 'undefined' && APP_DATA[cat]) || [];
            for (const item of items) {
                all.push({ cat, catLabel: catLabels[cat], id: item.id, name: item.name });
            }
        }
        return all;
    },

    _slashOnInput() {
        const input = document.getElementById('aiInput');
        if (!input) return;

        const val = input.value;
        const cursor = input.selectionStart;

        // Find the last '/' before cursor that starts a "word" (beginning of input or after space/newline)
        let slashPos = -1;
        for (let i = cursor - 1; i >= 0; i--) {
            if (val[i] === '/') {
                // Valid if at start or preceded by whitespace
                if (i === 0 || /[\s\n]/.test(val[i - 1])) {
                    slashPos = i;
                }
                break;
            }
            // Stop if we hit whitespace (no / found in this word)
            if (/[\s\n]/.test(val[i])) break;
        }

        if (slashPos === -1) {
            this._slashClose();
            return;
        }

        this._slashStart = slashPos;
        const query = val.slice(slashPos + 1, cursor).toLowerCase();
        this._slashRender(query);
    },

    _slashRender(query) {
        const allItems = this._slashGetAllItems();

        // Filter by query
        const filtered = query
            ? allItems.filter(it =>
                it.name.toLowerCase().includes(query) ||
                it.id.toLowerCase().includes(query)
            )
            : allItems;

        if (filtered.length === 0) {
            this._slashClose();
            return;
        }

        // Create or reuse menu
        if (!this._slashMenu) {
            this._slashMenu = document.createElement('div');
            this._slashMenu.className = 'ai-slash-menu';
            // Position above the input area
            const inputArea = document.querySelector('.ai-input-area');
            if (inputArea) {
                inputArea.style.position = 'relative';
                inputArea.insertBefore(this._slashMenu, inputArea.firstChild);
            } else {
                document.body.appendChild(this._slashMenu);
            }
        }

        this._slashMenu.innerHTML = '';
        this._slashIdx = 0;

        let lastCat = '';
        let itemIdx = 0;
        for (const it of filtered) {
            if (it.catLabel !== lastCat) {
                const catEl = document.createElement('div');
                catEl.className = 'ai-slash-cat';
                catEl.textContent = it.catLabel;
                this._slashMenu.appendChild(catEl);
                lastCat = it.catLabel;
            }
            const btn = document.createElement('div');
            btn.className = 'ai-slash-item' + (itemIdx === 0 ? ' active' : '');
            btn.dataset.idx = String(itemIdx);
            btn.dataset.name = it.name;
            btn.dataset.id = it.id;
            btn.dataset.cat = it.cat;
            btn.textContent = it.name;
            btn.addEventListener('mouseenter', () => {
                this._slashMenu.querySelectorAll('.ai-slash-item.active').forEach(el => el.classList.remove('active'));
                btn.classList.add('active');
                this._slashIdx = parseInt(btn.dataset.idx);
            });
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this._slashSelectItem(it.name);
            });
            this._slashMenu.appendChild(btn);
            itemIdx++;
        }

        this._slashMenu.style.display = 'block';
    },

    _slashNavigate(dir) {
        if (!this._slashMenu) return;
        const items = this._slashMenu.querySelectorAll('.ai-slash-item');
        if (!items.length) return;

        items[this._slashIdx]?.classList.remove('active');
        this._slashIdx = (this._slashIdx + dir + items.length) % items.length;
        items[this._slashIdx]?.classList.add('active');

        // Scroll into view
        items[this._slashIdx]?.scrollIntoView({ block: 'nearest' });
    },

    _slashSelectCurrent() {
        if (!this._slashMenu) return;
        const active = this._slashMenu.querySelector('.ai-slash-item.active');
        if (active) {
            this._slashSelectItem(active.dataset.name);
        }
    },

    _slashSelectItem(name) {
        const input = document.getElementById('aiInput');
        if (!input) { this._slashClose(); return; }

        const val = input.value;
        const cursor = input.selectionStart;
        const before = val.slice(0, this._slashStart);
        const after = val.slice(cursor);

        // Replace /query with the item name + trailing space
        const newVal = before + name + ' ' + after;
        input.value = newVal;

        // Position cursor after the inserted name
        const newCursor = before.length + name.length + 1;
        input.setSelectionRange(newCursor, newCursor);
        input.focus();

        this._slashClose();
    },

    _slashClose() {
        if (this._slashMenu) {
            this._slashMenu.style.display = 'none';
            this._slashMenu.innerHTML = '';
        }
        this._slashIdx = -1;
        this._slashStart = -1;
    },

    // ── Markdown seguro (sem innerHTML com conteúdo cru) ─────────────────
    _renderMarkdown(text, addBlockActions = false) {
        const frag = document.createDocumentFragment();
        const lines = text.split('\n');
        let inList = false;
        let currentList = null;
        let inBlockquote = false;
        let bqContent = [];

        // Wrap a rendered element in a .ai-block-wrap with action toolbar
        const wrapBlock = (el, rawText) => {
            if (!addBlockActions) return el;
            const wrap = document.createElement('div');
            wrap.className = 'ai-block-wrap';
            wrap.appendChild(el);
            wrap.appendChild(this._createBlockToolbar(rawText));
            return wrap;
        };

        const flushBlockquote = () => {
            if (inBlockquote && bqContent.length) {
                // Each blockquote line gets its own toolbar
                for (const line of bqContent) {
                    const bq = document.createElement('blockquote');
                    bq.appendChild(this._inlineFormat(line));
                    frag.appendChild(wrapBlock(bq, line));
                }
            }
            inBlockquote = false;
            bqContent = [];
        };

        const flushList = () => {
            if (inList && currentList) { frag.appendChild(currentList); }
            inList = false;
            currentList = null;
        };

        for (let i = 0; i < lines.length; i++) {
            const raw = lines[i];
            const trimmed = raw.trim();

            // Empty line = flush + spacer
            if (!trimmed) {
                flushBlockquote();
                flushList();
                continue;
            }

            // Blockquote
            if (trimmed.startsWith('> ')) {
                flushList();
                inBlockquote = true;
                bqContent.push(trimmed.slice(2));
                continue;
            } else if (inBlockquote) {
                flushBlockquote();
            }

            // Heading ##
            const hMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
            if (hMatch) {
                flushList();
                const level = Math.min(hMatch[1].length, 4);
                const h = document.createElement('h' + (level + 1)); // ## → h3, ### → h4
                h.appendChild(this._inlineFormat(hMatch[2]));
                frag.appendChild(wrapBlock(h, hMatch[2]));
                continue;
            }

            // Unordered list item — each <li> gets its own toolbar
            if (/^[-*]\s+/.test(trimmed)) {
                flushBlockquote();
                if (!inList) {
                    currentList = document.createElement('ul');
                    inList = true;
                }
                const liText = trimmed.replace(/^[-*]\s+/, '');
                const li = document.createElement('li');
                if (addBlockActions) {
                    const liInner = document.createElement('div');
                    liInner.className = 'ai-block-wrap ai-block-wrap--li';
                    const span = document.createElement('span');
                    span.appendChild(this._inlineFormat(liText));
                    liInner.appendChild(span);
                    liInner.appendChild(this._createBlockToolbar(liText));
                    li.appendChild(liInner);
                } else {
                    li.appendChild(this._inlineFormat(liText));
                }
                currentList.appendChild(li);
                continue;
            }

            // Numbered list — each <li> gets its own toolbar
            if (/^\d+[.)]\s+/.test(trimmed)) {
                flushBlockquote();
                if (!inList || currentList?.tagName !== 'OL') {
                    flushList();
                    currentList = document.createElement('ol');
                    inList = true;
                }
                const liText = trimmed.replace(/^\d+[.)]\s+/, '');
                const li = document.createElement('li');
                if (addBlockActions) {
                    const liInner = document.createElement('div');
                    liInner.className = 'ai-block-wrap ai-block-wrap--li';
                    const span = document.createElement('span');
                    span.appendChild(this._inlineFormat(liText));
                    liInner.appendChild(span);
                    liInner.appendChild(this._createBlockToolbar(liText));
                    li.appendChild(liInner);
                } else {
                    li.appendChild(this._inlineFormat(liText));
                }
                currentList.appendChild(li);
                continue;
            }

            // Regular paragraph
            flushList();
            flushBlockquote();
            const p = document.createElement('p');
            p.appendChild(this._inlineFormat(trimmed));
            frag.appendChild(wrapBlock(p, trimmed));
        }

        flushList();
        flushBlockquote();
        return frag;
    },

    // ── Toolbar de ações por bloco ───────────────────────────────────────
    _createBlockToolbar(rawText) {
        const bar = document.createElement('div');
        bar.className = 'ai-block-toolbar';

        // 1. Copiar
        const btnCopy = document.createElement('button');
        btnCopy.className = 'ai-block-btn';
        btnCopy.title = 'Copiar';
        btnCopy.textContent = '📋';
        btnCopy.addEventListener('click', (e) => {
            e.stopPropagation();
            // Strip markdown bold/italic markers for clean copy
            const clean = rawText.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1').replace(/`(.+?)`/g, '$1');
            navigator.clipboard.writeText(clean).then(() => {
                btnCopy.textContent = '✅';
                setTimeout(() => { btnCopy.textContent = '📋'; }, 1200);
            });
        });
        bar.appendChild(btnCopy);

        // 2. Adicionar como nota (hoje)
        const btnNote = document.createElement('button');
        btnNote.className = 'ai-block-btn';
        btnNote.title = 'Salvar como nota de hoje';
        btnNote.textContent = '📝';
        btnNote.addEventListener('click', (e) => {
            e.stopPropagation();
            this._aiShowItemPicker(btnNote, 'note', rawText);
        });
        bar.appendChild(btnNote);

        // 3. Adicionar como aprendizado
        const btnAprend = document.createElement('button');
        btnAprend.className = 'ai-block-btn';
        btnAprend.title = 'Salvar como aprendizado';
        btnAprend.textContent = '📚';
        btnAprend.addEventListener('click', (e) => {
            e.stopPropagation();
            this._aiShowItemPicker(btnAprend, 'aprendizado', rawText);
        });
        bar.appendChild(btnAprend);

        // 4. Mencionar (citar no input)
        const btnMention = document.createElement('button');
        btnMention.className = 'ai-block-btn';
        btnMention.title = 'Mencionar na resposta';
        btnMention.textContent = '💬';
        btnMention.addEventListener('click', (e) => {
            e.stopPropagation();
            const input = document.getElementById('aiInput');
            if (!input) return;
            const clean = rawText.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1').replace(/`(.+?)`/g, '$1');
            const quote = '> ' + clean + '\n\n';
            input.value = quote + input.value;
            input.focus();
            input.setSelectionRange(input.value.length, input.value.length);
            btnMention.textContent = '✅';
            setTimeout(() => { btnMention.textContent = '💬'; }, 1200);
        });
        bar.appendChild(btnMention);

        return bar;
    },

    // ── Item Picker (dropdown flutuante) ─────────────────────────────────
    _aiShowItemPicker(anchorBtn, mode, rawText) {
        // Remove picker existente
        document.querySelectorAll('.ai-item-picker').forEach(el => el.remove());

        const picker = document.createElement('div');
        picker.className = 'ai-item-picker';

        const catLabels = { clientes: '👤 Clientes', categorias: '🏢 Empresa', atividades: '🎯 Pessoal' };

        for (const cat of ['clientes', 'categorias', 'atividades']) {
            const items = (typeof APP_DATA !== 'undefined' && APP_DATA[cat]) || [];
            if (!items.length) continue;

            const catHeader = document.createElement('div');
            catHeader.className = 'ai-picker-cat';
            catHeader.textContent = catLabels[cat] || cat;
            picker.appendChild(catHeader);

            for (const item of items) {
                const btn = document.createElement('button');
                btn.className = 'ai-picker-item';
                btn.textContent = item.name;
                btn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    picker.remove();
                    await this._aiSaveToItem(mode, cat, item.id, item.name, rawText);
                    anchorBtn.textContent = '✅';
                    setTimeout(() => { anchorBtn.textContent = mode === 'note' ? '📝' : '📚'; }, 1500);
                });
                picker.appendChild(btn);
            }
        }

        // Posicionar o picker — garantir que não saia da tela
        document.body.appendChild(picker);
        const rect = anchorBtn.getBoundingClientRect();
        const pickerH = picker.offsetHeight || 320;
        const spaceBelow = window.innerHeight - rect.bottom - 8;
        if (spaceBelow >= pickerH) {
            picker.style.top = (rect.bottom + 4) + 'px';
        } else {
            picker.style.top = Math.max(8, rect.top - pickerH - 4) + 'px';
        }
        picker.style.left = Math.max(8, Math.min(rect.left - 60, window.innerWidth - 240)) + 'px';

        // Fechar ao clicar fora
        const closeHandler = (ev) => {
            if (!picker.contains(ev.target) && ev.target !== anchorBtn) {
                picker.remove();
                document.removeEventListener('click', closeHandler, true);
            }
        };
        setTimeout(() => document.addEventListener('click', closeHandler, true), 50);
    },

    // ── Salvar texto em nota (hoje) ou aprendizado ───────────────────────
    async _aiSaveToItem(mode, category, itemId, itemName, rawText) {
        const clean = rawText.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1').replace(/`(.+?)`/g, '$1');

        if (mode === 'note') {
            // Adicionar/append como nota do dia de hoje
            try {
                const dateStr = this.getDateString();
                const existing = await StorageManager.getItemStatus(dateStr, category, itemId);
                const currentNote = (existing && existing.note) || '';
                const newNote = currentNote ? currentNote + '\n' + clean : clean;
                const currentStatus = (existing && existing.status && existing.status !== 'none')
                    ? existing.status : 'em-andamento';
                await StorageManager.saveItemStatus(dateStr, category, itemId, currentStatus, newNote);
                this._appendActionFeedback('update',
                    `📝 Nota salva em **${itemName}** para hoje`
                );
            } catch (err) {
                console.error('AI save note error:', err);
                this._appendActionFeedback('update', `❌ Erro ao salvar nota`);
            }
        } else if (mode === 'aprendizado') {
            // Criar aprendizado
            try {
                let aprendData = await StorageManager.getAprendizados() || {};
                if (!aprendData[category]) aprendData[category] = {};
                if (!aprendData[category][itemId]) aprendData[category][itemId] = { notes: [] };
                const item = aprendData[category][itemId];
                if (!Array.isArray(item.notes)) {
                    item.notes = item.content ? [{
                        id: '__legacy__', title: '', content: item.content,
                        checkedLines: item.checkedLines || {}, updatedAt: new Date().toISOString()
                    }] : [];
                    delete item.content;
                    delete item.checkedLines;
                }
                // Gerar título curto do texto
                const title = clean.slice(0, 60) + (clean.length > 60 ? '…' : '');
                const noteId = 'ai_' + Date.now();
                item.notes.push({ id: noteId, title, content: clean, checkedLines: {}, updatedAt: new Date().toISOString() });
                await StorageManager.saveAprendizados(aprendData);
                // Sincronizar com o localStorage do módulo Aprendizados
                try { localStorage.setItem('aprendizadosData', JSON.stringify(aprendData)); } catch {}
                this._aiAprendizadosDirty = true;
                this._appendActionFeedback('aprendizado',
                    `📚 Aprendizado salvo em **${itemName}**: "${title}"`
                );
            } catch (err) {
                console.error('AI save aprendizado error:', err);
                this._appendActionFeedback('aprendizado', `❌ Erro ao salvar aprendizado`);
            }
        }
    },

    // Inline formatting: **bold**, *italic*, `code`, emoji-safe (XSS safe — uses textContent)
    _inlineFormat(text) {
        const frag = document.createDocumentFragment();
        // Regex for: **bold**, *italic*, `code`
        const re = /(\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`)/g;
        let lastIdx = 0;
        let match;
        while ((match = re.exec(text)) !== null) {
            // Text before match
            if (match.index > lastIdx) {
                frag.appendChild(document.createTextNode(text.slice(lastIdx, match.index)));
            }
            if (match[2] !== undefined) {
                // **bold**
                const strong = document.createElement('strong');
                strong.textContent = match[2];
                frag.appendChild(strong);
            } else if (match[3] !== undefined) {
                // *italic*
                const em = document.createElement('em');
                em.textContent = match[3];
                frag.appendChild(em);
            } else if (match[4] !== undefined) {
                // `code`
                const code = document.createElement('code');
                code.textContent = match[4];
                frag.appendChild(code);
            }
            lastIdx = re.lastIndex;
        }
        if (lastIdx < text.length) {
            frag.appendChild(document.createTextNode(text.slice(lastIdx)));
        }
        return frag;
    },

    // ── DOM helpers ──────────────────────────────────────────────────────

    _appendMessage(role, text) {
        const container = document.getElementById('aiMessages');
        if (!container) return;

        const wrapper = document.createElement('div');
        wrapper.className = `ai-bubble-wrap ai-bubble-wrap--${role}`;

        const bubble = document.createElement('div');
        bubble.className = `ai-bubble ai-bubble--${role}`;

        if (role === 'assistant') {
            // Render markdown with per-block action buttons
            bubble.appendChild(this._renderMarkdown(text, true));
            wrapper.appendChild(bubble);
        } else {
            // User messages: plain text (XSS safe)
            const paragraphs = text.split(/\n+/).filter(p => p.trim());
            if (paragraphs.length === 0) {
                const p = document.createElement('p');
                p.textContent = text;
                bubble.appendChild(p);
            } else {
                paragraphs.forEach(para => {
                    const p = document.createElement('p');
                    p.textContent = para.trim();
                    bubble.appendChild(p);
                });
            }
            wrapper.appendChild(bubble);
        }

        container.appendChild(wrapper);
        this._aiScrollToBottom();
    },

    // Action feedback with colored highlight
    _appendActionFeedback(type, text) {
        const container = document.getElementById('aiMessages');
        if (!container) return;

        const wrapper = document.createElement('div');
        wrapper.className = 'ai-bubble-wrap ai-bubble-wrap--action';

        const bubble = document.createElement('div');
        bubble.className = `ai-bubble ai-bubble--action ai-bubble--action-${type}`;
        bubble.appendChild(this._renderMarkdown(text));

        wrapper.appendChild(bubble);
        container.appendChild(wrapper);
        this._aiScrollToBottom();
    },

    _showTyping() {
        const container = document.getElementById('aiMessages');
        if (!container) return null;

        const el = document.createElement('div');
        el.className = 'ai-typing';
        el.appendChild(document.createElement('span'));
        el.appendChild(document.createElement('span'));
        el.appendChild(document.createElement('span'));
        container.appendChild(el);
        return el;
    },

    _removeTyping(el) {
        el?.remove();
    },

    _aiScrollToBottom() {
        const container = document.getElementById('aiMessages');
        if (container) {
            requestAnimationFrame(() => {
                container.scrollTop = container.scrollHeight;
            });
        }
    },

    // ── Feature 2: Abrir IA com contexto de um item específico ───────────
    _aiOpenWithItem(category, itemId, itemName, noteText, status) {
        this.showView('ai');

        const statusLabel = {
            'concluido': 'concluído', 'concluido-ongoing': 'concluído',
            'em-andamento': 'em andamento', 'bloqueado': 'bloqueado',
            'aguardando': 'aguardando', 'nao-feito': 'não feito',
            'parcialmente': 'parcialmente concluído', 'pular': 'pulado',
            'prioridade': 'prioridade', 'none': 'sem status',
        }[status] || 'sem status';

        let msg = '';

        if (noteText && noteText.trim()) {
            // ── COM NOTA: ajudar a entender/resolver o que está na nota ──
            msg = `Estou trabalhando na demanda "${itemName}" (status: ${statusLabel}). `
                + `A nota de hoje diz:\n\n"${noteText.trim()}"\n\n`
                + `Me ajuda a entender e resolver isso. O que devo fazer agora? `
                + `Depois me pergunta se houve algum aprendizado para registrar.`;
        } else {
            // ── SEM NOTA: buscar aprendizados para dar contexto ──────────
            let aprendContext = '';
            try {
                const aprendData = JSON.parse(localStorage.getItem('aprendizadosData') || '{}');
                const itemAprend = aprendData[category]?.[itemId];
                if (itemAprend) {
                    const notes = Array.isArray(itemAprend.notes) ? itemAprend.notes : [];
                    const validNotes = notes.filter(n => !n.deleted && n.content && n.content.trim());
                    if (validNotes.length > 0) {
                        const lines = [];
                        for (const n of validNotes.slice(0, 10)) {
                            const checked = n.checkedLines || {};
                            const noteLines = n.content.split('\n').filter(l => l.trim());
                            const pending = [];
                            const done = [];
                            noteLines.forEach((line, idx) => {
                                if (checked[String(idx)]) {
                                    done.push(line.trim());
                                } else {
                                    pending.push(line.trim());
                                }
                            });
                            let entry = `📝 "${n.title || 'sem título'}"`;
                            if (pending.length > 0) entry += `\n  ⬜ Pendente: ${pending.join('; ')}`;
                            if (done.length > 0) entry += `\n  ✅ Concluído: ${done.join('; ')}`;
                            lines.push(entry);
                        }
                        aprendContext = lines.join('\n');
                    }
                }
            } catch {}

            if (aprendContext) {
                // ── TEM APRENDIZADOS: sugerir ações baseadas no que falta ──
                msg = `Analisa a demanda "${itemName}" (status: ${statusLabel}). `
                    + `Não tem nota hoje, mas tem estes aprendizados registrados:\n\n${aprendContext}\n\n`
                    + `Com base no que está PENDENTE (⬜), sugira o que eu devo fazer HOJE nessa demanda. `
                    + `NÃO sugira o que já foi concluído (✅). `
                    + `Me dê um plano de ação concreto para avançar hoje. `
                    + `Depois me pergunta se houve algum aprendizado para registrar.`;
            } else {
                // ── SEM APRENDIZADOS E SEM NOTA: IA sugere livremente ──────
                msg = `Analisa a demanda "${itemName}" (status: ${statusLabel}). `
                    + `Não tem nota de hoje e nem aprendizados registrados para essa demanda. `
                    + `Com base no que você sabe da minha semana e dos meus dados, `
                    + `sugira o que eu posso fazer HOJE para avançar nessa demanda. `
                    + `Me dê sugestões concretas e um plano de ação. `
                    + `Depois me pergunta se houve algum aprendizado para registrar.`;
            }
        }

        // Auto-enviar a mensagem
        setTimeout(() => {
            this.sendAIMessage(msg);
        }, 200);
    },

});
