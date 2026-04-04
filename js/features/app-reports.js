// app-reports.js — Mixin: Reports / Charts / Drill-down
// Extends HabitTrackerApp.prototype

Object.assign(HabitTrackerApp.prototype, {

    async renderReports(period) {
        this.currentReportPeriod = period;
        const container = document.getElementById('reportsContent');
        if (!container) return;

        // Show loading
        container.innerHTML = '<div class="reports-loading">⏳ Carregando relatório...</div>';

        // Calculate date range for charts and stats
        const endDate = new Date();
        endDate.setHours(23, 59, 59, 999);
        let startDate = new Date();
        switch (period) {
            case 'week':  startDate = this.getWeekMonday(new Date()); break;
            case 'month': startDate.setMonth(startDate.getMonth() - 1); break;
            case 'year':  startDate.setFullYear(startDate.getFullYear() - 1); break;
            case 'all':   startDate = new Date(2020, 0, 1); break;
        }
        startDate.setHours(0, 0, 0, 0);

        // Fetch all data for the period in one shot
        const rangeData = await StorageManager.getDateRangeData(startDate, endDate);
        const today = new Date();
        const todayStr = this.getDateString(today);
        // Always fetch today directly to avoid any timezone/range edge cases
        const todayDayData = await StorageManager.getDateData(todayStr);

        // Build status squares data depending on period
        let squaresData, squaresLabel;
        if (period === 'week') {
            squaresData = this._buildSquaresFromAppData(todayDayData);
            squaresLabel = 'Hoje';
        } else if (period === 'month') {
            const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
            monthStart.setHours(0, 0, 0, 0);
            squaresData = this._buildSquaresFromRangeData(rangeData, monthStart, today);
            squaresLabel = 'Este Mês';
        } else {
            const yearStart = new Date(today.getFullYear(), 0, 1);
            yearStart.setHours(0, 0, 0, 0);
            squaresData = this._buildSquaresFromRangeData(rangeData, yearStart, today);
            squaresLabel = 'Este Ano';
        }

        // Today's completion progress (always vs full APP_DATA)
        const totalItems = APP_DATA.clientes.length + APP_DATA.categorias.length + APP_DATA.atividades.length;
        let todayCompleted = 0;
        for (const cat of ['clientes', 'categorias', 'atividades']) {
            for (const item of APP_DATA[cat]) {
                const raw = todayDayData[cat]?.[item.id];
                const s = (typeof raw === 'string' ? raw : raw?.status) || 'none';
                if (s === 'concluido' || s === 'concluido-ongoing') todayCompleted++;
            }
        }

        // Total shown in squares label = sum of the 5 buckets (excludes pular/prioridade)
        const squaresTotal = Object.values(squaresData).reduce((acc, arr) => acc + arr.length, 0);

        // Build HTML
        let html = `
            <div class="charts-section">
                <div class="charts-grid">
                    <div class="chart-container">
                        <h3>Desempenho por Status</h3>
                        <div class="chart-wrapper"><canvas id="performanceChart"></canvas></div>
                    </div>
                    <div class="chart-container">
                        <h3>Concluídos por Área</h3>
                        <div class="chart-wrapper"><canvas id="groupChart"></canvas></div>
                    </div>
                </div>
            </div>`;

        html += this._renderStatusSquaresHTML(squaresData, squaresLabel, squaresTotal, period, startDate, endDate);
        html += this._renderTodayProgressBarHTML(todayCompleted, totalItems);
        html += this._renderDemandCardsHTML(period, rangeData, startDate, endDate, todayDayData);

        container.innerHTML = html;

        const scrollToRestore = this._reportsScrollTop || 0;
        setTimeout(async () => {
            if (typeof Chart !== 'undefined') {
                await this.renderPerformanceChart(period, startDate, endDate);
                await this.renderGroupChart(period, startDate, endDate);
            }
            this._setupSquareTooltips();
            this._setupDemandSectionToggle(); // restores open sections → changes page height
            this._renderAllSparklines();
            this._renderAllCategoryMiniCharts();
            // Wait for layout to settle after sections are restored, then scroll
            if (scrollToRestore > 0) {
                requestAnimationFrame(() => requestAnimationFrame(() => {
                    window.scrollTo({ top: scrollToRestore, behavior: 'instant' });
                }));
            }
        }, 80);
    },

    /** Builds squares data from today's APP_DATA cross-referenced with storage */
    _buildSquaresFromAppData(todayDayData) {
        const result = { concluido: [], andamento: [], aguardando: [], semNota: [], bloqueado: [], semStatus: [] };
        const catLabels = { clientes: '👥', categorias: '🗂️', atividades: '🎯' };
        for (const cat of ['clientes', 'categorias', 'atividades']) {
            for (const item of APP_DATA[cat]) {
                const raw = todayDayData[cat]?.[item.id];
                const s = (typeof raw === 'string' ? raw : raw?.status) || 'none';
                const note = (!raw || typeof raw === 'string') ? '' : (raw?.note || '');
                const entry = { name: item.name, cat: catLabels[cat] };
                if (s === 'concluido' || s === 'concluido-ongoing' || s === 'parcialmente') result.concluido.push(entry);
                else if (s === 'em-andamento') result.andamento.push(entry);
                else if (s === 'aguardando') result.aguardando.push(entry);
                else if (s === 'bloqueado' || s === 'nao-feito') result.bloqueado.push(entry);
                else if (s === 'none') result.semStatus.push(entry);
                // sem nota = empty note field (independent of status)
                if (!note.trim()) result.semNota.push(entry);
            }
        }
        return result;
    },

    /** Builds squares data by scanning storage records for a date range */
    _buildSquaresFromRangeData(rangeData, startDate, endDate) {
        const result = { concluido: [], andamento: [], aguardando: [], semNota: [], bloqueado: [], semStatus: [] };
        const catLabels = { clientes: '👥', categorias: '🗂️', atividades: '🎯' };
        const settings = StorageManager.getSettings();
        const deletedNames = settings.deletedItemNames || {};
        const getName = (cat, id) => APP_DATA[cat]?.find(i => i.id === id)?.name || deletedNames[id] || id;

        for (const dateStr in rangeData) {
            const date = new Date(dateStr);
            if (date < startDate || date > endDate) continue;
            const dayData = rangeData[dateStr];
            for (const cat of ['clientes', 'categorias', 'atividades']) {
                if (!dayData[cat]) continue;
                for (const [itemId, itemData] of Object.entries(dayData[cat])) {
                    const s = (typeof itemData === 'string' ? itemData : itemData?.status) || 'none';
                    const note = typeof itemData === 'string' ? '' : (itemData?.note || '');
                    const entry = { name: getName(cat, itemId), cat: catLabels[cat] };
                    if (s === 'concluido' || s === 'concluido-ongoing' || s === 'parcialmente') result.concluido.push(entry);
                    else if (s === 'em-andamento') result.andamento.push(entry);
                    else if (s === 'aguardando') result.aguardando.push(entry);
                    else if (s === 'bloqueado' || s === 'nao-feito') result.bloqueado.push(entry);
                    else if (s === 'none') result.semStatus.push(entry);
                    // sem nota = empty note field (independent of status)
                    if (!note.trim()) result.semNota.push(entry);
                }
            }
        }
        return result;
    },

    /** Renders the 5 status squares HTML */
    _renderStatusSquaresHTML(squaresData, label, total, period, startDate, endDate) {
        this._squaresData = squaresData;
        this._squaresPeriod = period;
        this._squaresStartDate = startDate;
        this._squaresEndDate = endDate;
        const squares = [
            { key: 'concluido',  cls: 'sq-concluido',  label: 'Concluídas', histFilter: 'concluido'   },
            { key: 'andamento',  cls: 'sq-andamento',  label: 'Andamento',  histFilter: 'em-andamento'},
            { key: 'aguardando', cls: 'sq-aguardando', label: 'Aguardando', histFilter: 'aguardando'  },
            { key: 'semNota',    cls: 'sq-sem-nota',   label: 'Sem Nota',   histFilter: 'sem-nota'    },
            { key: 'semStatus',  cls: 'sq-sem-status', label: 'Sem Status', histFilter: 'none'        },
            { key: 'bloqueado',  cls: 'sq-bloqueado',  label: 'Bloqueadas', histFilter: 'bloqueado'   },
        ];
        const totalLabel = total ? ` <span style="opacity:0.45;font-weight:500">${total} demandas</span>` : '';
        let html = `<div class="status-squares-section">
            <div class="status-squares-label">${label}${totalLabel}</div>
            <div class="status-squares-grid">`;
        for (const sq of squares) {
            const count = (squaresData[sq.key] || []).length;
            html += `<div class="status-square ${sq.cls}" data-sq-key="${sq.key}" data-hist-filter="${sq.histFilter}" title="Ver no histórico">
                <span class="status-square-label">${sq.label}</span>
                <span class="status-square-count">${count}</span>
            </div>`;
        }
        html += `</div></div>`;
        return html;
    },

    /** Renders today's progress bar */
    _renderTodayProgressBarHTML(completed, total) {
        const pct = total > 0 ? Math.round(completed / total * 100) : 0;
        return `<div class="today-progress-section">
            <div class="today-progress-header">
                <span class="today-progress-title">Progresso de Hoje</span>
                <span class="today-progress-pct">${pct}%</span>
            </div>
            <div class="today-progress-bar">
                <div class="today-progress-fill" style="width:${pct}%"></div>
            </div>
            <div class="today-progress-sub">${completed} de ${total} concluídas</div>
        </div>`;
    },

    /** Renders individual demand cards for all categories */
    _renderDemandCardsHTML(period, rangeData, startDate, endDate, todayDayData) {
        // Lê rótulos personalizados das categorias nas configurações
        const _settings = StorageManager.getSettings();
        const _catLbls = _settings.categoryLabels || {};
        const catInfo = [
            { key: 'clientes',   icon: '👥', label: _catLbls.clientes   || 'Clientes'   },
            { key: 'categorias', icon: '🗂️', label: _catLbls.categorias || 'Categorias' },
            { key: 'atividades', icon: '🎯', label: _catLbls.atividades  || 'Atividades'  },
        ];
        let html = '<div class="demand-cards-section"><div class="report-section-title">Relatório por Demanda</div>';

        for (const ci of catInfo) {
            const items = APP_DATA[ci.key] || [];
            if (!items.length) continue;

            const catCompleted = items.filter(item => {
                const raw = todayDayData[ci.key]?.[item.id];
                const s = (typeof raw === 'string' ? raw : raw?.status) || 'none';
                return s === 'concluido' || s === 'concluido-ongoing';
            }).length;

            // Pre-compute mini-chart data for this category (per day/week/month)
            const miniData = this._buildCategoryMiniChartData(ci.key, items, rangeData, startDate, endDate, period);
            const miniJson = encodeURIComponent(JSON.stringify(miniData));

            html += `<div class="demand-section-header" data-sec="${ci.key}">
                <span class="section-icon">${ci.icon}</span>
                <span class="section-title">${ci.label}</span>
                <span class="section-stats">${catCompleted}/${items.length} hoje</span>
                <span class="section-chevron">▼</span>
            </div>
            <div class="demand-section-body" data-sec-body="${ci.key}">
                <div class="demand-mini-chart-wrap" style="grid-column: 1 / -1;">
                    <canvas class="demand-mini-chart" data-minidata="${miniJson}" data-total="${items.length}"></canvas>
                </div>`;

            for (const item of items) {
                const rawToday = todayDayData[ci.key]?.[item.id];
                const todayStatus = (typeof rawToday === 'string' ? rawToday : rawToday?.status) || 'none';
                const stats = this._getItemStatsFromRangeData(item.id, ci.key, rangeData, startDate, endDate, period);
                const badge = this._getStatusBadgeLabel(todayStatus);
                const histJson = JSON.stringify(stats.history).replace(/'/g, '&#39;');
                const safeName = item.name.replace(/'/g, '&#39;');

                html += `<div class="demand-card" data-item-id="${item.id}" data-item-cat="${ci.key}" data-item-name='${safeName}'>
                    <div class="demand-card-header">
                        <span class="demand-card-name">${item.name}</span>
                        <span class="demand-status-badge badge-${todayStatus}">${badge}</span>
                    </div>
                    <div class="demand-sparkline-wrap">
                        <canvas class="demand-sparkline" data-history='${histJson}'></canvas>
                    </div>
                    <div class="demand-card-rate">
                        <span class="demand-card-rate-pct">${stats.rate}%</span>
                        <div class="demand-rate-bar">
                            <div class="demand-rate-fill" style="width:${stats.rate}%"></div>
                        </div>
                    </div>
                    <div class="demand-card-stats">
                        ${stats.concluido ? `<span class="demand-stat-chip">✅ ${stats.concluido}</span>` : ''}
                        ${stats.andamento ? `<span class="demand-stat-chip">🟡 ${stats.andamento}</span>` : ''}
                        ${stats.bloqueado ? `<span class="demand-stat-chip">🚫 ${stats.bloqueado}</span>` : ''}
                        ${stats.aguardando ? `<span class="demand-stat-chip">🔵 ${stats.aguardando}</span>` : ''}
                        ${stats.naoFeito  ? `<span class="demand-stat-chip">❌ ${stats.naoFeito}</span>` : ''}
                        ${stats.total === 0 ? '<span class="demand-stat-chip" style="opacity:0.38">Sem registros</span>' : ''}
                    </div>
                </div>`;
            }
            html += `</div>`;
        }
        html += '</div>';
        return html;
    },

    /** Computes stats for a single item from pre-loaded rangeData */
    _getItemStatsFromRangeData(itemId, category, rangeData, startDate, endDate, period) {
        const stats = { concluido: 0, andamento: 0, aguardando: 0, bloqueado: 0, naoFeito: 0, total: 0, history: [] };
        const scoreMap = { 'concluido': 1, 'concluido-ongoing': 1, 'parcialmente': 0.7, 'em-andamento': 0.5, 'aguardando': 0.3, 'bloqueado': 0, 'nao-feito': 0, 'prioridade': 0 };

        if (period === 'week') {
            const monday = this.getWeekMonday(new Date());
            const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);
            let diasPassados = 0;

            for (let i = 0; i < 7; i++) {
                const d = new Date(monday);
                d.setDate(monday.getDate() + i);
                if (d > todayEnd) {
                    stats.history.push(null);
                    continue;
                }
                diasPassados++;
                const ds = this.getDateString(d);
                const itemData = rangeData[ds]?.[category]?.[itemId];
                const s = itemData
                    ? (typeof itemData === 'string' ? itemData : (itemData.status || 'none'))
                    : 'none';

                const sc = scoreMap[s];
                stats.history.push(sc !== undefined ? sc : null);

                if (s === 'pular') continue;
                if (s === 'none') continue;
                stats.total++;
                if (s === 'concluido' || s === 'concluido-ongoing') stats.concluido++;
                else if (s === 'em-andamento' || s === 'parcialmente') stats.andamento++;
                else if (s === 'aguardando') stats.aguardando++;
                else if (s === 'bloqueado') stats.bloqueado++;
                else if (s === 'nao-feito') stats.naoFeito++;
            }
            stats._weekDaysElapsed = diasPassados;
        } else {
            const dayMs = 86400000;
            const totalDays = Math.round((endDate - startDate) / dayMs) + 1;
            const useWeekly = totalDays > 60;

            if (useWeekly) {
                let ws = new Date(startDate);
                while (ws <= endDate) {
                    const we = new Date(ws);
                    we.setDate(we.getDate() + 6);
                    let sum = 0, cnt = 0;
                    for (let d = new Date(ws); d <= we && d <= endDate; d.setDate(d.getDate() + 1)) {
                        const ds = this.getDateString(d);
                        const itemData = rangeData[ds]?.[category]?.[itemId];
                        if (itemData) {
                            const s = typeof itemData === 'string' ? itemData : (itemData.status || 'none');
                            const sc = scoreMap[s];
                            if (sc !== undefined) { sum += sc; cnt++; }
                        }
                    }
                    stats.history.push(cnt > 0 ? sum / cnt : null);
                    ws.setDate(ws.getDate() + 7);
                }
            } else {
                for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
                    const ds = this.getDateString(d);
                    const itemData = rangeData[ds]?.[category]?.[itemId];
                    if (itemData) {
                        const s = typeof itemData === 'string' ? itemData : (itemData.status || 'none');
                        const sc = scoreMap[s];
                        stats.history.push(sc !== undefined ? sc : null);
                    } else {
                        stats.history.push(null);
                    }
                }
            }

            const toDateStr = (d) => {
                const y = d.getFullYear();
                const mo = String(d.getMonth() + 1).padStart(2, '0');
                const da = String(d.getDate()).padStart(2, '0');
                return `${y}-${mo}-${da}`;
            };
            const startStr = toDateStr(startDate);
            const endStr   = toDateStr(endDate);
            for (const dateStr in rangeData) {
                if (dateStr < startStr || dateStr > endStr) continue;
                const itemData = rangeData[dateStr]?.[category]?.[itemId];
                if (!itemData) continue;
                const s = typeof itemData === 'string' ? itemData : (itemData.status || 'none');
                if (s === 'none' || s === 'pular') continue;
                stats.total++;
                if (s === 'concluido' || s === 'concluido-ongoing') stats.concluido++;
                else if (s === 'em-andamento' || s === 'parcialmente') stats.andamento++;
                else if (s === 'aguardando') stats.aguardando++;
                else if (s === 'bloqueado') stats.bloqueado++;
                else if (s === 'nao-feito') stats.naoFeito++;
            }
        }

        const rateDenominator = stats._weekDaysElapsed ?? stats.total;
        stats.rate = rateDenominator > 0 ? Math.round(stats.concluido / rateDenominator * 100) : 0;
        return stats;
    },

    /** Returns badge label for a status */
    _getStatusBadgeLabel(status) {
        const m = { 'concluido': '✅ Concluído', 'concluido-ongoing': '✅ Contínuo', 'em-andamento': '🟡 Andamento', 'aguardando': '🔵 Aguardando', 'bloqueado': '🚫 Bloqueado', 'nao-feito': '❌ Não Feito', 'parcialmente': '🟠 Parcial', 'pular': '⏭️ Pulado', 'prioridade': '⚫ Prio', 'none': '— Sem status' };
        return m[status] || '— Sem status';
    },

    /** Sets up hover/click tooltips on status squares */
    _setupSquareTooltips() {
        if (this._sqDocListener) {
            document.removeEventListener('click', this._sqDocListener);
            this._sqDocListener = null;
        }
        let tooltip = document.getElementById('sqTooltip');
        if (!tooltip) {
            tooltip = document.createElement('div');
            tooltip.id = 'sqTooltip';
            tooltip.className = 'status-tooltip';
            document.body.appendChild(tooltip);
        }
        const labels = { concluido: '✅ Concluídas', andamento: '🟡 Em Andamento', aguardando: '🔵 Aguardando', semNota: '⚪ Sem Nota', semStatus: '○ Sem Status', bloqueado: '🚫 Bloqueadas' };
        let activeSq = null;

        const hide = () => { tooltip.classList.remove('visible'); activeSq = null; };

        const show = (sq) => {
            const key = sq.dataset.sqKey;
            const items = this._squaresData?.[key] || [];
            let inner = `<div class="status-tooltip-title">${labels[key] || key}</div>`;
            if (!items.length) {
                inner += `<div style="opacity:0.5;padding:8px 0;text-align:center;font-size:11px">Nenhuma demanda</div>`;
            } else {
                items.slice(0, 25).forEach(it => {
                    inner += `<div class="status-tooltip-item"><span>${it.name}</span><span class="status-tooltip-cat">${it.cat}</span></div>`;
                });
                if (items.length > 25) inner += `<div style="text-align:center;opacity:0.38;font-size:10px;margin-top:5px">+${items.length - 25} mais</div>`;
            }
            tooltip.innerHTML = inner;
            tooltip.classList.add('visible');

            const rect = sq.getBoundingClientRect();
            const tw = 230;
            const estimatedH = Math.min(280, items.length * 28 + 48);
            let left = rect.left + rect.width / 2 - tw / 2;
            let top = rect.top - estimatedH - 8;
            if (left < 8) left = 8;
            if (left + tw > window.innerWidth - 8) left = window.innerWidth - tw - 8;
            if (top < 8) top = rect.bottom + 8;
            tooltip.style.cssText = `left:${Math.round(left)}px;top:${Math.round(top)}px;width:${tw}px;`;
        };

        const isHoverDevice = window.matchMedia('(hover: hover)').matches;

        document.querySelectorAll('.status-square').forEach(sq => {
            if (isHoverDevice) {
                sq.addEventListener('mouseenter', () => { show(sq); activeSq = sq; });
                sq.addEventListener('mouseleave', hide);
            }
            sq.addEventListener('click', e => {
                e.stopPropagation();
                hide();
                const histFilter = sq.dataset.histFilter || 'all';
                const period = this._squaresPeriod || 'week';
                const today = new Date();
                today.setHours(12, 0, 0, 0);

                if (period === 'month') {
                    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
                    monthStart.setHours(0, 0, 0, 0);
                    const monthEnd = new Date(today);
                    monthEnd.setHours(23, 59, 59, 999);
                    const fmt = d => `${String(d.getDate()).padStart(2,'0')}/${d.getMonth()+1}`;
                    const label = `${fmt(monthStart)}–${fmt(monthEnd)}`;
                    this._navigateToHistoryWithFilter(histFilter, '', today, { start: monthStart, end: monthEnd, label });
                } else if (period === 'year' || period === 'all') {
                    const yearStart = new Date(today.getFullYear(), 0, 1);
                    yearStart.setHours(0, 0, 0, 0);
                    const yearEnd = new Date(today);
                    yearEnd.setHours(23, 59, 59, 999);
                    const label = `Jan–${today.toLocaleString('pt-BR',{month:'short'})} ${today.getFullYear()}`;
                    this._navigateToHistoryWithFilter(histFilter, '', today, { start: yearStart, end: yearEnd, label });
                } else {
                    this._navigateToHistoryWithFilter(histFilter, '', today);
                }
            });
        });

        this._sqDocListener = e => { if (!e.target.closest('.status-square')) hide(); };
        document.addEventListener('click', this._sqDocListener);
    },

    /** Sets up collapsible demand category sections and card click-to-history */
    _setupDemandSectionToggle() {
        if (!this._reportsSectionStates) this._reportsSectionStates = {};
        document.querySelectorAll('.demand-section-header').forEach(header => {
            const key = header.dataset.sec;
            const body = document.querySelector(`.demand-section-body[data-sec-body="${key}"]`);
            if (this._reportsSectionStates[key]) {
                header.classList.add('open');
                if (body) body.classList.add('open');
            }
            header.addEventListener('click', () => {
                const isOpen = header.classList.contains('open');
                header.classList.toggle('open', !isOpen);
                this._reportsSectionStates[key] = !isOpen;
                if (body) {
                    body.classList.toggle('open', !isOpen);
                    if (!isOpen) setTimeout(() => { this._renderAllSparklines(); this._renderAllCategoryMiniCharts(); }, 30);
                }
            });
        });

        // Demand card click → navigate to history filtered by item name
        document.querySelectorAll('.demand-card').forEach(card => {
            card.addEventListener('click', e => {
                e.stopPropagation();
                const itemName = card.dataset.itemName || '';
                const period = this._squaresPeriod || 'week';
                const today = new Date();
                if (period === 'week') {
                    const weekStart = this.getWeekMonday(new Date());
                    weekStart.setHours(0, 0, 0, 0);
                    const weekEnd = new Date(weekStart);
                    weekEnd.setDate(weekStart.getDate() + 6);
                    weekEnd.setHours(23, 59, 59, 999);
                    const fmt = d => `${d.getDate()}/${d.getMonth() + 1}`;
                    const rangeLabel = `${itemName} · ${fmt(weekStart)}–${fmt(weekEnd)}`;
                    this._navigateToHistoryWithFilter('all', itemName, today, { start: weekStart, end: weekEnd, label: rangeLabel });
                } else if (period === 'month') {
                    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
                    monthStart.setHours(0, 0, 0, 0);
                    const monthEnd = new Date(today);
                    monthEnd.setHours(23, 59, 59, 999);
                    const fmt = d => `${d.getDate()}/${d.getMonth()+1}`;
                    const rangeLabel = `${itemName} · ${fmt(monthStart)}–${fmt(monthEnd)}`;
                    this._navigateToHistoryWithFilter('all', itemName, today, { start: monthStart, end: monthEnd, label: rangeLabel });
                } else {
                    const yearStart = new Date(today.getFullYear(), 0, 1);
                    yearStart.setHours(0, 0, 0, 0);
                    const yearEnd = new Date(today);
                    yearEnd.setHours(23, 59, 59, 999);
                    const rangeLabel = `${itemName} · Jan–${today.toLocaleString('pt-BR',{month:'short'})} ${today.getFullYear()}`;
                    this._navigateToHistoryWithFilter('all', itemName, today, { start: yearStart, end: yearEnd, label: rangeLabel });
                }
            });
        });
    },

    /** Navigates to history tab with a status filter and optional search query */
    async _navigateToHistoryWithFilter(statusFilter, searchQuery, date, dateRange) {
        this.historyDate = new Date(date || new Date());
        this.historyDate.setHours(12, 0, 0, 0);
        this._historyDateRange = dateRange || null;

        this._activeHistoryFilter = statusFilter || 'all';
        this._historySearchQuery = searchQuery ? searchQuery.toLowerCase() : '';

        await this.showView('history');

        document.querySelectorAll('#historyStatusFilter .tsf-btn').forEach(b => {
            b.classList.toggle('tsf-active', b.dataset.status === this._activeHistoryFilter);
        });

        const input    = document.getElementById('historySearchInput');
        const wrap     = document.getElementById('historySearchWrap');
        const clearBtn = document.getElementById('historySearchClear');
        if (searchQuery) {
            if (input)    input.value = searchQuery;
            if (wrap)     wrap.classList.add('tsf-search-open');
            if (clearBtn) clearBtn.style.display = 'flex';
        } else {
            if (input)    input.value = '';
            if (wrap)     wrap.classList.remove('tsf-search-open');
            if (clearBtn) clearBtn.style.display = 'none';
        }
    },

    /** Builds chart data (labels + status counts) for a category over the given period/range */
    _buildCategoryMiniChartData(catKey, items, rangeData, startDate, endDate, period) {
        const dayNames = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
        const monthNames = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
        const labels = [];
        const concluido = [], emAndamento = [], aguardando = [], naoFeito = [];

        const countDay = (dateStr) => {
            const c = { concluido: 0, emAndamento: 0, aguardando: 0, naoFeito: 0 };
            for (const item of items) {
                const raw = rangeData[dateStr]?.[catKey]?.[item.id];
                if (!raw) continue;
                const s = typeof raw === 'string' ? raw : (raw.status || 'none');
                if (s === 'concluido' || s === 'concluido-ongoing' || s === 'parcialmente') c.concluido++;
                else if (s === 'em-andamento') c.emAndamento++;
                else if (s === 'aguardando') c.aguardando++;
                else if (s === 'nao-feito' || s === 'bloqueado') c.naoFeito++;
            }
            return c;
        };

        const pushCounts = (c) => {
            concluido.push(c.concluido);
            emAndamento.push(c.emAndamento);
            aguardando.push(c.aguardando);
            naoFeito.push(c.naoFeito);
        };

        if (period === 'week') {
            const monday = this.getWeekMonday(new Date());
            const today = new Date(); today.setHours(23, 59, 59, 999);
            for (let i = 0; i < 7; i++) {
                const d = new Date(monday);
                d.setDate(monday.getDate() + i);
                labels.push(dayNames[d.getDay()]);
                if (d > today) { concluido.push(0); emAndamento.push(0); aguardando.push(0); naoFeito.push(0); }
                else pushCounts(countDay(this.getDateString(d)));
            }
        } else if (period === 'month') {
            const today = new Date(); today.setHours(23, 59, 59, 999);
            for (let d = new Date(startDate); d <= today; d.setDate(d.getDate() + 1)) {
                labels.push(d.getDate() + '/' + (d.getMonth() + 1));
                pushCounts(countDay(this.getDateString(new Date(d))));
            }
        } else {
            const monthsMap = new Map();
            for (const dateStr in rangeData) {
                const d = new Date(dateStr);
                if (d < startDate || d > endDate) continue;
                const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
                if (!monthsMap.has(key)) monthsMap.set(key, { year: d.getFullYear(), month: d.getMonth() });
            }
            const sorted = Array.from(monthsMap.values()).sort((a, b) => a.year !== b.year ? a.year - b.year : a.month - b.month);
            for (const { year, month } of sorted) {
                labels.push(monthNames[month]);
                const c = { concluido: 0, emAndamento: 0, aguardando: 0, naoFeito: 0 };
                for (const dateStr in rangeData) {
                    const d = new Date(dateStr);
                    if (d.getFullYear() !== year || d.getMonth() !== month) continue;
                    const dc = countDay(dateStr);
                    c.concluido += dc.concluido; c.emAndamento += dc.emAndamento;
                    c.aguardando += dc.aguardando; c.naoFeito += dc.naoFeito;
                }
                pushCounts(c);
            }
        }
        return { labels, concluido, emAndamento, aguardando, naoFeito };
    },

    /** Renders a mini bar chart on a .demand-mini-chart canvas */
    _renderCategoryMiniChart(canvas) {
        if (typeof Chart === 'undefined') return;
        try {
            const raw = canvas.dataset.minidata;
            if (!raw) return;
            const { labels, concluido, emAndamento, aguardando, naoFeito } = JSON.parse(decodeURIComponent(raw));
            const totalItems = parseInt(canvas.dataset.total || '0', 10);
            if (!labels || !labels.length) return;

            const existing = Chart.getChart(canvas);
            if (existing) existing.destroy();

            const miniBarValuePlugin = {
                id: 'miniBarValueLabels',
                afterDatasetsDraw(chart) {
                    const { ctx: c } = chart;
                    chart.data.datasets.forEach((dataset, i) => {
                        const meta = chart.getDatasetMeta(i);
                        meta.data.forEach((bar, index) => {
                            const value = dataset.data[index];
                            if (value > 0) {
                                c.save();
                                c.fillStyle = 'rgba(255, 255, 255, 0.8)';
                                c.font = 'bold 9px Quicksand';
                                c.textAlign = 'center';
                                c.textBaseline = 'bottom';
                                c.fillText(value, bar.x, bar.y - 2);
                                c.restore();
                            }
                        });
                    });
                }
            };

            new Chart(canvas, {
                type: 'bar',
                plugins: [miniBarValuePlugin],
                data: {
                    labels,
                    datasets: [
                        { label: 'Concluído',    data: concluido,    backgroundColor: '#22c55e', borderRadius: 4 },
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    layout: { padding: { top: 14 } },
                    animation: { duration: 400, easing: 'easeInOutQuart' },
                    plugins: {
                        legend: {
                            display: false,
                            position: 'bottom',
                            labels: {
                                font: { family: 'Quicksand', size: 10 },
                                color: 'rgba(255,255,255,0.55)',
                                padding: 8,
                                boxWidth: 8,
                                boxHeight: 8,
                            }
                        },
                        tooltip: {
                            backgroundColor: 'rgba(4,34,53,0.95)',
                            titleColor: '#95d3ee',
                            bodyColor: '#fff',
                            borderColor: 'rgba(149,211,238,0.3)',
                            borderWidth: 1,
                            padding: 8,
                            callbacks: {
                                label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y}`
                            }
                        }
                    },
                    scales: {
                        x: {
                            stacked: false,
                            grid: { color: 'rgba(149,211,238,0.05)', drawBorder: false },
                            ticks: { color: 'rgba(255,255,255,0.45)', font: { family: 'Quicksand', size: 10 }, maxRotation: 0 }
                        },
                        y: {
                            stacked: false,
                            beginAtZero: true,
                            max: totalItems || undefined,
                            grid: { color: 'rgba(149,211,238,0.05)', drawBorder: false },
                            ticks: {
                                color: 'rgba(255,255,255,0.45)',
                                font: { family: 'Quicksand', size: 10 },
                                stepSize: Math.max(1, Math.ceil((totalItems || 4) / 4)),
                                callback: v => Number.isInteger(v) ? v : ''
                            }
                        }
                    },
                    barPercentage: 0.7,
                    categoryPercentage: 0.65
                }
            });
        } catch (e) { console.warn('mini-chart error', e); }
    },

    /** Renders all visible category mini-charts */
    _renderAllCategoryMiniCharts() {
        document.querySelectorAll('.demand-section-body.open .demand-mini-chart').forEach(canvas => {
            this._renderCategoryMiniChart(canvas);
        });
    },

    _renderAllSparklines() {
        document.querySelectorAll('.demand-sparkline').forEach(canvas => {
            try {
                const history = JSON.parse(canvas.dataset.history || '[]');
                this._drawSparkline(canvas, history);
            } catch (e) {}
        });
    },

    /** Draws a mini sparkline chart on a canvas */
    _drawSparkline(canvas, history) {
        const W = canvas.parentElement?.offsetWidth || 160;
        const H = 32;
        canvas.width = W;
        canvas.height = H;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.clearRect(0, 0, W, H);

        const validCount = history.filter(v => v !== null).length;
        if (validCount < 2) {
            ctx.beginPath();
            ctx.strokeStyle = 'rgba(149,211,238,0.15)';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([3, 4]);
            ctx.moveTo(0, H / 2);
            ctx.lineTo(W, H / 2);
            ctx.stroke();
            return;
        }

        const n = history.length;
        const pad = 3;
        const toX = i => pad + (i / (n - 1)) * (W - pad * 2);
        const toY = v => H - pad - v * (H - pad * 2);
        const pts = history.map((v, i) => v !== null ? [toX(i), toY(v)] : null);

        // Fill area under line
        ctx.beginPath();
        let filling = false;
        for (let i = 0; i < pts.length; i++) {
            if (!pts[i]) continue;
            if (!filling) { ctx.moveTo(pts[i][0], H); ctx.lineTo(pts[i][0], pts[i][1]); filling = true; }
            else ctx.lineTo(pts[i][0], pts[i][1]);
        }
        for (let i = pts.length - 1; i >= 0; i--) { if (pts[i]) { ctx.lineTo(pts[i][0], H); break; } }
        ctx.closePath();
        ctx.fillStyle = 'rgba(149,211,238,0.06)';
        ctx.fill();

        // Line
        ctx.beginPath();
        ctx.setLineDash([]);
        let first = true;
        for (let i = 0; i < pts.length; i++) {
            if (!pts[i]) continue;
            if (first) { ctx.moveTo(pts[i][0], pts[i][1]); first = false; }
            else ctx.lineTo(pts[i][0], pts[i][1]);
        }
        ctx.strokeStyle = 'rgba(149,211,238,0.42)';
        ctx.lineWidth = 1.5;
        ctx.lineJoin = 'round';
        ctx.stroke();

        // Dot on last valid point
        for (let i = pts.length - 1; i >= 0; i--) {
            if (!pts[i]) continue;
            const v = history[i];
            const color = v >= 0.9 ? '#4ade80' : v >= 0.5 ? '#facc15' : v >= 0.3 ? '#60a5fa' : '#f87171';
            ctx.beginPath();
            ctx.arc(pts[i][0], pts[i][1], 3, 0, Math.PI * 2);
            ctx.fillStyle = color;
            ctx.fill();
            break;
        }
    },

    async renderPerformanceChart(period, startDate, endDate) {
        if (typeof Chart === 'undefined') {
            console.warn('Chart.js not loaded yet');
            return;
        }

        const canvas = document.getElementById('performanceChart');
        if (!canvas) return;

        if (this.performanceChart) {
            this.performanceChart.destroy();
        }

        const { labels, datasets } = await this.getChartData(period, startDate, endDate);

        const totalDemandas = APP_DATA.clientes.length + APP_DATA.categorias.length + APP_DATA.atividades.length;

        let yMax;
        if (period === 'week') {
            yMax = totalDemandas;
        } else {
            const dataMax = Math.max(...datasets.concluido, 1);
            yMax = Math.ceil(dataMax * 1.10);
        }

        const yStepSize = Math.ceil(yMax / 8);

        const ctx = canvas.getContext('2d');
        const barValuePlugin = {
            id: 'barValueLabels',
            afterDatasetsDraw(chart) {
                const { ctx: c } = chart;
                chart.data.datasets.forEach((dataset, i) => {
                    const meta = chart.getDatasetMeta(i);
                    meta.data.forEach((bar, index) => {
                        const value = dataset.data[index];
                        if (value > 0) {
                            c.save();
                            c.fillStyle = 'rgba(255, 255, 255, 0.85)';
                            c.font = 'bold 11px Quicksand';
                            c.textAlign = 'center';
                            c.textBaseline = 'bottom';
                            c.fillText(value, bar.x, bar.y - 4);
                            c.restore();
                        }
                    });
                });
            }
        };
        this.performanceChart = new Chart(ctx, {
            type: 'bar',
            plugins: [barValuePlugin],
            data: {
                labels: labels,
                datasets: [
                    {
                        label: 'Concluído',
                        data: datasets.concluido,
                        backgroundColor: '#22c55e',
                        borderRadius: 6,
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                layout: { padding: { top: 18 } },
                animation: {
                    duration: 600,
                    easing: 'easeInOutQuart'
                },
                plugins: {
                    legend: {
                        display: false,
                        position: 'bottom',
                        labels: {
                            font: { family: 'Quicksand', size: 11 },
                            color: 'rgba(255, 255, 255, 0.75)',
                            padding: 12
                        }
                    },
                    tooltip: {
                        backgroundColor: 'rgba(4, 34, 53, 0.95)',
                        titleColor: '#95d3ee',
                        bodyColor: '#ffffff',
                        borderColor: 'rgba(149, 211, 238, 0.3)',
                        borderWidth: 1,
                        padding: 12,
                        displayColors: true,
                        callbacks: {
                            label: function(context) {
                                return context.dataset.label + ': ' + context.parsed.y;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        stacked: false,
                        grid: {
                            color: 'rgba(149, 211, 238, 0.07)',
                            drawBorder: false
                        },
                        ticks: {
                            color: 'rgba(255, 255, 255, 0.6)',
                            font: { family: 'Quicksand', size: 11 }
                        }
                    },
                    y: {
                        stacked: false,
                        beginAtZero: true,
                        max: yMax,
                        grid: {
                            color: 'rgba(149, 211, 238, 0.07)',
                            drawBorder: false
                        },
                        ticks: {
                            color: 'rgba(255, 255, 255, 0.6)',
                            font: { family: 'Quicksand', size: 11 },
                            stepSize: yStepSize,
                            callback: function(value) {
                                return Number.isInteger(value) ? value : '';
                            }
                        }
                    }
                },
                barPercentage: 0.75,
                categoryPercentage: 0.7
            }
        });
    },

    async renderGroupChart(period, startDate, endDate) {
        if (typeof Chart === 'undefined') {
            console.warn('Chart.js not loaded yet');
            return;
        }

        const canvas = document.getElementById('groupChart');
        if (!canvas) return;

        if (this.groupChart) {
            this.groupChart.destroy();
        }

        const { labels, groupData } = await this.getGroupChartData(period, startDate, endDate);

        const _s = StorageManager.getSettings();
        const _cl = _s.categoryLabels || {};
        const labelClientes   = _cl.clientes   || 'Clientes';
        const labelCategorias = _cl.categorias || 'Categorias';
        const labelAtividades = _cl.atividades || 'Atividades';

        const ctx = canvas.getContext('2d');
        this.groupChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [
                    {
                        label: labelClientes,
                        data: groupData.clientes,
                        borderColor: '#95d3ee',
                        backgroundColor: 'rgba(149, 211, 238, 0.1)',
                        tension: 0.4,
                        fill: false,
                        pointRadius: 5,
                        pointHoverRadius: 8,
                        pointBackgroundColor: '#95d3ee'
                    },
                    {
                        label: labelCategorias,
                        data: groupData.categorias,
                        borderColor: '#f59e0b',
                        backgroundColor: 'rgba(245, 158, 11, 0.1)',
                        tension: 0.4,
                        fill: false,
                        pointRadius: 5,
                        pointHoverRadius: 8,
                        pointBackgroundColor: '#f59e0b'
                    },
                    {
                        label: labelAtividades,
                        data: groupData.atividades,
                        borderColor: '#a78bfa',
                        backgroundColor: 'rgba(167, 139, 250, 0.1)',
                        tension: 0.4,
                        fill: false,
                        pointRadius: 5,
                        pointHoverRadius: 8,
                        pointBackgroundColor: '#a78bfa'
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: {
                    duration: 600,
                    easing: 'easeInOutQuart'
                },
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: {
                            font: { family: 'Quicksand', size: 11 },
                            color: 'rgba(255, 255, 255, 0.75)',
                            padding: 12
                        }
                    },
                    tooltip: {
                        backgroundColor: 'rgba(4, 34, 53, 0.95)',
                        titleColor: '#95d3ee',
                        bodyColor: '#ffffff',
                        borderColor: 'rgba(149, 211, 238, 0.3)',
                        borderWidth: 1,
                        padding: 12,
                        displayColors: true,
                        callbacks: {
                            label: function(context) {
                                return context.dataset.label + ': ' + context.parsed.y.toFixed(1) + '%';
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        grid: {
                            color: 'rgba(149, 211, 238, 0.07)',
                            drawBorder: false
                        },
                        ticks: {
                            color: 'rgba(255, 255, 255, 0.6)',
                            font: { family: 'Quicksand', size: 11 }
                        }
                    },
                    y: {
                        beginAtZero: true,
                        max: 100,
                        grid: {
                            color: 'rgba(149, 211, 238, 0.07)',
                            drawBorder: false
                        },
                        ticks: {
                            color: 'rgba(255, 255, 255, 0.6)',
                            font: { family: 'Quicksand', size: 11 },
                            callback: function(value) {
                                return value + '%';
                            }
                        }
                    }
                }
            }
        });
    },

    async getChartData(period, startDate, endDate) {
        const labels = [];
        const datasets = {
            concluido: [],
            emAndamento: [],
            aguardando: [],
            naoFeito: [],
            pulado: []
        };

        if (period === 'week') {
            const dayNames = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
            const monday = this.getWeekMonday(new Date());
            const today = new Date();
            today.setHours(23, 59, 59, 999);
            for (let i = 0; i < 7; i++) {
                const date = new Date(monday);
                date.setDate(monday.getDate() + i);
                labels.push(dayNames[date.getDay()]);
                if (date > today) {
                    datasets.concluido.push(0);
                    datasets.emAndamento.push(0);
                    datasets.aguardando.push(0);
                    datasets.naoFeito.push(0);
                    datasets.pulado.push(0);
                } else {
                    const dayData = await this.calculateDayStatusPercentages(date);
                    datasets.concluido.push(dayData.concluido);
                    datasets.emAndamento.push(dayData.emAndamento);
                    datasets.aguardando.push(dayData.aguardando);
                    datasets.naoFeito.push(dayData.naoFeito);
                    datasets.pulado.push(dayData.pulado);
                }
            }
        } else if (period === 'month') {
            for (let week = 1; week <= 4; week++) {
                labels.push('S' + week);
                
                const weekStart = new Date();
                weekStart.setDate(weekStart.getDate() - (5 - week) * 7);
                const weekEnd = new Date(weekStart);
                weekEnd.setDate(weekEnd.getDate() + 6);
                
                const weekData = await this.calculatePeriodStatusPercentages(weekStart, weekEnd);
                datasets.concluido.push(weekData.concluido);
                datasets.emAndamento.push(weekData.emAndamento);
                datasets.aguardando.push(weekData.aguardando);
                datasets.naoFeito.push(weekData.naoFeito);
                datasets.pulado.push(weekData.pulado);
            }
        } else if (period === 'year') {
            const monthNames = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
            for (let i = 11; i >= 0; i--) {
                const date = new Date();
                date.setMonth(date.getMonth() - i);
                labels.push(monthNames[date.getMonth()]);
                
                const monthStart = new Date(date.getFullYear(), date.getMonth(), 1);
                const monthEnd = new Date(date.getFullYear(), date.getMonth() + 1, 0);
                
                const monthData = await this.calculatePeriodStatusPercentages(monthStart, monthEnd);
                datasets.concluido.push(monthData.concluido);
                datasets.emAndamento.push(monthData.emAndamento);
                datasets.aguardando.push(monthData.aguardando);
                datasets.naoFeito.push(monthData.naoFeito);
                datasets.pulado.push(monthData.pulado);
            }
        } else { // all
            const allData = await StorageManager.getData();
            const monthsWithData = new Map();
            
            for (const dateStr in allData) {
                const date = new Date(dateStr);
                const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
                if (!monthsWithData.has(monthKey)) {
                    monthsWithData.set(monthKey, { year: date.getFullYear(), month: date.getMonth() });
                }
            }
            
            const sortedMonths = Array.from(monthsWithData.values()).sort((a, b) => {
                if (a.year !== b.year) return a.year - b.year;
                return a.month - b.month;
            });
            
            const monthNames = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
            for (const { year, month } of sortedMonths) {
                labels.push(`${monthNames[month]}/${String(year).slice(-2)}`);
                
                const monthStart = new Date(year, month, 1);
                const monthEnd = new Date(year, month + 1, 0);
                
                const monthData = await this.calculatePeriodStatusPercentages(monthStart, monthEnd);
                datasets.concluido.push(monthData.concluido);
                datasets.emAndamento.push(monthData.emAndamento);
                datasets.aguardando.push(monthData.aguardando);
                datasets.naoFeito.push(monthData.naoFeito);
                datasets.pulado.push(monthData.pulado);
            }
        }

        return { labels, datasets };
    },

    async calculateDayStatusPercentages(date) {
        const dateStr = this.getDateString(date);
        const dayData = await StorageManager.getDateData(dateStr);
        
        const counts = {
            concluido: 0,
            emAndamento: 0,
            aguardando: 0,
            naoFeito: 0,
            pulado: 0,
            total: 0
        };

        ['clientes', 'categorias', 'atividades'].forEach(category => {
            if (dayData[category]) {
                Object.values(dayData[category]).forEach(item => {
                    const status = item.status || 'none';
                    if (status === 'none' || status === 'pular') {
                        counts.pulado++;
                    } else if (status === 'concluido' || status === 'concluido-ongoing') {
                        counts.concluido++;
                    } else if (status === 'em-andamento') {
                        counts.emAndamento++;
                    } else if (status === 'aguardando') {
                        counts.aguardando++;
                    } else if (status === 'nao-feito' || status === 'bloqueado' || status === 'prioridade') {
                        counts.naoFeito++;
                    }
                    counts.total++;
                });
            }
        });

        return {
            concluido: counts.concluido,
            emAndamento: counts.emAndamento,
            aguardando: counts.aguardando,
            naoFeito: counts.naoFeito,
            pulado: 0
        };
    },

    async calculatePeriodStatusPercentages(startDate, endDate) {
        const counts = {
            concluido: 0,
            emAndamento: 0,
            aguardando: 0,
            naoFeito: 0,
            pulado: 0,
            total: 0
        };

        let currentDate = new Date(startDate);
        while (currentDate <= endDate) {
            const dateStr = this.getDateString(currentDate);
            const dayData = await StorageManager.getDateData(dateStr);
            
            ['clientes', 'categorias', 'atividades'].forEach(category => {
                if (dayData[category]) {
                    Object.values(dayData[category]).forEach(item => {
                        const status = item.status || 'none';
                        if (status === 'none' || status === 'pular') {
                            counts.pulado++;
                        } else if (status === 'concluido' || status === 'concluido-ongoing') {
                            counts.concluido++;
                        } else if (status === 'em-andamento') {
                            counts.emAndamento++;
                        } else if (status === 'aguardando') {
                            counts.aguardando++;
                        } else if (status === 'nao-feito' || status === 'bloqueado' || status === 'prioridade') {
                            counts.naoFeito++;
                        }
                        counts.total++;
                    });
                }
            });
            
            currentDate.setDate(currentDate.getDate() + 1);
        }

        return {
            concluido: counts.concluido,
            emAndamento: counts.emAndamento,
            aguardando: counts.aguardando,
            naoFeito: counts.naoFeito,
            pulado: 0
        };
    },

    async getGroupChartData(period, startDate, endDate) {
        const { labels } = await this.getChartData(period, startDate, endDate);
        
        const groupData = {
            clientes: [],
            categorias: [],
            atividades: []
        };

        if (period === 'week') {
            const monday = this.getWeekMonday(new Date());
            const today = new Date();
            today.setHours(23, 59, 59, 999);
            for (let i = 0; i < 7; i++) {
                const date = new Date(monday);
                date.setDate(monday.getDate() + i);
                if (date > today) {
                    groupData.clientes.push(0);
                    groupData.categorias.push(0);
                    groupData.atividades.push(0);
                } else {
                    const data = await this.calculateGroupPercentages(date, date);
                    groupData.clientes.push(data.clientes);
                    groupData.categorias.push(data.categorias);
                    groupData.atividades.push(data.atividades);
                }
            }
        } else if (period === 'month') {
            for (let week = 1; week <= 4; week++) {
                const weekStart = new Date();
                weekStart.setDate(weekStart.getDate() - (5 - week) * 7);
                const weekEnd = new Date(weekStart);
                weekEnd.setDate(weekEnd.getDate() + 6);
                
                const data = await this.calculateGroupPercentages(weekStart, weekEnd);
                groupData.clientes.push(data.clientes);
                groupData.categorias.push(data.categorias);
                groupData.atividades.push(data.atividades);
            }
        } else if (period === 'year') {
            for (let i = 11; i >= 0; i--) {
                const date = new Date();
                date.setMonth(date.getMonth() - i);
                
                const monthStart = new Date(date.getFullYear(), date.getMonth(), 1);
                const monthEnd = new Date(date.getFullYear(), date.getMonth() + 1, 0);
                
                const data = await this.calculateGroupPercentages(monthStart, monthEnd);
                groupData.clientes.push(data.clientes);
                groupData.categorias.push(data.categorias);
                groupData.atividades.push(data.atividades);
            }
        } else {
            const allData = await StorageManager.getData();
            const monthsWithData = new Map();
            
            for (const dateStr in allData) {
                const date = new Date(dateStr);
                const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
                if (!monthsWithData.has(monthKey)) {
                    monthsWithData.set(monthKey, { year: date.getFullYear(), month: date.getMonth() });
                }
            }
            
            const sortedMonths = Array.from(monthsWithData.values()).sort((a, b) => {
                if (a.year !== b.year) return a.year - b.year;
                return a.month - b.month;
            });
            
            for (const { year, month } of sortedMonths) {
                const monthStart = new Date(year, month, 1);
                const monthEnd = new Date(year, month + 1, 0);
                
                const data = await this.calculateGroupPercentages(monthStart, monthEnd);
                groupData.clientes.push(data.clientes);
                groupData.categorias.push(data.categorias);
                groupData.atividades.push(data.atividades);
            }
        }

        return { labels, groupData };
    },

    async calculateGroupPercentages(startDate, endDate) {
        const groups = {
            clientes: { completed: 0, total: 0 },
            categorias: { completed: 0, total: 0 },
            atividades: { completed: 0, total: 0 }
        };

        let currentDate = new Date(startDate);
        while (currentDate <= endDate) {
            const dateStr = this.getDateString(currentDate);
            const dayData = await StorageManager.getDateData(dateStr);
            
            ['clientes', 'categorias', 'atividades'].forEach(category => {
                // Total = number of items defined in APP_DATA for this category
                const totalItems = APP_DATA[category] ? APP_DATA[category].length : 0;
                groups[category].total += totalItems;

                if (dayData[category]) {
                    Object.values(dayData[category]).forEach(item => {
                        const status = (typeof item === 'string' ? item : item.status) || 'none';
                        // Only count concluded items
                        if (status === 'concluido' || status === 'concluido-ongoing') {
                            groups[category].completed++;
                        }
                    });
                }
            });
            
            currentDate.setDate(currentDate.getDate() + 1);
        }

        return {
            clientes: groups.clientes.total > 0 ? (groups.clientes.completed / groups.clientes.total) * 100 : 0,
            categorias: groups.categorias.total > 0 ? (groups.categorias.completed / groups.categorias.total) * 100 : 0,
            atividades: groups.atividades.total > 0 ? (groups.atividades.completed / groups.atividades.total) * 100 : 0
        };
    },

    async renderDrillDown(period, startDate, endDate) {
        let html = '<div class="drill-down-section">';
        html += '<h3>Detalhamento por Item</h3>';
        
        const categories = ['clientes', 'categorias', 'atividades'];
        const categoryIcons = {
            'clientes': '👥',
            'categorias': '🗂️',
            'atividades': '🎯'
        };
        const categoryNames = {
            'clientes': 'Clientes',
            'categorias': 'Categorias',
            'atividades': 'Atividades'
        };

        for (const category of categories) {
            const tableHtml = await this.renderDrillTable(category, period, startDate, endDate);
            html += `
                <div class="accordion-item">
                    <div class="accordion-header" data-category="${category}">
                        <span>${categoryIcons[category]} ${categoryNames[category]}</span>
                        <span class="accordion-icon">▼</span>
                    </div>
                    <div class="accordion-content">
                        ${tableHtml}
                    </div>
                </div>
            `;
        }
        
        html += '</div>';
        return html;
    },

    async renderDrillTable(category, period, startDate, endDate) {
        const dates = [];
        let currentDate = new Date(startDate);
        
        while (currentDate <= endDate) {
            dates.push(new Date(currentDate));
            currentDate.setDate(currentDate.getDate() + 1);
        }

        const itemsMap = new Map();
        for (const date of dates) {
            const dateStr = this.getDateString(date);
            const dayData = await StorageManager.getDateData(dateStr);
            
            if (dayData[category]) {
                Object.keys(dayData[category]).forEach(itemId => {
                    if (!itemsMap.has(itemId)) {
                        itemsMap.set(itemId, APP_DATA[category].find(i => i.id === itemId)?.name || itemId);
                    }
                });
            }
        }

        if (itemsMap.size === 0) {
            return '<div style="padding: 20px; text-align: center; color: rgba(255,255,255,0.5);">Nenhum dado disponível</div>';
        }

        let html = '<div class="drill-table-wrapper"><table class="drill-table"><thead><tr>';
        html += '<th>Item</th>';
        
        const displayDates = dates.slice(-30);
        
        displayDates.forEach(date => {
            const day = date.getDate();
            html += `<th>${day}</th>`;
        });
        
        html += '</tr></thead><tbody>';

        for (const [itemId, itemName] of itemsMap.entries()) {
            html += `<tr><td>${itemName}</td>`;
            
            for (const date of displayDates) {
                const dateStr = this.getDateString(date);
                const dayData = await StorageManager.getDateData(dateStr);
                const itemData = dayData[category]?.[itemId];
                
                if (itemData) {
                    const emoji = this.getStatusEmoji(itemData.status || 'none');
                    const hasNote = itemData.note && itemData.note.trim();
                    html += `<td>${emoji}${hasNote ? ' 📝' : ''}</td>`;
                } else {
                    html += '<td>—</td>';
                }
            }
            
            html += '</tr>';
        }

        html += '</tbody></table></div>';
        return html;
    },

});
