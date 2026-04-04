// app.js — Core: classe HabitTrackerApp + lifecycle + navegação
// Os métodos das views/features ficam nos mixins app-*.js

class HabitTrackerApp {
    constructor() {
        this.currentDate = new Date();
        this.currentView = 'today';
        this.selectedItem = null;
        // Speech recognition state
        this.recognition = null;
        this.isRecording = false;
        this.recognitionSupported = false;
        this.currentRecording = null; // { category, itemId, element }
        // Track currently editing item to ensure only one is active at a time
        this.currentlyEditingItem = null; // { element, noteEditable, category, itemId }
        // Scroll memory for "Hoje" tab
        this._todayScrollTop = 0;
        this._pendingScrollRestore = false;
        // Scroll memory for "Histórico" tab
        this._historyScrollTop = 0;
        // Charts
        this.performanceChart = null;
        this.groupChart = null;
        this.currentReportPeriod = 'week';
        this.init();
    }

    init() {
        // Detecta iOS PWA (adicionado à tela inicial) e marca o <html> com classe
        const isIosPwa = (
            ('standalone' in window.navigator && window.navigator.standalone === true) ||
            window.matchMedia('(display-mode: standalone)').matches
        ) && /iphone|ipad|ipod/i.test(navigator.userAgent);
        if (isIosPwa) {
            document.documentElement.classList.add('ios-pwa');
        }

        this.setupEventListeners();
        this.initSpeech();
        this._initWeekBarTooltips();
        this._initNoteImagePaste();
        this._syncHeaderHeight();
        window.addEventListener('resize', () => this._syncHeaderHeight());

        // Browser back/forward between tabs
        history.replaceState({ view: 'today' }, '', '#today');
        window.addEventListener('popstate', async (e) => {
            const view = e.state?.view || 'today';
            await this.showView(view, { fromPopState: true });
        });

        // Aplicar configurações salvas antes do primeiro render
        this.applySettings();
        this.renderTodayView();
        // Re-sincroniza após render para garantir cálculo correto no iOS PWA
        requestAnimationFrame(() => this._syncHeaderHeight());
        // Se havia um re-render pendente (sync do Supabase chegou antes do app inicializar)
        if (window._pendingRerender) {
            window._pendingRerender = false;
            this.renderCurrentView();
        }
        if (window._pendingRollover) {
            window._pendingRollover = false;
            this._checkMissedRollover();
        }
        // Check onboarding if it was deferred (sync happened before app init)
        if (window._pendingOnboarding) {
            window._pendingOnboarding = false;
            if (typeof this._checkOnboarding === 'function') {
                this._checkOnboarding();
            }
        }
        this._scheduleMidnightRollover();
        // Garantir flush para Supabase quando o usuário sai ou minimiza a aba
        this._setupUnloadFlush();
    }

