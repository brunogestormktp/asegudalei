// app-history.js — Mixin: History view, date navigation, day cards, spreadsheet rendering
// Extends HabitTrackerApp.prototype

Object.assign(HabitTrackerApp.prototype, {

    changeHistoryDate(days) {
        this._historyDateRange = null; // exit range mode when navigating days
        this._historyScrollTop = 0; // reset saved scroll when changing date
        if (!this.historyDate) {
            this.historyDate = new Date();
            this.historyDate.setHours(12, 0, 0, 0);
        }
        this.historyDate.setDate(this.historyDate.getDate() + days);
        this._updateHistoryDateLabel();
        window.scrollTo(0, 0);
        this.renderHistoryAsSpreadsheet(this.getDateString(this.historyDate));
    },

    _reRenderHistory() {
        if (!this.historyDate) {
            this.historyDate = new Date();
            this.historyDate.setHours(12, 0, 0, 0);
        }
        this.renderHistoryAsSpreadsheet(this.getDateString(this.historyDate));
    },

    _updateHistoryDateLabel() {
        const el = document.getElementById('historyCurrentDate');
        if (!el) return;
        if (this._historyDateRange) {
            el.textContent = this._historyDateRange.label || 'Semana';
        } else if (this.historyDate) {
            el.textContent = this.formatDate(this.historyDate);
        }
    },

    /** Renders history for a date range (used when navigating from demand cards) */
    async _renderHistoryRange(container, searchQuery, statusFilter) {
        const { start, end } = this._historyDateRange;
        const statusColors = {
            'concluido': '#22c55e', 'concluido-ongoing': '#22c55e', 'em-andamento': '#eab308',
            'nao-feito': '#ef4444', 'bloqueado': 'rgba(239,68,68,0.6)', 'aguardando': '#95d3ee',
            'parcialmente': '#f97316', 'prioridade': '#a855f7', 'pular': 'rgba(255,255,255,0.25)', 'none': 'transparent'
        };
        const statusLabels = {
            'concluido': 'Concluído', 'concluido-ongoing': 'Concluído', 'em-andamento': 'Em Andamento',
            'nao-feito': 'Não Feito', 'bloqueado': 'Bloqueado', 'aguardando': 'Aguardando',
            'parcialmente': 'Parcialmente', 'prioridade': 'Prioridade', 'pular': 'Pulado', 'none': '—'
        };
        const categoryConfig = [
            { key: 'clientes',   emoji: '👥', label: 'CLIENTES',  color: '#95d3ee' },
            { key: 'categorias', emoji: '🏢', label: 'EMPRESA',   color: '#f59e0b' },
            { key: 'atividades', emoji: '👤', label: 'PESSOAL',   color: '#a78bfa' }
        ];

        const current = new Date(start);
        current.setHours(12, 0, 0, 0);
        const endLimit = new Date(end);
        endLimit.setHours(23, 59, 59, 999);
        let hasAny = false;

        while (current <= endLimit) {
            const dateStr = this.getDateString(current);
            const dayData = await StorageManager.getDateData(dateStr);
            const dayOfWeek = ['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'][current.getDay()];
            const dayNum = current.getDate();
            const month = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'][current.getMonth()];

            const rows = [];
            for (const cat of categoryConfig) {
                const catRawData = dayData[cat.key] || {};
                const catItemDefs = APP_DATA[cat.key] || [];
                for (const itemDef of catItemDefs) {
                    if (searchQuery && !itemDef.name.toLowerCase().includes(searchQuery)) continue;
                    const rawItem = catRawData[itemDef.id];
                    const status = rawItem ? (typeof rawItem === 'string' ? rawItem : rawItem.status || 'none') : 'none';
                    const note = rawItem ? (typeof rawItem === 'string' ? '' : rawItem.note || '') : '';
                    if (statusFilter !== 'all') {
                        if (statusFilter === 'none' && status !== 'none') continue;
                        else if (statusFilter === 'sem-nota' && note.trim()) continue;
                        else if (statusFilter !== 'none' && statusFilter !== 'sem-nota' &&
                                 status !== statusFilter && !(statusFilter === 'concluido' && status === 'concluido-ongoing')) continue;
                    }
                    const color = statusColors[status] || 'transparent';
                    const label = statusLabels[status] || status;
                    rows.push(`<div class="hs-row" data-status="${status}">
                        <span class="hs-status-dot" style="background:${color}"></span>
                        <span class="hs-item-name">${itemDef.name}</span>
                        <span class="hs-status-label" style="color:${color}">${label}</span>
                        ${note ? `<span class="hs-note">${this._buildNoteHtmlReadonly(note)}</span>` : ''}
                    </div>`);
                }
            }

            if (rows.length > 0) {
                hasAny = true;
                const dayHeader = document.createElement('div');
                dayHeader.className = 'hs-day-header';
                dayHeader.innerHTML = `<span class="hs-day-name">${dayOfWeek}</span><span class="hs-day-date">${dayNum} de ${month}</span>`;
                container.appendChild(dayHeader);
                const section = document.createElement('div');
                section.className = 'hs-category-section';
                section.innerHTML = rows.join('');
                container.appendChild(section);
            }

            current.setDate(current.getDate() + 1);
        }

        if (!hasAny) {
            container.innerHTML = '<div class="hs-empty" style="padding:2rem;text-align:center;opacity:0.5">Nenhum registro encontrado neste período.</div>';
        }
    },

    async renderHistoryAsSpreadsheet(dateStr) {
        const container = document.getElementById('historyContent');
        const statusFilter = this._activeHistoryFilter || 'all';
        const searchQuery  = (this._historySearchQuery || '').toLowerCase().trim();

        container.innerHTML = '';

        // Range mode: show multiple days for a specific demand item
        if (this._historyDateRange) {
            await this._renderHistoryRange(container, searchQuery, statusFilter);
            return;
        }

        const date = new Date(dateStr + 'T12:00:00');
        const dayData = await StorageManager.getDateData(dateStr);

        // Build categorized items (same logic as createDayCard)
        const categoryConfig = [
            { key: 'clientes',   emoji: '👥', label: 'CLIENTES',  color: '#95d3ee' },
            { key: 'categorias', emoji: '🏢', label: 'EMPRESA',   color: '#f59e0b' },
            { key: 'atividades', emoji: '👤', label: 'PESSOAL',   color: '#a78bfa' }
        ];

        const dayOfWeek = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'][date.getDay()];
        const dayNum    = date.getDate();
        const month     = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'][date.getMonth()];
        const year      = date.getFullYear();

        // Header do dia
        const dayHeader = document.createElement('div');
        dayHeader.className = 'hs-day-header';
        dayHeader.innerHTML = `
            <span class="hs-day-name">${dayOfWeek}</span>
            <span class="hs-day-date">${dayNum} de ${month} de ${year}</span>
        `;
        container.appendChild(dayHeader);

        const statusColors = {
            'concluido':         '#22c55e',
            'concluido-ongoing': '#22c55e',
            'em-andamento':      '#eab308',
            'nao-feito':         '#ef4444',
            'bloqueado':         'rgba(239,68,68,0.6)',
            'aguardando':        '#95d3ee',
            'parcialmente':      '#f97316',
            'prioridade':        '#a855f7',
            'pular':             'rgba(255,255,255,0.25)',
            'none':              'transparent'
        };
        const statusLabels = {
            'concluido':         'Concluído',
            'concluido-ongoing': 'Concluído',
            'em-andamento':      'Em Andamento',
            'nao-feito':         'Não Feito',
            'bloqueado':         'Bloqueado',
            'aguardando':        'Aguardando',
            'parcialmente':      'Parcialmente',
            'prioridade':        'Prioridade',
            'pular':             'Pulado',
            'none':              '—'
        };

        let hasAny = false;

        for (const cat of categoryConfig) {
            const catRawData = dayData[cat.key] || {};
            const catItemDefs = APP_DATA[cat.key] || [];

            // Collect items for this category
            const rows = [];
            for (const itemDef of catItemDefs) {
                const rawItem = catRawData[itemDef.id];
                const status  = rawItem ? (typeof rawItem === 'string' ? rawItem : rawItem.status || 'none') : 'none';
                const note    = rawItem ? (typeof rawItem === 'string' ? '' : rawItem.note || '') : '';

                // Filtro de status
                if (statusFilter !== 'all') {
                    if (statusFilter === 'none') {
                        if (status !== 'none') continue;
                    } else if (statusFilter === 'sem-nota') {
                        if (note.trim()) continue;
                    } else {
                        if (status !== statusFilter && !(statusFilter === 'concluido' && status === 'concluido-ongoing')) continue;
                    }
                }

                // Filtro de busca
                if (searchQuery && !itemDef.name.toLowerCase().includes(searchQuery) && !note.toLowerCase().includes(searchQuery)) continue;

                rows.push({ name: itemDef.name, status, note, id: itemDef.id, category: cat.key });
            }

            if (rows.length === 0) continue;
            hasAny = true;

            // Bloco da categoria
            const catBlock = document.createElement('div');
            catBlock.className = 'hs-cat-block';

            // Cabeçalho da categoria
            const catHeader = document.createElement('div');
            catHeader.className = 'hs-cat-header';
            catHeader.style.setProperty('--cat-color', cat.color);
            catHeader.innerHTML = `<span class="hs-cat-emoji">${cat.emoji}</span><span class="hs-cat-label">${cat.label}</span>`;
            catBlock.appendChild(catHeader);

            // Tabela real HTML
            const table = document.createElement('table');
            table.className = 'hs-table';

            // Cabeçalho da tabela
            const thead = document.createElement('thead');
            thead.className = 'hs-thead';
            thead.innerHTML = `
                <tr>
                    <th class="hs-th hs-col-demanda">Demanda</th>
                    <th class="hs-th hs-col-status">Status</th>
                    <th class="hs-th hs-col-notas">Notas</th>
                    <th class="hs-th hs-col-obs">Observações</th>
                </tr>
            `;
            table.appendChild(thead);

            const tbody = document.createElement('tbody');
            table.appendChild(tbody);

            // Linhas de dados
            for (const row of rows) {
                const sColor = statusColors[row.status] || 'transparent';
                const sLabel = statusLabels[row.status] || '—';
                const hasNote = row.note && row.note.trim();

                // ── Parser da nota: cada linha vira uma row na tabela ─────────
                // Separa em: notasLines, obsLines
                const notasLines = [];
                const obsLines   = [];

                if (hasNote) {
                    for (const line of row.note.trim().split('\n')) {
                        const t = line.trim();
                        if (!t) continue;
                        if (/^(🧠|🚫|⏳)/.test(t)) {
                            obsLines.push(t);
                        } else {
                            notasLines.push(t);
                        }
                    }
                }

                // Quantas linhas a demanda vai ocupar (mínimo 1)
                const rowCount = Math.max(notasLines.length, obsLines.length, 1);

                // Formata badge de obs
                const fmtObs = (t) => {
                    if (!t) return '';
                    if (t.startsWith('🧠')) return `<span class="hs-obs-badge hs-obs-aprendizado">${this.linkifyText(t)}</span>`;
                    if (t.startsWith('🚫')) return `<span class="hs-obs-badge hs-obs-bloqueado">${this.linkifyText(t)}</span>`;
                    if (t.startsWith('⏳')) return `<span class="hs-obs-badge hs-obs-parcial">${this.linkifyText(t)}</span>`;
                    return `<span class="hs-obs-badge">${this.linkifyText(t)}</span>`;
                };

                for (let i = 0; i < rowCount; i++) {
                    const tr = document.createElement('tr');
                    tr.className = 'hs-tr' + (i > 0 ? ' hs-tr-cont' : '') + (i === 0 ? ' hs-tr-nav' : '') + (row.status === 'pular' ? ' hs-tr-pular' : '');
                    if (i === 0) {
                        tr.dataset.itemId   = row.id;
                        tr.dataset.category = row.category;
                        tr.title = 'Ver no Hoje';
                    }

                    const notaCell  = notasLines[i] ? this._buildNoteHtmlReadonly(notasLines[i]) : '<span class="hs-empty-cell">—</span>';
                    const obsCell   = obsLines[i]   ? fmtObs(obsLines[i])            : '<span class="hs-empty-cell">—</span>';

                    if (i === 0) {
                        // Primeira linha: inclui demanda e status com rowspan
                        tr.innerHTML = `
                            <td class="hs-td hs-col-demanda" rowspan="${rowCount}">
                                <span class="hs-demanda-name">${row.name}</span>
                            </td>
                            <td class="hs-td hs-col-status" rowspan="${rowCount}">
                                <div class="hs-status-inner">
                                    ${row.status !== 'none'
                                        ? `<span class="hs-status-dot" style="background:${sColor}; box-shadow:0 0 6px ${sColor};"></span>`
                                        : `<span class="hs-status-dot hs-dot-empty"></span>`
                                    }
                                    <span class="hs-status-label" style="color:${row.status !== 'none' ? sColor : 'rgba(255,255,255,0.25)'};">${sLabel}</span>
                                </div>
                            </td>
                            <td class="hs-td hs-col-notas hs-text-cell">${notaCell}</td>
                            <td class="hs-td hs-col-obs hs-text-cell">${obsCell}</td>
                        `;
                    } else {
                        // Linhas continuação: só notas / obs
                        tr.innerHTML = `
                            <td class="hs-td hs-col-notas hs-text-cell">${notaCell}</td>
                            <td class="hs-td hs-col-obs hs-text-cell">${obsCell}</td>
                        `;
                    }

                    tbody.appendChild(tr);
                }
            }

            catBlock.appendChild(table);
            container.appendChild(catBlock);
        }

        if (!hasAny) {
            this.renderEmptyHistoryState(container);
        }

        // Restaurar scroll da aba Histórico após o DOM estar montado
        if (this._pendingHistoryScrollRestore) {
            this._pendingHistoryScrollRestore = false;
            const scrollTarget = this._historyScrollTop || 0;
            requestAnimationFrame(() => requestAnimationFrame(() => {
                window.scrollTo({ top: scrollTarget, behavior: 'instant' });
            }));
        }
    },

    async renderHistoryForSpecificDate(dateStr) {
        const container = document.getElementById('historyContent');
        const showEmpty = document.getElementById('toggleEmptyItems')?.checked || false;
        
        container.innerHTML = '';
        
        const date = new Date(dateStr + 'T12:00:00');
        const dayData = await StorageManager.getDateData(dateStr);
        
        if (Object.keys(dayData).length === 0) {
            this.renderEmptyHistoryState(container);
            return;
        }
        
        const dayCard = this.createDayCard(date, dayData, showEmpty);
        if (dayCard) {
            container.appendChild(dayCard);
        } else {
            this.renderEmptyHistoryState(container);
        }
    },

    async renderHistoryForCurrentWeek() {
        const container = document.getElementById('historyContent');
        const showEmpty = document.getElementById('toggleEmptyItems')?.checked || false;
        
        container.innerHTML = '';

        const today = new Date();
        const dayOfWeek = today.getDay(); // 0 = Sunday, 1 = Monday, ...
        const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek; // Get Monday of current week
        
        const startDate = new Date(today);
        startDate.setDate(today.getDate() + mondayOffset);
        
        const endDate = new Date(startDate);
        endDate.setDate(startDate.getDate() + 6); // Sunday

        const dates = [];
        for (let d = new Date(endDate); d >= startDate; d.setDate(d.getDate() - 1)) {
            if (d <= today) { // Only show dates up to today
                dates.push(new Date(d));
            }
        }

        let hasAnyData = false;
        
        for (const date of dates) {
            const dateStr = this.getDateString(date);
            const dayData = await StorageManager.getDateData(dateStr);
            
            if (Object.keys(dayData).length === 0) continue;
            
            const dayCard = this.createDayCard(date, dayData, showEmpty);
            if (dayCard) {
                container.appendChild(dayCard);
                hasAnyData = true;
            }
        }

        if (!hasAnyData) {
            this.renderEmptyHistoryState(container);
        }
    },

    async renderHistoryForCurrentMonth() {
        const container = document.getElementById('historyContent');
        const showEmpty = document.getElementById('toggleEmptyItems')?.checked || false;
        
        container.innerHTML = '';

        const today = new Date();
        const startDate = new Date(today.getFullYear(), today.getMonth(), 1);
        const endDate = new Date(today);

        const dates = [];
        for (let d = new Date(endDate); d >= startDate; d.setDate(d.getDate() - 1)) {
            dates.push(new Date(d));
        }

        let hasAnyData = false;
        
        for (const date of dates) {
            const dateStr = this.getDateString(date);
            const dayData = await StorageManager.getDateData(dateStr);
            
            if (Object.keys(dayData).length === 0) continue;
            
            const dayCard = this.createDayCard(date, dayData, showEmpty);
            if (dayCard) {
                container.appendChild(dayCard);
                hasAnyData = true;
            }
        }

        if (!hasAnyData) {
            this.renderEmptyHistoryState(container);
        }
    },

    async renderHistory(days) {
        const container = document.getElementById('historyContent');
        const showEmpty = document.getElementById('toggleEmptyItems')?.checked || false;
        
        container.innerHTML = '';

        const endDate = new Date();
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days);

        const dates = [];
        for (let d = new Date(endDate); d >= startDate; d.setDate(d.getDate() - 1)) {
            dates.push(new Date(d));
        }

        let hasAnyData = false;
        
        for (const date of dates) {
            const dateStr = this.getDateString(date);
            const dayData = await StorageManager.getDateData(dateStr);
            
            if (Object.keys(dayData).length === 0) continue;
            
            const dayCard = this.createDayCard(date, dayData, showEmpty);
            if (dayCard) {
                container.appendChild(dayCard);
                hasAnyData = true;
            }
        }

        if (!hasAnyData) {
            this.renderEmptyHistoryState(container);
        }
    },
    
    createDayCard(date, dayData, showEmpty) {
        // Organize items by category
        const categorizedItems = {
            clientes: [],
            categorias: [],
            atividades: []
        };
        
        let stats = {
            completed: 0,
            inProgress: 0,
            notDone: 0
        };
        
        ['clientes', 'categorias', 'atividades'].forEach(category => {
            if (dayData[category]) {
                const categoryData = APP_DATA[category];
                for (const itemId in dayData[category]) {
                    const item = categoryData.find(i => i.id === itemId);
                    if (item) {
                        const itemData = dayData[category][itemId];
                        const status = typeof itemData === 'string' ? itemData : itemData.status;
                        const note = typeof itemData === 'string' ? '' : (itemData.note || '');
                        
                        // Filter out empty items if toggle is off
                        const isEmpty = (!status || status === 'none') && (!note || !note.trim());
                        if (!showEmpty && isEmpty) continue;
                        
                        categorizedItems[category].push({
                            name: item.name,
                            status: status || 'none',
                            note: note
                        });
                        
                        // Update stats
                        if (status === 'concluido' || status === 'concluido-ongoing' || status === 'parcialmente') {
                            stats.completed++;
                        } else if (status === 'em-andamento') {
                            stats.inProgress++;
                        } else if (status === 'nao-feito' || status === 'bloqueado') {
                            stats.notDone++;
                        }
                    }
                }
            }
        });
        
        // Check if we have any items
        const totalItems = categorizedItems.clientes.length + 
                          categorizedItems.categorias.length + 
                          categorizedItems.atividades.length;
        
        if (totalItems === 0) return null;
        
        // Create day card
        const dayCard = document.createElement('div');
        dayCard.className = 'history-day-card';
        
        // Day header
        const dayHeader = document.createElement('div');
        dayHeader.className = 'history-day-card-header';
        
        const dayInfo = document.createElement('div');
        dayInfo.className = 'day-info';
        
        const dayOfWeek = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'][date.getDay()];
        const dayNum = date.getDate();
        const month = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'][date.getMonth()];
        const year = date.getFullYear();
        
        dayInfo.innerHTML = `
            <span class="day-name">${dayOfWeek}</span>
            <span class="day-date">${dayNum} ${month} ${year}</span>
        `;
        
        const dayStats = document.createElement('div');
        dayStats.className = 'day-stats';
        dayStats.innerHTML = `
            <div class="stat-item"><div class="stat-dot stat-completed"></div><span>${stats.completed}</span></div>
            <div class="stat-item"><div class="stat-dot stat-in-progress"></div><span>${stats.inProgress}</span></div>
            <div class="stat-item"><div class="stat-dot stat-not-done"></div><span>${stats.notDone}</span></div>
        `;
        
        dayHeader.appendChild(dayInfo);
        dayHeader.appendChild(dayStats);
        dayCard.appendChild(dayHeader);
        
        // Items container
        const itemsContainer = document.createElement('div');
        itemsContainer.className = 'history-items-list';
        
        // Add items by category with separators
        const categoryConfig = {
            clientes: { label: 'CLIENTES', color: '#95d3ee' },
            categorias: { label: 'EMPRESA', color: '#f59e0b' },
            atividades: { label: 'PESSOAL', color: '#a78bfa' }
        };
        
        ['clientes', 'categorias', 'atividades'].forEach(category => {
            if (categorizedItems[category].length > 0) {
                // Add category separator
                const separator = document.createElement('div');
                separator.className = 'category-separator';
                separator.style.color = categoryConfig[category].color;
                separator.style.backgroundColor = categoryConfig[category].color + '0d'; // 5% opacity
                separator.textContent = categoryConfig[category].label;
                itemsContainer.appendChild(separator);
                
                // Add items
                categorizedItems[category].forEach(itemInfo => {
                    const itemRow = this.createItemRow(itemInfo);
                    itemsContainer.appendChild(itemRow);
                });
            }
        });
        
        dayCard.appendChild(itemsContainer);
        return dayCard;
    },
    
    createItemRow(itemInfo) {
        const wrapper = document.createElement('div');
        wrapper.className = 'history-item-wrapper';
        
        const itemRow = document.createElement('div');
        itemRow.className = 'history-item-row-new';
        
        // Get status color and label
        const statusColors = {
            'concluido': '#22c55e',
            'concluido-ongoing': '#22c55e',
            'em-andamento': '#eab308',
            'nao-feito': '#ef4444',
            'bloqueado': 'rgba(239, 68, 68, 0.6)',
            'aguardando': '#95d3ee',
            'parcialmente': '#f97316',
            'prioridade': '#a855f7',
            'pular': 'rgba(255, 255, 255, 0.3)',
            'none': 'transparent'
        };
        
        const statusLabels = {
            'concluido': 'Concluído',
            'concluido-ongoing': 'Concluído',
            'em-andamento': 'Em Andamento',
            'nao-feito': 'Não Feito',
            'bloqueado': 'Bloqueado',
            'aguardando': 'Aguardando',
            'parcialmente': 'Parcialmente',
            'prioridade': 'Prioridade',
            'pular': 'Pulado',
            'none': '—'
        };
        
        const statusColor = statusColors[itemInfo.status] || 'transparent';
        const statusLabel = statusLabels[itemInfo.status] || '—';
        const hasNote = itemInfo.note && itemInfo.note.trim();
        
        // Status dot (hide for 'none')
        if (itemInfo.status !== 'none') {
            const dot = document.createElement('div');
            dot.className = 'status-dot-new';
            dot.style.backgroundColor = statusColor;
            itemRow.appendChild(dot);
        } else {
            const spacer = document.createElement('div');
            spacer.style.width = '10px';
            itemRow.appendChild(spacer);
        }
        
        // Item name
        const nameEl = document.createElement('div');
        nameEl.className = 'item-name-new';
        nameEl.textContent = itemInfo.name;
        itemRow.appendChild(nameEl);
        
        // Note icon
        if (hasNote) {
            const noteIcon = document.createElement('div');
            noteIcon.className = 'note-icon-new';
            itemRow.appendChild(noteIcon);
        }
        
        // Status label
        const labelEl = document.createElement('div');
        labelEl.className = 'status-label-new';
        labelEl.style.color = itemInfo.status === 'none' ? 'rgba(255, 255, 255, 0.2)' : statusColor;
        labelEl.textContent = statusLabel;
        itemRow.appendChild(labelEl);
        
        // Add item row to wrapper
        wrapper.appendChild(itemRow);
        
        // Note panel (always visible if there's a note)
        if (hasNote) {
            const notePanel = document.createElement('div');
            notePanel.className = 'note-panel-visible';
            const noteWithLinks = this._buildNoteHtmlReadonly(itemInfo.note);
            notePanel.innerHTML = noteWithLinks;
            wrapper.appendChild(notePanel);
        }
        
        return wrapper;
    },
    
    renderEmptyHistoryState(container) {
        container.innerHTML = `
            <div class="history-empty-state">
                <svg class="empty-calendar-icon" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#95d3ee" stroke-width="2">
                    <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                    <line x1="16" y1="2" x2="16" y2="6"></line>
                    <line x1="8" y1="2" x2="8" y2="6"></line>
                    <line x1="3" y1="10" x2="21" y2="10"></line>
                </svg>
                <div class="empty-text">Nenhum registro neste período</div>
            </div>
        `;
    },

});
