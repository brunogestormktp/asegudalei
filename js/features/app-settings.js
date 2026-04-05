// app-settings.js — Mixin: Settings view, drag-drop, item CRUD, category labels
// Extends HabitTrackerApp.prototype

Object.assign(HabitTrackerApp.prototype, {

    // ─── Settings: aplicar configurações salvas no DOM e em APP_DATA ────

    /**
     * Lê as configurações do StorageManager e aplica:
     *  - rótulos das quick-nav e títulos de categoria
     *  - nomes personalizados dos itens em APP_DATA (in-memory)
     *  - ordem dos itens em APP_DATA (in-memory)
     */
    applySettings() {
        const s = StorageManager.getSettings();

        ['clientes', 'categorias', 'atividades'].forEach(cat => {
            // 1. Resetar para o estado original (snapshot imutável)
            const original = APP_DATA_ORIGINAL[cat].map(i => ({ ...i }));

            // 2. Aplicar nomes customizados aos originais
            if (s.itemNames && s.itemNames[cat]) {
                original.forEach(item => {
                    if (s.itemNames[cat][item.id] !== undefined) {
                        item.name = s.itemNames[cat][item.id];
                    }
                });
            }

            // 3. Remover itens ocultos (hiddenItems)
            const hidden = (s.hiddenItems && s.hiddenItems[cat]) || [];
            const visible = original.filter(i => !hidden.includes(i.id));

            // 4. Injetar itens customizados (se ainda não estiverem presentes)
            const customList = (s.customItems && s.customItems[cat]) || [];
            const existingIds = new Set(visible.map(i => i.id));
            customList.forEach(ci => {
                if (!existingIds.has(ci.id)) {
                    const customName = (s.itemNames && s.itemNames[cat] && s.itemNames[cat][ci.id] !== undefined)
                        ? s.itemNames[cat][ci.id]
                        : ci.name;
                    visible.push({ id: ci.id, name: customName });
                }
            });

            // 5. Aplicar ordem customizada
            if (s.itemOrder && s.itemOrder[cat] && Array.isArray(s.itemOrder[cat])) {
                const order = s.itemOrder[cat];
                visible.sort((a, b) => {
                    const ai = order.indexOf(a.id);
                    const bi = order.indexOf(b.id);
                    if (ai === -1 && bi === -1) return 0;
                    if (ai === -1) return 1;
                    if (bi === -1) return -1;
                    return ai - bi;
                });
            }

            // 6. Substituir o array de APP_DATA
            APP_DATA[cat].length = 0;
            visible.forEach(i => APP_DATA[cat].push(i));
        });

        // 7. Rótulos das quick-nav (podem não estar no DOM ainda → guard)
        this._applySettingsCategoryLabels(s);
    },

    /**
     * Atualiza os textos dos botões .btn-quick-nav e os títulos .category-title
     * com base nas configurações salvas.
     */
    _applySettingsCategoryLabels(s) {
        if (!s || !s.categoryLabels) return;
        const map = {
            clientes:   { quickNav: '[data-target="category-clientes"]',   title: '#category-clientes .category-title' },
            categorias: { quickNav: '[data-target="category-categorias"]', title: '#category-categorias .category-title' },
            atividades: { quickNav: '[data-target="category-atividades"]', title: '#category-atividades .category-title' },
        };
        Object.entries(map).forEach(([cat, sel]) => {
            const label = s.categoryLabels[cat];
            if (!label) return;
            const qnBtn = document.querySelector('.btn-quick-nav' + sel.quickNav);
            if (qnBtn) qnBtn.textContent = label;
            const titleEl = document.querySelector(sel.title);
            if (titleEl) titleEl.textContent = label.toUpperCase();
        });
    },

    /**
     * Renderiza o painel de Configurações, populando os inputs e listas de itens.
     */
    renderSettingsView() {
        const s = StorageManager.getSettings();
        const cats = [
            { key: 'clientes',   inputId: 'settingsCatLabelClientes',   listId: 'settingsItemsClientes',   addBtnId: 'settingsAddClientes',   badgeId: 'settingsBadgeClientes'   },
            { key: 'categorias', inputId: 'settingsCatLabelCategorias', listId: 'settingsItemsCategorias', addBtnId: 'settingsAddCategorias', badgeId: 'settingsBadgeCategorias' },
            { key: 'atividades', inputId: 'settingsCatLabelAtividades', listId: 'settingsItemsAtividades', addBtnId: 'settingsAddAtividades', badgeId: 'settingsBadgeAtividades'  },
        ];

        // IDs dos itens originais (para distinguir custom vs original ao excluir)
        const originalIds = {
            clientes:   new Set(APP_DATA_ORIGINAL.clientes.map(i => i.id)),
            categorias: new Set(APP_DATA_ORIGINAL.categorias.map(i => i.id)),
            atividades: new Set(APP_DATA_ORIGINAL.atividades.map(i => i.id)),
        };

        cats.forEach(({ key, inputId, listId, addBtnId, badgeId }) => {
            // Preencher input de rótulo da categoria
            const labelInput = document.getElementById(inputId);
            if (labelInput) {
                labelInput.value = (s.categoryLabels && s.categoryLabels[key]) || '';
                labelInput.oninput = null;
                labelInput.oninput = (e) => this._onCategoryLabelChange(key, e.target.value);
            }

            // Badge com contagem
            const badge = document.getElementById(badgeId);
            if (badge) badge.textContent = APP_DATA[key].length + ' itens';

            // Botão "+ Adicionar demanda"
            const addBtn = document.getElementById(addBtnId);
            if (addBtn) {
                addBtn.onclick = null;
                addBtn.onclick = () => this._onItemAdd(key);
            }

            // Renderizar lista de itens
            const listEl = document.getElementById(listId);
            if (!listEl) return;
            listEl.innerHTML = '';

            APP_DATA[key].forEach((item) => {
                const isCustom = !originalIds[key].has(item.id);
                const customName = (s.itemNames && s.itemNames[key] && s.itemNames[key][item.id] !== undefined)
                    ? s.itemNames[key][item.id]
                    : item.name;

                const row = document.createElement('div');
                row.className = 'settings-item-row';
                row.dataset.id = item.id;
                row.dataset.cat = key;
                row.draggable = true;

                row.innerHTML = `
                    <div class="settings-drag-handle" title="Arraste para reordenar">⠿</div>
                    <div class="settings-item-order-btns">
                        <button class="settings-order-btn" data-dir="up" title="Mover para cima">▲</button>
                        <button class="settings-order-btn" data-dir="down" title="Mover para baixo">▼</button>
                    </div>
                    <input type="text" class="settings-item-input" value="${this._escapeHtmlAttr(customName)}" placeholder="Digite o nome..." />
                    <button class="settings-context-btn" title="Contexto IA — descreva esta demanda para a IA">🧠</button>
                    <button class="settings-delete-btn" title="Remover demanda">✕</button>
                `;

                // Context IA button
                const contextBtn = row.querySelector('.settings-context-btn');
                const existingContext = (s.itemContexts && s.itemContexts[key] && s.itemContexts[key][item.id]) || '';
                if (existingContext) contextBtn.classList.add('settings-context-btn--filled');
                contextBtn.addEventListener('click', () => this._openDemandContextModal(key, item.id, customName));

                // ▲▼ buttons
                row.querySelector('[data-dir="up"]').addEventListener('click', () => this._onItemMove(key, item.id, -1));
                row.querySelector('[data-dir="down"]').addEventListener('click', () => this._onItemMove(key, item.id, 1));

                // Name change (live)
                const nameInput = row.querySelector('.settings-item-input');
                nameInput.addEventListener('input', () => this._onItemNameChange(key, item.id, nameInput.value));

                // Focus highlight on row
                nameInput.addEventListener('focus', () => row.classList.add('settings-item-row--editing'));
                nameInput.addEventListener('blur',  () => row.classList.remove('settings-item-row--editing'));

                // Delete button with inline confirmation
                const deleteBtn = row.querySelector('.settings-delete-btn');
                deleteBtn.addEventListener('click', () => {
                    if (deleteBtn.dataset.confirming === '1') {
                        this._onItemDelete(key, item.id, isCustom);
                    } else {
                        deleteBtn.dataset.confirming = '1';
                        deleteBtn.textContent = '?';
                        deleteBtn.classList.add('settings-delete-btn--confirm');
                        setTimeout(() => {
                            if (deleteBtn.dataset.confirming === '1') {
                                delete deleteBtn.dataset.confirming;
                                deleteBtn.textContent = '✕';
                                deleteBtn.classList.remove('settings-delete-btn--confirm');
                            }
                        }, 2500);
                    }
                });

                listEl.appendChild(row);
            });

            // Ativar drag-and-drop nesta lista
            this._initDragDrop(listEl, key);
        });

        // Populate ranking profile section
        this._renderRankingSettingsSection();
    },

    /** Inicializa drag-and-drop HTML5 em uma settings-items-list */
    _initDragDrop(listEl, cat) {
        let dragSrc = null;

        listEl.addEventListener('dragstart', (e) => {
            const row = e.target.closest('.settings-item-row');
            if (!row) return;
            dragSrc = row;
            row.classList.add('settings-item-row--dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', row.dataset.id);
        });

        listEl.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            const row = e.target.closest('.settings-item-row');
            if (!row || row === dragSrc) return;
            // Indicador visual de posição
            listEl.querySelectorAll('.settings-item-row').forEach(r => r.classList.remove('settings-item-row--dragover'));
            row.classList.add('settings-item-row--dragover');
        });

        listEl.addEventListener('dragleave', (e) => {
            const row = e.target.closest('.settings-item-row');
            if (row) row.classList.remove('settings-item-row--dragover');
        });

        listEl.addEventListener('dragend', () => {
            listEl.querySelectorAll('.settings-item-row').forEach(r => {
                r.classList.remove('settings-item-row--dragging', 'settings-item-row--dragover');
            });
            dragSrc = null;
        });

        listEl.addEventListener('drop', (e) => {
            e.preventDefault();
            const target = e.target.closest('.settings-item-row');
            if (!target || !dragSrc || target === dragSrc) return;

            // Reordenar baseado na posição DOM atual (após drop)
            const rows = [...listEl.querySelectorAll('.settings-item-row')];
            const fromIdx = rows.indexOf(dragSrc);
            const toIdx   = rows.indexOf(target);
            if (fromIdx === -1 || toIdx === -1) return;

            // Determinar se insere antes ou depois
            const targetRect = target.getBoundingClientRect();
            const midY = targetRect.top + targetRect.height / 2;
            const insertBefore = e.clientY < midY;

            if (insertBefore) {
                listEl.insertBefore(dragSrc, target);
            } else {
                listEl.insertBefore(dragSrc, target.nextSibling);
            }

            // Reconstruir ordem a partir da DOM atual
            const newOrder = [...listEl.querySelectorAll('.settings-item-row')].map(r => r.dataset.id);

            // Atualizar APP_DATA com a nova ordem
            const items = APP_DATA[cat];
            const reordered = newOrder.map(id => items.find(i => i.id === id)).filter(Boolean);
            // Adicionar itens que não apareceram no DOM (edge case)
            items.forEach(i => { if (!reordered.find(r => r.id === i.id)) reordered.push(i); });
            APP_DATA[cat].length = 0;
            reordered.forEach(i => APP_DATA[cat].push(i));

            // Persistir ordem
            const s = StorageManager.getSettings();
            if (!s.itemOrder) s.itemOrder = {};
            s.itemOrder[cat] = APP_DATA[cat].map(i => i.id);
            StorageManager.saveSettings(s);

            // Atualizar badge
            const badgeMap = { clientes: 'settingsBadgeClientes', categorias: 'settingsBadgeCategorias', atividades: 'settingsBadgeAtividades' };
            const badge = document.getElementById(badgeMap[cat]);
            if (badge) badge.textContent = APP_DATA[cat].length + ' itens';

            // Re-renderizar today/history para refletir nova ordem
            this._reRenderAfterSettingsChange();
        });
    },

    /** Adiciona uma nova demanda customizada a uma categoria */
    _onItemAdd(cat) {
        const newId   = 'custom_' + Date.now();
        const newName = 'Nova demanda';

        const s = StorageManager.getSettings();
        if (!s.customItems) s.customItems = { clientes: [], categorias: [], atividades: [] };
        if (!s.customItems[cat]) s.customItems[cat] = [];
        s.customItems[cat].push({ id: newId, name: newName });

        // Adicionar ao final de APP_DATA em memória
        APP_DATA[cat].push({ id: newId, name: newName });

        // Persistir ordem (incluindo novo item)
        if (!s.itemOrder) s.itemOrder = {};
        s.itemOrder[cat] = APP_DATA[cat].map(i => i.id);
        StorageManager.saveSettings(s);

        // Re-renderizar settings e views
        this.renderSettingsView();
        this._reRenderAfterSettingsChange();

        // Focar no input do novo item para edição imediata
        requestAnimationFrame(() => {
            const listIdMap = { clientes: 'settingsItemsClientes', categorias: 'settingsItemsCategorias', atividades: 'settingsItemsAtividades' };
            const listEl = document.getElementById(listIdMap[cat]);
            if (!listEl) return;
            const rows = listEl.querySelectorAll('.settings-item-row');
            const lastRow = rows[rows.length - 1];
            if (lastRow) {
                const inp = lastRow.querySelector('.settings-item-input');
                if (inp) { inp.select(); inp.focus(); }
            }
        });
    },

    /** Remove (oculta ou apaga) uma demanda */
    _onItemDelete(cat, itemId, isCustom) {
        const s = StorageManager.getSettings();

        // Preserve item name for historical report display
        const itemToDelete = APP_DATA[cat]?.find(i => i.id === itemId);
        if (itemToDelete) {
            if (!s.deletedItemNames) s.deletedItemNames = {};
            s.deletedItemNames[itemId] = itemToDelete.name;
        }

        if (isCustom) {
            // Item customizado: remover de customItems
            if (s.customItems && s.customItems[cat]) {
                s.customItems[cat] = s.customItems[cat].filter(i => i.id !== itemId);
            }
            // Limpar nome customizado se houver
            if (s.itemNames && s.itemNames[cat]) {
                delete s.itemNames[cat][itemId];
            }
        } else {
            // Item original: adicionar a hiddenItems
            if (!s.hiddenItems) s.hiddenItems = { clientes: [], categorias: [], atividades: [] };
            if (!s.hiddenItems[cat]) s.hiddenItems[cat] = [];
            if (!s.hiddenItems[cat].includes(itemId)) {
                s.hiddenItems[cat].push(itemId);
            }
        }

        // Remover da ordem salva
        if (s.itemOrder && s.itemOrder[cat]) {
            s.itemOrder[cat] = s.itemOrder[cat].filter(id => id !== itemId);
        }

        StorageManager.saveSettings(s);

        // Remover de APP_DATA em memória
        const idx = APP_DATA[cat].findIndex(i => i.id === itemId);
        if (idx !== -1) APP_DATA[cat].splice(idx, 1);

        // Re-renderizar
        this.renderSettingsView();
        this._reRenderAfterSettingsChange();
    },

    /** Re-renderiza today e/ou history após mudanças de settings */
    _reRenderAfterSettingsChange() {
        if (this.currentView === 'today') {
            this._todayScrollTop = window.scrollY;
            this._pendingScrollRestore = true;
            this.renderTodayView();
        } else if (this.currentView === 'history') {
            this._reRenderHistory();
        }
        // Nas outras views, a próxima visita ao today/history vai usar APP_DATA atualizado
    },

    /** Chamado quando o usuário muda o rótulo de uma categoria */
    _onCategoryLabelChange(cat, newLabel) {
        if (typeof newLabel !== 'string') return;
        newLabel = newLabel.slice(0, 50); // máx 50 chars
        const s = StorageManager.getSettings();
        if (!s.categoryLabels) s.categoryLabels = {};
        s.categoryLabels[cat] = newLabel;
        StorageManager.saveSettings(s);
        this._applySettingsCategoryLabels(s);
    },

    /** Chamado quando o usuário muda o nome de um item */
    _onItemNameChange(cat, itemId, newName) {
        if (typeof newName !== 'string') return;
        newName = newName.slice(0, 100); // máx 100 chars
        const s = StorageManager.getSettings();
        if (!s.itemNames) s.itemNames = {};
        if (!s.itemNames[cat]) s.itemNames[cat] = {};
        s.itemNames[cat][itemId] = newName;
        StorageManager.saveSettings(s);

        // Atualizar nome em APP_DATA (memória)
        const item = APP_DATA[cat].find(i => i.id === itemId);
        if (item) item.name = newName;

        // Atualizar .item-name em todayView em tempo real
        document.querySelectorAll(`.item[data-item-id="${itemId}"] .item-name`).forEach(el => {
            el.textContent = newName;
        });
    },

    /** Chamado quando o usuário move um item ▲ ou ▼ */
    _onItemMove(cat, itemId, direction) {
        const items = APP_DATA[cat];
        const idx = items.findIndex(i => i.id === itemId);
        if (idx === -1) return;
        const newIdx = idx + direction;
        if (newIdx < 0 || newIdx >= items.length) return;

        // Trocar posições em APP_DATA (memória)
        [items[idx], items[newIdx]] = [items[newIdx], items[idx]];

        // Persistir ordem
        const s = StorageManager.getSettings();
        if (!s.itemOrder) s.itemOrder = {};
        s.itemOrder[cat] = items.map(i => i.id);
        StorageManager.saveSettings(s);

        // Re-renderizar settings e views
        this.renderSettingsView();
        this._reRenderAfterSettingsChange();
    },

    // ── Demand Context Modal (Contexto IA) ─────────────────────────────

    /** Opens the demand context modal for a specific item */
    _openDemandContextModal(cat, itemId, itemName) {
        const modal = document.getElementById('demandContextModal');
        const titleEl = document.getElementById('demandContextTitle');
        const input = document.getElementById('demandContextInput');
        const saveBtn = document.getElementById('btnDemandContextSave');
        const cancelBtn = document.getElementById('btnDemandContextCancel');

        if (!modal || !input) return;

        // Set title
        if (titleEl) titleEl.textContent = `🧠 Contexto: ${itemName}`;

        // Load existing context
        const s = StorageManager.getSettings();
        const existing = (s.itemContexts && s.itemContexts[cat] && s.itemContexts[cat][itemId]) || '';
        input.value = existing;

        // Show modal
        modal.classList.add('show');
        setTimeout(() => input.focus(), 100);

        // Save handler
        const onSave = () => {
            const text = input.value.trim().slice(0, 2000); // max 2000 chars
            const settings = StorageManager.getSettings();
            if (!settings.itemContexts) settings.itemContexts = { clientes: {}, categorias: {}, atividades: {} };
            if (!settings.itemContexts[cat]) settings.itemContexts[cat] = {};
            if (text) {
                settings.itemContexts[cat][itemId] = text;
            } else {
                delete settings.itemContexts[cat][itemId];
            }
            StorageManager.saveSettings(settings);
            modal.classList.remove('show');
            cleanup();
            // Update button visual
            this.renderSettingsView();
        };

        // Cancel handler
        const onCancel = () => {
            modal.classList.remove('show');
            cleanup();
        };

        // Close on backdrop click
        const onBackdrop = (e) => {
            if (e.target === modal) onCancel();
        };

        // Cleanup listeners
        const cleanup = () => {
            saveBtn?.removeEventListener('click', onSave);
            cancelBtn?.removeEventListener('click', onCancel);
            modal.removeEventListener('click', onBackdrop);
        };

        // Attach listeners
        saveBtn?.addEventListener('click', onSave);
        cancelBtn?.addEventListener('click', onCancel);
        modal.addEventListener('click', onBackdrop);
    },

    // ── Ranking Profile Settings ─────────────────────────────────────────

    /** Loads ranking profile from user_rankings and populates the settings fields */
    async _renderRankingSettingsSection() {
        const sb = StorageManager.getSupabase();
        const userId = StorageManager.getUserId();
        const nameInput = document.getElementById('rankingDisplayName');
        const showToggle = document.getElementById('rankingShowToggle');
        const saveBtn = document.getElementById('rankingSettingsSave');
        const feedback = document.getElementById('rankingSettingsFeedback');
        const avatarPreview = document.getElementById('rankingAvatarPreview');

        if (!nameInput || !showToggle || !saveBtn) return;

        // Load existing data
        if (sb && userId) {
            try {
                const { data } = await sb
                    .from('user_rankings')
                    .select('display_name, show_in_ranking, avatar_url')
                    .eq('user_id', userId)
                    .single();

                if (data) {
                    nameInput.value = data.display_name || '';
                    showToggle.checked = data.show_in_ranking !== false;
                    // Show current avatar
                    if (avatarPreview && data.avatar_url) {
                        avatarPreview.style.backgroundImage = `url(${data.avatar_url})`;
                        avatarPreview.style.backgroundSize = 'cover';
                        avatarPreview.style.backgroundPosition = 'center';
                        avatarPreview.textContent = '';
                    }
                }
            } catch (err) {
                console.warn('Could not load ranking profile:', err);
            }
        }

        // Setup save handler (remove previous to avoid duplicates)
        saveBtn.onclick = null;
        saveBtn.onclick = () => this._saveRankingProfile();

        // Photo preview on change
        const photoInput = document.getElementById('rankingPhotoInput');
        if (photoInput) {
            photoInput.onchange = null;
            photoInput.onchange = (e) => {
                const file = e.target.files?.[0];
                if (!file || !avatarPreview) return;
                const url = URL.createObjectURL(file);
                avatarPreview.style.backgroundImage = `url(${url})`;
                avatarPreview.style.backgroundSize = 'cover';
                avatarPreview.style.backgroundPosition = 'center';
                avatarPreview.textContent = '';
            };
        }
    },

    /** Sanitizes display_name — removes dangerous chars, trims, max 50 */
    _sanitizeDisplayName(name) {
        if (!name || typeof name !== 'string') return 'Anônimo';
        return name
            .trim()
            .slice(0, 50)
            .replace(/[<>"'`]/g, '')
            .replace(/\s+/g, ' ')
            .trim() || 'Anônimo';
    },

    /** Saves ranking profile (display_name + show_in_ranking + avatar) to user_rankings */
    async _saveRankingProfile() {
        const sb = StorageManager.getSupabase();
        const userId = StorageManager.getUserId();
        const nameInput = document.getElementById('rankingDisplayName');
        const showToggle = document.getElementById('rankingShowToggle');
        const feedback = document.getElementById('rankingSettingsFeedback');
        const photoInput = document.getElementById('rankingPhotoInput');

        if (!sb || !userId || !nameInput || !showToggle) return;

        const displayName = this._sanitizeDisplayName(nameInput.value);
        const showInRanking = showToggle.checked;

        // Update input with sanitized value
        nameInput.value = displayName;

        if (feedback) {
            feedback.textContent = 'Salvando...';
            feedback.className = 'ranking-settings-feedback';
        }

        try {
            // Upload photo if provided
            let avatarUrl = null;
            const file = photoInput?.files?.[0];
            if (file && file.size <= 2097152) {
                const allowedTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
                if (allowedTypes.includes(file.type)) {
                    const ext = file.name.split('.').pop().toLowerCase();
                    const path = `${userId}/avatar.${ext}`;
                    const { data: uploadData, error: uploadError } = await sb.storage
                        .from('avatars')
                        .upload(path, file, { upsert: true });

                    if (uploadData && !uploadError) {
                        const { data: urlData } = sb.storage.from('avatars').getPublicUrl(path);
                        avatarUrl = urlData?.publicUrl || null;
                    } else if (uploadError) {
                        console.warn('Avatar upload error:', uploadError);
                    }
                }
            }

            const upsertPayload = {
                user_id: userId,
                display_name: displayName,
                show_in_ranking: showInRanking,
            };
            if (avatarUrl) {
                upsertPayload.avatar_url = avatarUrl;
            }

            const { error } = await sb
                .from('user_rankings')
                .upsert(upsertPayload, { onConflict: 'user_id' });

            if (error) {
                console.error('Save ranking profile error:', error);
                if (feedback) {
                    feedback.textContent = '❌ Erro ao salvar';
                    feedback.className = 'ranking-settings-feedback ranking-settings-feedback--error';
                }
                return;
            }

            // Clear file input after successful upload
            if (photoInput) photoInput.value = '';

            if (feedback) {
                feedback.textContent = '✅ Perfil salvo!';
                feedback.className = 'ranking-settings-feedback ranking-settings-feedback--success';
                setTimeout(() => { feedback.textContent = ''; }, 3000);
            }
        } catch (err) {
            console.error('Save ranking profile exception:', err);
            if (feedback) {
                feedback.textContent = '❌ Erro ao salvar';
                feedback.className = 'ranking-settings-feedback ranking-settings-feedback--error';
            }
        }
    },

});