    // Flush imediato para o Supabase ao fechar/minimizar aba
    _setupUnloadFlush() {
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                if (this.currentlyEditingItem) {
                    const { element, noteEditable, category, itemId } = this.currentlyEditingItem;
                    if (noteEditable) {
                        const text = this._getEditableText(noteEditable);
                        this.saveInlineNote(element, category, itemId, text);
                    }
                }
                StorageManager.flushToSupabase();
            }
        });

        window.addEventListener('beforeunload', () => {
            if (this.currentlyEditingItem) {
                const { element, noteEditable, category, itemId } = this.currentlyEditingItem;
                if (noteEditable) {
                    const text = this._getEditableText(noteEditable);
                    this.saveInlineNote(element, category, itemId, text);
                }
            }
            StorageManager.flushToSupabase();
        });
    }

    // ── Rollover de meia-noite ────────────────────────────────────────────
    async _markPendingAsNotDone(dateStr) {
        if (!StorageManager.syncReady) {
            console.warn('⛔ Rollover bloqueado: syncReady=false');
            return;
        }
        const categories = [
            { key: 'clientes',   items: APP_DATA.clientes   },
            { key: 'categorias', items: APP_DATA.categorias },
            { key: 'atividades', items: APP_DATA.atividades },
        ];
        let changed = false;
        for (const { key, items } of categories) {
            for (const item of (items || [])) {
                const data = await StorageManager.getItemStatus(dateStr, key, item.id);
                if (!data.status || data.status === 'none') {
                    await StorageManager.saveItemStatus(dateStr, key, item.id, 'nao-feito', data.note || '');
                    changed = true;
                }
            }
        }
        if (changed) {
            console.log(`⏰ Rollover meia-noite: itens sem status do dia ${dateStr} marcados como não feito.`);
        }
    }

    async _checkMissedRollover() {
        const lastKey = 'ht-last-active-date';
        const today = new Date();
        const todayStr = this.getDateString(today);
        const lastDate = localStorage.getItem(lastKey);

        if (lastDate && lastDate !== todayStr) {
            await this._markPendingAsNotDone(lastDate);
        }
        localStorage.setItem(lastKey, todayStr);
    }

    _scheduleMidnightRollover() {
        const now = new Date();
        const nextMidnight = new Date(
            now.getFullYear(), now.getMonth(), now.getDate() + 1,
            0, 0, 0, 0
        );
        const msUntilMidnight = nextMidnight.getTime() - now.getTime();

        this._midnightTimer = setTimeout(async () => {
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            const yesterdayStr = this.getDateString(yesterday);

            await this._markPendingAsNotDone(yesterdayStr);
            localStorage.setItem('ht-last-active-date', this.getDateString(new Date()));

            if (this.currentView === 'today') {
                this.currentDate = new Date();
                this.renderTodayView();
            }

            this._scheduleMidnightRollover();
        }, msUntilMidnight);

        console.log(`⏰ Rollover agendado em ${Math.round(msUntilMidnight / 1000 / 60)} minutos.`);
    }

    // ── Layout helpers ───────────────────────────────────────────────────
    _syncHeaderHeight() {
        const headerEl = document.querySelector('.header');
        if (!headerEl) return;

        const h = headerEl.getBoundingClientRect().height;
        document.documentElement.style.setProperty('--header-h', Math.round(h) + 'px');

        if (!document.documentElement.classList.contains('ios-pwa')) return;

        const dateSelEl = document.querySelector('.view:not(.hidden) .date-selector')
                       || document.querySelector('.date-selector');
        if (dateSelEl) {
            const dsH = dateSelEl.getBoundingClientRect().height;
            document.documentElement.style.setProperty('--date-sel-h', Math.round(dsH) + 'px');
        }

        const filterEl = document.getElementById('historyStatusFilter');
        if (filterEl && filterEl.offsetParent !== null) {
            const fH = filterEl.getBoundingClientRect().height;
            if (fH > 0) {
                document.documentElement.style.setProperty('--history-filter-h', Math.round(fH) + 'px');
            }
        }
    }

    _syncHistoryFilterHeight() {
        if (!document.documentElement.classList.contains('ios-pwa')) return;
        const tryMeasure = (attempts) => {
            const dateSelEl = document.querySelector('#historyView .date-selector');
            if (dateSelEl) {
                const dsH = dateSelEl.getBoundingClientRect().height;
                if (dsH > 0) {
                    document.documentElement.style.setProperty('--date-sel-h', Math.round(dsH) + 'px');
                }
            }
            const filterEl = document.getElementById('historyStatusFilter');
            if (filterEl) {
                const fH = filterEl.getBoundingClientRect().height;
                if (fH > 0) {
                    document.documentElement.style.setProperty('--history-filter-h', Math.round(fH) + 'px');
                    return;
                }
            }
            if (attempts > 0) requestAnimationFrame(() => tryMeasure(attempts - 1));
        };
        requestAnimationFrame(() => tryMeasure(8));
    }

    // ── View routing ─────────────────────────────────────────────────────
    renderCurrentView() {
        console.log('Re-renderizando view após sync:', this.currentView);
        if (this.currentView === 'today') {
            this.renderTodayView();
        } else if (this.currentView === 'history') {
            const dateStr = this.historyDate
                ? this.getDateString(this.historyDate)
                : this.getDateString(new Date());
            this._historyScrollTop = window.scrollY;
            this._pendingHistoryScrollRestore = true;
            this.renderHistoryAsSpreadsheet(dateStr);
        } else if (this.currentView === 'reports') {
            this.renderReports(this.currentReportPeriod || 'week');
        } else if (this.currentView === 'aprendizados') {
            if (typeof Aprendizados !== 'undefined') Aprendizados.onShow();
        } else if (this.currentView === 'ranking') {
            if (typeof this.renderRankingView === 'function') this.renderRankingView();
        }
    }

    async showView(view, opts = {}) {
        if (this.currentView === 'aprendizados' && typeof Aprendizados !== 'undefined') {
            Aprendizados.onHide();
        }

        const mainContent = document.getElementById('mainContent');
        if (this.currentView === 'today') {
            this._todayScrollTop = window.scrollY;
        } else if (this.currentView === 'history') {
            this._historyScrollTop = window.scrollY;
        } else if (this.currentView === 'reports') {
            this._reportsScrollTop = window.scrollY;
        }

        this.currentView = view;

        if (!opts.fromPopState) {
            history.pushState({ view }, '', '#' + view);
        }

        document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
        document.querySelectorAll('.btn-nav-header').forEach(btn => btn.classList.remove('active'));

        if (mainContent) {
            mainContent.classList.toggle('history-mode', view === 'history');
        }
        
        if (view === 'today') {
            document.getElementById('todayView').classList.remove('hidden');
            document.getElementById('btnToday').classList.add('active');
            this._pendingScrollRestore = true;
            this.renderTodayView();
        } else if (view === 'history') {
            document.getElementById('historyView').classList.remove('hidden');
            document.getElementById('btnHistory').classList.add('active');
            this._pendingHistoryScrollRestore = true;
            if (!this.historyDate) {
                this.historyDate = new Date();
                this.historyDate.setHours(12, 0, 0, 0);
            }
            this._updateHistoryDateLabel();
            await this.renderHistoryAsSpreadsheet(this.getDateString(this.historyDate));
            requestAnimationFrame(() => this._syncHeaderHeight());
            this._syncHistoryFilterHeight();
        } else if (view === 'reports') {
            document.getElementById('reportsView').classList.remove('hidden');
            document.getElementById('btnReports').classList.add('active');
            window.scrollTo(0, 0);
            await this.renderReports(this.currentReportPeriod || 'week');
        } else if (view === 'aprendizados') {
            document.getElementById('aprendizadosView').classList.remove('hidden');
            document.getElementById('btnAprendizados').classList.add('active');
            window.scrollTo(0, 0);
            if (typeof Aprendizados !== 'undefined') {
                if (!this._aprendizadosInited) {
                    Aprendizados.init();
                    this._aprendizadosInited = true;
                } else {
                    Aprendizados.onShow();
                }
            }
        } else if (view === 'settings') {
            document.getElementById('settingsView').classList.remove('hidden');
            document.getElementById('btnSettings').classList.add('active');
            window.scrollTo(0, 0);
            this.renderSettingsView();
        } else if (view === 'ranking') {
            document.getElementById('rankingView').classList.remove('hidden');
            document.getElementById('btnRanking').classList.add('active');
            window.scrollTo(0, 0);
            if (typeof this.renderRankingView === 'function') await this.renderRankingView();
        }
    }

    changeDate(days) {
        this._todayScrollTop = window.scrollY;
        this._pendingScrollRestore = true;
        this.currentDate.setDate(this.currentDate.getDate() + days);
        this.renderTodayView();
    }

    // ── Utilidades ───────────────────────────────────────────────────────
    getDateString(date = this.currentDate) {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }

    formatDate(date) {
        const days = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
        const months = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
        
        const dayName = days[date.getDay()];
        const day = date.getDate();
        const month = months[date.getMonth()];
        const year = date.getFullYear();
        
        return `${dayName}, ${day} ${month} ${year}`;
    }

    getStatusEmoji(status) {
        const emojiMap = {
            'concluido': '✅',
            'concluido-ongoing': '✅',
            'em-andamento': '🟡',
            'nao-feito': '❌',
            'bloqueado': '🚫',
            'aguardando': '🔵',
            'parcialmente': '🟠',
            'pular': '⏭️',
            'prioridade': '⚫',
            'none': '—'
        };
        return emojiMap[status] || '—';
    }

    setupAccordions() {
        document.querySelectorAll('.accordion-header').forEach(header => {
            header.addEventListener('click', () => {
                const item = header.closest('.accordion-item');
                const wasActive = item.classList.contains('active');
                
                if (wasActive) {
                    item.classList.remove('active');
                } else {
                    item.classList.add('active');
                }
            });
        });
    }
}

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.app = new HabitTrackerApp();
});
