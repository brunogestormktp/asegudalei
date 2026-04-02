// Main App Logic
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
        // (date-selector precisa já estar no DOM com altura real)
        requestAnimationFrame(() => this._syncHeaderHeight());
        // Se havia um re-render pendente (sync do Supabase chegou antes do app inicializar)
        if (window._pendingRerender) {
            window._pendingRerender = false;
            this.renderCurrentView();
        }
        // Se havia um rollover pendente (sync do Supabase completou antes do app inicializar)
        if (window._pendingRollover) {
            window._pendingRollover = false;
            this._checkMissedRollover();
        }
        // Agenda rollover da meia-noite (NÃO chama _checkMissedRollover aqui —
        // rollover só é seguro após forceSyncFromSupabase, controlado por app-auth.js)
        this._scheduleMidnightRollover();
        // Garantir flush para Supabase quando o usuário sai ou minimiza a aba
        this._setupUnloadFlush();
    }

    // Flush imediato para o Supabase ao fechar/minimizar aba
    _setupUnloadFlush() {
        // Quando a aba vai para background ou é fechada
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                // Salvar nota em edição antes de sair
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

        // Fallback para fechar janela/navegar para outra URL
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
    // Ao virar 00:00, marca como "não feito" todos os itens que ficaram
    // com status "nenhum" no dia que acabou de passar.
    async _markPendingAsNotDone(dateStr) {
        // Proteção: jamais correr antes do sync do Supabase concluir
        if (!StorageManager.syncReady) {
            console.warn('⛔ Rollover bloqueado: syncReady=false. Abortando para proteger dados.');
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

    // Verifica se o app ficou aberto e passou por uma virada de dia sem processar
    async _checkMissedRollover() {
        const lastKey = 'ht-last-active-date';
        const today = new Date();
        const todayStr = this.getDateString(today);
        const lastDate = localStorage.getItem(lastKey);

        if (lastDate && lastDate !== todayStr) {
            // Houve virada de dia(s) perdida — marcar o dia anterior
            await this._markPendingAsNotDone(lastDate);
        }
        localStorage.setItem(lastKey, todayStr);
    }

    // Agenda execução exatamente à meia-noite e repete a cada dia
    _scheduleMidnightRollover() {
        const now = new Date();
        const nextMidnight = new Date(
            now.getFullYear(), now.getMonth(), now.getDate() + 1,
            0, 0, 0, 0
        );
        const msUntilMidnight = nextMidnight.getTime() - now.getTime();

        this._midnightTimer = setTimeout(async () => {
            // O dia que acabou de passar
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            const yesterdayStr = this.getDateString(yesterday);

            await this._markPendingAsNotDone(yesterdayStr);

            // Atualiza a data ativa registrada
            localStorage.setItem('ht-last-active-date', this.getDateString(new Date()));

            // Re-renderiza se estiver na view de hoje
            if (this.currentView === 'today') {
                this.currentDate = new Date();
                this.renderTodayView();
            }

            // Reagenda para a próxima meia-noite
            this._scheduleMidnightRollover();
        }, msUntilMidnight);

        console.log(`⏰ Rollover agendado em ${Math.round(msUntilMidnight / 1000 / 60)} minutos.`);
    }

    // Mede a altura real do .header e seta --header-h no :root
    // Garante que o date-selector sticky/fixed nunca fique sob o header
    _syncHeaderHeight() {
        const headerEl = document.querySelector('.header');
        if (!headerEl) return;

        const h = headerEl.getBoundingClientRect().height;
        document.documentElement.style.setProperty('--header-h', Math.round(h) + 'px');

        if (!document.documentElement.classList.contains('ios-pwa')) return;

        // Medir o date-selector visível (ignora os de views ocultas)
        const dateSelEl = document.querySelector('.view:not(.hidden) .date-selector')
                       || document.querySelector('.date-selector');
        if (dateSelEl) {
            const dsH = dateSelEl.getBoundingClientRect().height;
            document.documentElement.style.setProperty('--date-sel-h', Math.round(dsH) + 'px');
        }

        // Medir filtro do histórico (só quando visível)
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
        // Mede date-selector e historyStatusFilter e atualiza as vars CSS
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

    // Re-renderiza a view ativa atual (usado após sync do Supabase)
    renderCurrentView() {
        console.log('Re-renderizando view após sync:', this.currentView);
        if (this.currentView === 'today') {
            this.renderTodayView();
        } else if (this.currentView === 'history') {
            const dateStr = this.historyDate
                ? this.getDateString(this.historyDate)
                : this.getDateString(new Date());
            // Preserva scroll durante re-render por sync
            this._historyScrollTop = window.scrollY;
            this._pendingHistoryScrollRestore = true;
            this.renderHistoryAsSpreadsheet(dateStr);
        } else if (this.currentView === 'reports') {
            this.renderReports(this.currentReportPeriod || 'week');
        } else if (this.currentView === 'aprendizados') {
            if (typeof Aprendizados !== 'undefined') Aprendizados.onShow();
        }
        // settings não precisa de re-render de dados
    }

    // Show custom confirmation modal
    showConfirmModal(title, message) {
        return new Promise((resolve) => {
            const modal = document.getElementById('confirmModal');
            const titleEl = document.getElementById('confirmTitle');
            const messageEl = document.getElementById('confirmMessage');
            const btnYes = document.getElementById('btnConfirmYes');
            const btnNo = document.getElementById('btnConfirmNo');
            
            titleEl.textContent = title;
            messageEl.textContent = message;
            modal.classList.add('show');
            
            const handleYes = () => {
                modal.classList.remove('show');
                btnYes.removeEventListener('click', handleYes);
                btnNo.removeEventListener('click', handleNo);
                resolve(true);
            };
            
            const handleNo = () => {
                modal.classList.remove('show');
                btnYes.removeEventListener('click', handleYes);
                btnNo.removeEventListener('click', handleNo);
                resolve(false);
            };
            
            btnYes.addEventListener('click', handleYes);
            btnNo.addEventListener('click', handleNo);
            
            // ESC key to cancel
            const handleEsc = (e) => {
                if (e.key === 'Escape') {
                    handleNo();
                    document.removeEventListener('keydown', handleEsc);
                }
            };
            document.addEventListener('keydown', handleEsc);
        });
    }

    // Show popup asking for the learning/aprendizado when an item is marked as concluido
    showAprendizadoPopup(category, itemId, itemName) {
        return new Promise((resolve) => {
            const modal = document.getElementById('aprendizadoModal');
            const input = document.getElementById('aprendizadoInput');
            const wordCountEl = document.getElementById('aprendizadoWordCount');
            const btnSave = document.getElementById('btnAprendSave');
            const btnSkip = document.getElementById('btnAprendSkip');
            if (!modal) { resolve(null); return; }

            input.value = '';
            wordCountEl.textContent = '0';
            wordCountEl.classList.remove('over-limit');
            input.classList.remove('over-limit');
            btnSave.disabled = true;
            modal.classList.add('show');

            // Auto-focus input after animation
            setTimeout(() => input.focus(), 80);

            const countChars = (str) => str.length;

            const onInput = () => {
                const chars = countChars(input.value);
                wordCountEl.textContent = chars;
                const enough = chars >= 10;
                wordCountEl.classList.toggle('over-limit', !enough && chars > 0);
                input.classList.remove('over-limit');
                btnSave.disabled = !enough;
            };
            input.addEventListener('input', onInput);

            const cleanup = () => {
                modal.classList.remove('show');
                input.removeEventListener('input', onInput);
                btnSave.removeEventListener('click', handleSave);
                btnSkip.removeEventListener('click', handleSkip);
                document.removeEventListener('keydown', handleKey);
            };

            const handleSave = async () => {
                const text = input.value.trim();
                if (!text || countChars(text) < 10) return;
                cleanup();
                // Save to aprendizados tab
                if (typeof Aprendizados !== 'undefined' && text) {
                    Aprendizados.addToFixedNote(category, itemId, 'concluido', text);
                }
                // Save to history: append 🧠 note to today's item record
                const dateStr = this.getDateString();
                const existing = await StorageManager.getItemStatus(dateStr, category, itemId);
                const prevNote = existing.note ? existing.note.trim() : '';
                const aprendNote = `🧠 ${text}`;
                const newNote = prevNote ? `${prevNote}\n${aprendNote}` : aprendNote;
                await StorageManager.saveItemStatus(dateStr, category, itemId, existing.status || 'concluido', newNote);
                resolve(text);
            };

            const handleSkip = () => { cleanup(); resolve(null); };

            const handleKey = (e) => {
                if (e.key === 'Enter') { e.preventDefault(); handleSave(); }
                if (e.key === 'Escape') handleSkip();
            };

            btnSave.addEventListener('click', handleSave);
            btnSkip.addEventListener('click', handleSkip);
            document.addEventListener('keydown', handleKey);
        });
    }

    // Show popup asking for the reason when an item is marked as bloqueado
    showBloqueadoPopup(category, itemId) {
        return new Promise((resolve) => {
            const modal = document.getElementById('bloqueadoModal');
            const input = document.getElementById('bloqueadoInput');
            const wordCountEl = document.getElementById('bloqueadoWordCount');
            const btnSave = document.getElementById('btnBloqueadoSave');
            const btnSkip = document.getElementById('btnBloqueadoSkip');
            if (!modal) { resolve(null); return; }

            input.value = '';
            wordCountEl.textContent = '0';
            btnSave.disabled = true;
            modal.classList.add('show');

            setTimeout(() => input.focus(), 80);

            const onInput = () => {
                const chars = input.value.length;
                wordCountEl.textContent = chars;
                btnSave.disabled = chars < 5;
            };
            input.addEventListener('input', onInput);

            const cleanup = () => {
                modal.classList.remove('show');
                input.removeEventListener('input', onInput);
                btnSave.removeEventListener('click', handleSave);
                btnSkip.removeEventListener('click', handleSkip);
                document.removeEventListener('keydown', handleKey);
            };

            const handleSave = async () => {
                const text = input.value.trim();
                if (!text || text.length < 5) return;
                cleanup();
                // Save to aprendizados tab
                if (typeof Aprendizados !== 'undefined' && text) {
                    Aprendizados.addToFixedNote(category, itemId, 'bloqueado', text);
                }
                // Append 🚫 reason to the note
                const dateStr = this.getDateString();
                const existing = await StorageManager.getItemStatus(dateStr, category, itemId);
                const prevNote = existing.note ? existing.note.trim() : '';
                const bloqNote = `🚫 ${text}`;
                const newNote = prevNote ? `${prevNote}\n${bloqNote}` : bloqNote;
                await StorageManager.saveItemStatus(dateStr, category, itemId, existing.status || 'bloqueado', newNote);
                resolve(text);
            };

            const handleSkip = () => { cleanup(); resolve(null); };

            const handleKey = (e) => {
                if (e.key === 'Enter') { e.preventDefault(); handleSave(); }
                if (e.key === 'Escape') handleSkip();
            };

            btnSave.addEventListener('click', handleSave);
            btnSkip.addEventListener('click', handleSkip);
            document.addEventListener('keydown', handleKey);
        });
    }

    // Show popup asking what's missing when an item is marked as parcialmente
    showParcialmentePopup(category, itemId) {
        return new Promise((resolve) => {
            const modal = document.getElementById('parcialmenteModal');
            const input = document.getElementById('parcialmenteInput');
            const wordCountEl = document.getElementById('parcialmenteWordCount');
            const btnSave = document.getElementById('btnParcialmenteSave');
            const btnSkip = document.getElementById('btnParcialmenteSkip');
            if (!modal) { resolve(null); return; }

            input.value = '';
            wordCountEl.textContent = '0';
            btnSave.disabled = true;
            modal.classList.add('show');

            setTimeout(() => input.focus(), 80);

            const onInput = () => {
                const chars = input.value.length;
                wordCountEl.textContent = chars;
                btnSave.disabled = chars < 5;
            };
            input.addEventListener('input', onInput);

            const cleanup = () => {
                modal.classList.remove('show');
                input.removeEventListener('input', onInput);
                btnSave.removeEventListener('click', handleSave);
                btnSkip.removeEventListener('click', handleSkip);
                document.removeEventListener('keydown', handleKey);
            };

            const handleSave = async () => {
                const text = input.value.trim();
                if (!text || text.length < 5) return;
                cleanup();
                // Save to aprendizados tab
                if (typeof Aprendizados !== 'undefined' && text) {
                    Aprendizados.addToFixedNote(category, itemId, 'parcialmente', text);
                }
                // Append ⏳ pending note to today's item record
                const dateStr = this.getDateString();
                const existing = await StorageManager.getItemStatus(dateStr, category, itemId);
                const prevNote = existing.note ? existing.note.trim() : '';
                const parcNote = `⏳ ${text}`;
                const newNote = prevNote ? `${prevNote}\n${parcNote}` : parcNote;
                await StorageManager.saveItemStatus(dateStr, category, itemId, existing.status || 'parcialmente', newNote);
                resolve(text);
            };

            const handleSkip = () => { cleanup(); resolve(null); };

            const handleKey = (e) => {
                if (e.key === 'Enter') { e.preventDefault(); handleSave(); }
                if (e.key === 'Escape') handleSkip();
            };

            btnSave.addEventListener('click', handleSave);
            btnSkip.addEventListener('click', handleSkip);
            document.addEventListener('keydown', handleKey);
        });
    }

    // Centralized method to exit edit mode for any currently editing item
    exitCurrentEditMode(saveChanges = true) {
        if (this.currentlyEditingItem) {
            const { element, noteEditable, category, itemId } = this.currentlyEditingItem;

            if (saveChanges && noteEditable) {
                const text = this._getEditableText(noteEditable);
                // Se o Realtime está sincronizando, não disparar push imediato —
                // os dados do outro dispositivo acabaram de chegar e não devem ser sobrescritos
                if (StorageManager._realtimeSyncing) {
                    // Salvar apenas no localStorage, sem push ao Supabase
                    StorageManager.getData().then(allData => {
                        const dateStr = this.getDateString();
                        if (!allData[dateStr]) allData[dateStr] = {};
                        if (!allData[dateStr][category]) allData[dateStr][category] = {};
                        const existing = allData[dateStr][category][itemId] || {};
                        allData[dateStr][category][itemId] = {
                            ...existing,
                            note: text,
                            updatedAt: new Date().toISOString()
                        };
                        const json = JSON.stringify(allData);
                        localStorage.setItem(StorageManager.STORAGE_KEY, json);
                        localStorage.setItem(StorageManager.BACKUP_KEY, json);
                    });
                } else {
                    this.saveInlineNote(element, category, itemId, text);
                }
            }

            // Esconder editable — o blur dispara o save também (lock por item evita duplo)
            if (noteEditable) {
                noteEditable.blur();
                noteEditable.style.display = 'none';
            }

            // Show the regular note display if needed
            const displayedNote = element.querySelector('.item-note');
            if (displayedNote && displayedNote.innerHTML.trim()) {
                displayedNote.style.display = 'block';
            }

            this.currentlyEditingItem = null;
        }
    }

    // Force immediate switch to edit mode for a specific item
    forceEditMode(element, noteEditable, category, itemId) {
        // Salvar e fechar o item que estava em edição
        if (this.currentlyEditingItem && this.currentlyEditingItem.element !== element) {
            const current = this.currentlyEditingItem;
            if (current.noteEditable) {
                const text = this._getEditableText(current.noteEditable);
                this.saveInlineNote(current.element, current.category, current.itemId, text);
                current.noteEditable.blur();
                current.noteEditable.style.display = 'none';

                const prevDisplayed = current.element.querySelector('.item-note');
                if (prevDisplayed && prevDisplayed.innerHTML.trim()) {
                    prevDisplayed.style.display = 'block';
                }
            }
        }
        
        // Set new editing state immediately
        this.currentlyEditingItem = { element, noteEditable, category, itemId };
        
        // Hide displayed note and show editable
        const displayed = element.querySelector('.item-note');
        if (displayed) displayed.style.display = 'none';
        
        noteEditable.style.display = 'block';
        noteEditable.focus();
        
        // Position cursor at end
        if (noteEditable.innerText.trim()) {
            setTimeout(() => {
                try {
                    const range = document.createRange();
                    const sel = window.getSelection();
                    range.selectNodeContents(noteEditable);
                    range.collapse(false);
                    sel.removeAllRanges();
                    sel.addRange(range);
                } catch (e) {
                    noteEditable.focus();
                }
            }, 10);
        }
    }

    // Initialize Web Speech API (fallback safe)
    initSpeech() {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition || null;
        if (!SpeechRecognition) {
            this.recognitionSupported = false;
            return;
        }

        this.recognition = new SpeechRecognition();
        this.recognition.lang = 'pt-BR';
        this.recognition.interimResults = false;
        this.recognition.continuous = false;
        this.recognitionSupported = true;

        this.recognition.addEventListener('result', async (e) => {
            const transcript = Array.from(e.results)
                .map(r => r[0].transcript)
                .join('')
                .trim();

            if (!transcript) return;

            // Append transcript to existing note for the current recording target
            if (this.currentRecording) {
                const dateStr = this.getDateString();
                const { category, itemId } = this.currentRecording;
                const existing = await StorageManager.getItemStatus(dateStr, category, itemId);
                const prevNote = existing.note || '';
                const timestamp = new Date().toLocaleTimeString();
                const appended = (prevNote ? prevNote + '\n' : '') + `[voz ${timestamp}] ` + transcript;

                await StorageManager.saveItemStatus(dateStr, category, itemId, existing.status || 'none', appended);
                // update view
                this._todayScrollTop = window.scrollY;
                this._pendingScrollRestore = true;
                this.renderTodayView();
            }
        });

        this.recognition.addEventListener('end', () => {
            // clear recording state
            if (this.currentRecording && this.currentRecording.element) {
                this.currentRecording.element.classList.remove('recording');
            }
            this.isRecording = false;
            this.currentRecording = null;
        });

        this.recognition.addEventListener('error', (e) => {
            console.error('Speech recognition error', e);
            if (this.currentRecording && this.currentRecording.element) {
                this.currentRecording.element.classList.remove('recording');
            }
            this.isRecording = false;
            this.currentRecording = null;
        });
    }

    startRecordingFor(element, category, itemId) {
        if (!this.recognitionSupported) return;
        try {
            // If another recording is active, stop it first
            if (this.isRecording && this.currentRecording) {
                this.stopRecording();
            }

            this.currentRecording = { category, itemId, element };
            this.isRecording = true;

            // Visual indicator
            element.classList.add('recording');
            const btn = element.querySelector('.btn-mic');
            if (btn) btn.textContent = '⏹️';

            this.recognition.start();
        } catch (e) {
            console.error('Erro iniciando reconhecimento', e);
            alert('Não foi possível iniciar a gravação de voz. Verifique permissões de microfone.');
            this.isRecording = false;
            if (this.currentRecording && this.currentRecording.element) {
                this.currentRecording.element.classList.remove('recording');
            }
            this.currentRecording = null;
        }
    }

    stopRecording() {
        if (!this.recognitionSupported || !this.isRecording) return;
        try {
            if (this.recognition) {
                this.recognition.stop();
            }
        } catch (e) {
            console.error('Erro parando reconhecimento', e);
        }

        if (this.currentRecording && this.currentRecording.element) {
            const el = this.currentRecording.element;
            el.classList.remove('recording');
            const btn = el.querySelector('.btn-mic');
            if (btn) btn.textContent = '🎙️';
        }

        this.isRecording = false;
        this.currentRecording = null;
    }

    setupEventListeners() {
        // Navigation buttons
        document.getElementById('btnToday').addEventListener('click', () => this.showView('today'));
        document.getElementById('btnHistory').addEventListener('click', () => this.showView('history'));
        document.getElementById('btnReports').addEventListener('click', () => this.showView('reports'));
        document.getElementById('btnAprendizados').addEventListener('click', () => this.showView('aprendizados'));
        document.getElementById('btnSettings').addEventListener('click', () => this.showView('settings'));

        // Histórico → navegar para item no Hoje ao clicar na linha
        document.getElementById('historyContent').addEventListener('click', (e) => {
            const tr = e.target.closest('tr.hs-tr-nav');
            if (!tr) return;
            const itemId   = tr.dataset.itemId;
            const category = tr.dataset.category;
            if (!itemId || !category) return;
            this._pendingHighlightItemId  = itemId;
            this._pendingHighlightCategory = category;
            this.showView('today');
        });

        // Date navigation
        document.getElementById('btnPrevDay').addEventListener('click', () => this.changeDate(-1));
        document.getElementById('btnNextDay').addEventListener('click', () => this.changeDate(1));

        // Today status filter
        document.getElementById('todayStatusFilter').addEventListener('click', (e) => {
            const btn = e.target.closest('.tsf-btn');
            if (!btn) return;
            document.querySelectorAll('.tsf-btn').forEach(b => b.classList.remove('tsf-active'));
            btn.classList.add('tsf-active');
            this._activeTodayFilter = btn.dataset.status;
            this._applyTodayFilter();
        });

        // Today search
        const searchToggle = document.getElementById('todaySearchToggle');
        const searchInput  = document.getElementById('todaySearchInput');
        const searchClear  = document.getElementById('todaySearchClear');
        const searchWrap   = document.getElementById('todaySearchWrap');

        searchToggle.addEventListener('click', () => {
            const isOpen = searchWrap.classList.toggle('tsf-search-open');
            if (isOpen) {
                searchInput.focus();
            } else {
                searchInput.value = '';
                this._todaySearchQuery = '';
                searchClear.style.display = 'none';
                this._applyTodayFilter();
            }
        });

        searchInput.addEventListener('input', () => {
            this._todaySearchQuery = searchInput.value.trim().toLowerCase();
            searchClear.style.display = this._todaySearchQuery ? 'flex' : 'none';
            this._applyTodayFilter();
        });

        searchClear.addEventListener('click', () => {
            searchInput.value = '';
            this._todaySearchQuery = '';
            searchClear.style.display = 'none';
            searchInput.focus();
            this._applyTodayFilter();
        });

        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                searchWrap.classList.remove('tsf-search-open');
                searchInput.value = '';
                this._todaySearchQuery = '';
                searchClear.style.display = 'none';
                this._applyTodayFilter();
            }
        });

        // Modal
        document.getElementById('btnSaveModal').addEventListener('click', () => this.saveItem());
        document.getElementById('btnCancelModal').addEventListener('click', () => this.closeModal());
        document.getElementById('itemModal').addEventListener('click', (e) => {
            if (e.target.id === 'itemModal') this.closeModal();
        });

        // Report period buttons
        document.querySelectorAll('.btn-period').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                document.querySelectorAll('.btn-period').forEach(b => b.classList.remove('active'));
                e.currentTarget.classList.add('active');
                const period = e.currentTarget.dataset.period;
                this._reportsScrollTop = 0; // reset scroll when changing period
                window.scrollTo(0, 0);
                await this.renderReports(period);
            });
        });

        // Navegação de data no histórico (← →)
        document.getElementById('btnPrevHistory').addEventListener('click', () => this.changeHistoryDate(-1));
        document.getElementById('btnNextHistory').addEventListener('click', () => this.changeHistoryDate(1));

        // Filtro de status do histórico
        document.getElementById('historyStatusFilter').addEventListener('click', (e) => {
            const btn = e.target.closest('.tsf-btn');
            if (!btn) return;
            document.querySelectorAll('#historyStatusFilter .tsf-btn').forEach(b => b.classList.remove('tsf-active'));
            btn.classList.add('tsf-active');
            this._activeHistoryFilter = btn.dataset.status;
            this._reRenderHistory();
        });

        // Busca no histórico
        const hSearchToggle = document.getElementById('historySearchToggle');
        const hSearchInput  = document.getElementById('historySearchInput');
        const hSearchClear  = document.getElementById('historySearchClear');
        const hSearchWrap   = document.getElementById('historySearchWrap');

        hSearchToggle.addEventListener('click', () => {
            const isOpen = hSearchWrap.classList.toggle('tsf-search-open');
            if (isOpen) {
                hSearchInput.focus();
            } else {
                hSearchInput.value = '';
                this._historySearchQuery = '';
                hSearchClear.style.display = 'none';
                // Sair do modo range ao fechar a busca
                this._historyDateRange = null;
                this._updateHistoryDateLabel();
                this._reRenderHistory();
            }
        });

        hSearchInput.addEventListener('input', () => {
            this._historySearchQuery = hSearchInput.value.trim().toLowerCase();
            hSearchClear.style.display = this._historySearchQuery ? 'flex' : 'none';
            // Se esvaziou a busca, sair do modo range (volta ao dia normal)
            if (!this._historySearchQuery) {
                this._historyDateRange = null;
                this._updateHistoryDateLabel();
            }
            this._reRenderHistory();
        });

        hSearchClear.addEventListener('click', () => {
            hSearchInput.value = '';
            this._historySearchQuery = '';
            hSearchClear.style.display = 'none';
            // Sair do modo range ao limpar a busca — volta ao dia normal
            this._historyDateRange = null;
            this._updateHistoryDateLabel();
            hSearchInput.focus();
            this._reRenderHistory();
        });

        hSearchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                hSearchWrap.classList.remove('tsf-search-open');
                hSearchInput.value = '';
                this._historySearchQuery = '';
                hSearchClear.style.display = 'none';
                // Sair do modo range ao fechar com Escape
                this._historyDateRange = null;
                this._updateHistoryDateLabel();
                this._reRenderHistory();
            }
        });

        // Quick navigation for Today view
        document.querySelectorAll('.btn-quick-nav').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const targetId = e.currentTarget.dataset.target;
                const allCategories = document.querySelectorAll('.category');
                const targetElement = document.getElementById(targetId);
                
                // Check if this button is already active (toggle)
                const isActive = e.currentTarget.classList.contains('active-filter');
                
                // Remove active state from all buttons
                document.querySelectorAll('.btn-quick-nav').forEach(b => b.classList.remove('active-filter'));
                
                if (isActive) {
                    // If already active, show all categories with fade in
                    allCategories.forEach(cat => {
                        cat.classList.remove('fade-out');
                    });
                } else {
                    // Fade out all categories first
                    allCategories.forEach(cat => {
                        if (cat !== targetElement) {
                            cat.classList.add('fade-out');
                        }
                    });
                    
                    // Show only the target category
                    if (targetElement) {
                        targetElement.classList.remove('fade-out');
                        // Add active state to clicked button
                        e.currentTarget.classList.add('active-filter');
                        
                        // Add subtle pulse animation after a short delay
                        setTimeout(() => {
                            targetElement.style.animation = 'pulse 1s ease';
                            setTimeout(() => {
                                targetElement.style.animation = '';
                            }, 1000);
                        }, 300);
                    }
                }
            });
        });
        
        // Quick navigation for History view (scroll to first occurrence of category)
        document.querySelectorAll('.btn-quick-nav-history').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const category = e.currentTarget.dataset.category;
                const categoryLabels = {
                    'clientes': 'CLIENTES',
                    'categorias': 'EMPRESA',
                    'atividades': 'PESSOAL'
                };
                
                const labelText = categoryLabels[category];
                
                // Check if this button is already active (toggle)
                const isActive = e.currentTarget.classList.contains('active-filter');
                
                // Remove active state from all buttons
                document.querySelectorAll('.btn-quick-nav-history').forEach(b => b.classList.remove('active-filter'));
                
                if (isActive) {
                    // If already active, show all categories with fade in
                    document.querySelectorAll('.category-separator').forEach(sep => {
                        sep.classList.remove('fade-out');
                    });
                    document.querySelectorAll('.history-item-wrapper').forEach(item => {
                        item.classList.remove('fade-out');
                    });
                } else {
                    // Get all separators and items
                    const allSeparators = Array.from(document.querySelectorAll('.category-separator'));
                    const allItems = Array.from(document.querySelectorAll('.history-item-wrapper'));
                    
                    // Fade out all separators first
                    allSeparators.forEach(sep => {
                        if (sep.textContent !== labelText) {
                            sep.classList.add('fade-out');
                        }
                    });
                    
                    // Find the target separator
                    const targetSeparator = allSeparators.find(sep => sep.textContent === labelText);
                    
                    if (targetSeparator) {
                        // Show the target separator
                        targetSeparator.classList.remove('fade-out');
                        
                        // Add active state to clicked button
                        e.currentTarget.classList.add('active-filter');
                        
                        // Get the parent list
                        const parentList = targetSeparator.parentElement;
                        
                        // Show/hide items based on their position relative to separators
                        let currentCategory = null;
                        let foundTarget = false;
                        
                        Array.from(parentList.children).forEach(child => {
                            if (child.classList.contains('category-separator')) {
                                currentCategory = child.textContent;
                                foundTarget = (currentCategory === labelText);
                            } else if (child.classList.contains('history-item-wrapper')) {
                                if (foundTarget) {
                                    child.classList.remove('fade-out');
                                } else {
                                    child.classList.add('fade-out');
                                }
                            }
                        });
                        
                        // Add subtle pulse animation after a short delay
                        setTimeout(() => {
                            targetSeparator.style.animation = 'pulse 1s ease';
                            setTimeout(() => {
                                targetSeparator.style.animation = '';
                            }, 1000);
                        }, 300);
                    }
                }
            });
        });

        // Global click handler to exit edit mode when clicking outside items
        document.addEventListener('click', (e) => {
            // If click is not within any item, exit current edit mode
            if (!e.target.closest('.item')) {
                this.exitCurrentEditMode(true);
            }
        });

        // Global handler for item clicks to ensure immediate switching between edit modes
        document.addEventListener('click', (e) => {
            const clickedItem = e.target.closest('.item');
            if (clickedItem && this.currentlyEditingItem) {
                // If clicking on a different item than the currently editing one
                if (this.currentlyEditingItem.element !== clickedItem) {
                    // Force exit current edit mode immediately
                    this.exitCurrentEditMode(true);
                }
            }
        }, true); // Use capturing phase to ensure this runs first

        // Global handler for delete buttons using event delegation
        document.addEventListener('click', async (e) => {
            const deleteBtn = e.target.closest('.btn-note-delete');
            if (!deleteBtn) return;
            
            e.stopPropagation();
            e.preventDefault();
            console.log('Delete button clicked via delegation!'); // Debug log
            
            const itemId = deleteBtn.dataset.itemId;
            const category = deleteBtn.dataset.category;
            
            console.log('Item ID:', itemId, 'Category:', category); // Debug log
            
            if (!itemId || !category) {
                console.error('Missing item ID or category data attributes');
                return;
            }
            
            // Use custom confirmation modal
            const confirmed = await this.showConfirmModal(
                'Apagar Nota',
                'Tem certeza que deseja apagar esta nota? Esta ação não pode ser desfeita.'
            );
            
            if (!confirmed) return;
            
            console.log('User confirmed deletion for:', { category, itemId }); // Debug log
            
            const dateStr = this.getDateString();
            const existing = await StorageManager.getItemStatus(dateStr, category, itemId);
            await StorageManager.saveItemStatus(dateStr, category, itemId, existing.status || 'none', '');
            this._todayScrollTop = window.scrollY;
            this._pendingScrollRestore = true;
            this.renderTodayView();
        }, true); // Use capturing phase

        // Handler para remover imagem individual da nota (botão ✕ na miniatura)
        document.addEventListener('click', async (e) => {
            const removeBtn = e.target.closest('.note-img-remove');
            if (!removeBtn) return;
            e.stopPropagation();
            e.preventDefault();

            const srcToRemove = removeBtn.dataset.src;
            const itemNote    = removeBtn.closest('.item-note');
            if (!itemNote) return;
            const itemId   = itemNote.dataset.itemId;
            const category = itemNote.dataset.category;
            if (!itemId || !category) return;

            const dateStr = this.getDateString();
            const existing = await StorageManager.getItemStatus(dateStr, category, itemId);
            // Remover a linha [img:URL] correspondente do texto da nota
            const newNote = (existing.note || '')
                .split('\n')
                .filter(line => !line.trim().startsWith(`[img:${srcToRemove}]`) &&
                                !line.trim().startsWith(`[img:${srcToRemove} ]`) &&
                                !(line.trim() === `[img:${srcToRemove}]`))
                .filter(line => {
                    // Filtro mais robusto: remover qualquer linha [img:...] que contenha a src
                    const m = line.trim().match(/\[img:(.+?)\]$/);
                    return !(m && m[1].trim() === srcToRemove);
                })
                .join('\n')
                .trim();

            await StorageManager.saveItemStatus(dateStr, category, itemId, existing.status || 'none', newNote, existing.links || null);

            // Atualizar display sem re-render total
            const itemEl = itemNote.closest('.item');
            if (itemEl) this._updateNoteDisplay(itemEl, category, itemId, newNote);
        }, true);
        this.initAprendizadosPicker();
    }

    // ─── Aprendizados Picker: dropdown na quick-nav ─────────────────────
    initAprendizadosPicker() {
        const btn = document.getElementById('btnAprend');
        const dropdown = document.getElementById('aprendPickerDropdown');
        const searchInput = document.getElementById('aprendPickerSearch');
        if (!btn || !dropdown) return;

        const closeDropdown = () => {
            dropdown.classList.add('hidden');
            btn.classList.remove('is-open');
        };

        const openDropdown = () => {
            this._buildAprendPickerList('');
            // Posicionar fora da tela antes de mostrar (para medir sem flicker)
            dropdown.style.top = '-9999px';
            dropdown.style.left = '-9999px';
            dropdown.classList.remove('hidden');
            btn.classList.add('is-open');
            if (searchInput) searchInput.value = '';

            requestAnimationFrame(() => {
                const btnRect = btn.getBoundingClientRect();
                const dropRect = dropdown.getBoundingClientRect();
                const spaceBelow = window.innerHeight - btnRect.bottom;
                const spaceAbove = btnRect.top;

                // Vertical
                if (spaceBelow < dropRect.height + 8 && spaceAbove > dropRect.height) {
                    dropdown.style.top = `${btnRect.top - dropRect.height - 6}px`;
                } else {
                    dropdown.style.top = `${btnRect.bottom + 6}px`;
                }

                // Horizontal: alinhar pela esquerda do botão, não sair da tela
                const left = Math.min(btnRect.left, window.innerWidth - dropRect.width - 8);
                dropdown.style.left = `${Math.max(8, left)}px`;
            });
            setTimeout(() => searchInput?.focus(), 80);
        };

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (dropdown.classList.contains('hidden')) {
                openDropdown();
            } else {
                closeDropdown();
            }
        });

        // Fechar ao clicar fora
        document.addEventListener('click', (e) => {
            if (!dropdown.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
                closeDropdown();
            }
        });

        // Fechar ao scroll
        window.addEventListener('scroll', () => {
            if (!dropdown.classList.contains('hidden')) closeDropdown();
        }, true);

        // Fechar com ESC
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !dropdown.classList.contains('hidden')) closeDropdown();
        });

        // Busca em tempo real
        searchInput?.addEventListener('input', (e) => {
            this._buildAprendPickerList(e.target.value.trim().toLowerCase());
        });
        searchInput?.addEventListener('keydown', (e) => e.stopPropagation());

        // Mover dropdown para body (portal) para escapar overflow/stacking
        document.body.appendChild(dropdown);
    }

    _buildAprendPickerList(filter) {
        const listEl = document.getElementById('aprendPickerList');
        if (!listEl) return;
        listEl.innerHTML = '';

        // Lê dados do aprendizados do localStorage
        let aprendData = {};
        try {
            aprendData = JSON.parse(localStorage.getItem('aprendizadosData') || '{}');
        } catch { aprendData = {}; }

        const groups = [
            { key: 'clientes',   label: '👥 Clientes',  items: APP_DATA.clientes },
            { key: 'categorias', label: '🏢 Empresa',   items: APP_DATA.categorias },
            { key: 'atividades', label: '👤 Pessoal',   items: APP_DATA.atividades }
        ];

        let totalLines = 0;

        groups.forEach(({ key, label, items }) => {
            let groupAdded = false;

            items.forEach(item => {
                const noteData = aprendData[key]?.[item.id];
                const content = noteData?.content || '';
                const checkedLines = noteData?.checkedLines || {};
                if (!content.trim()) return;

                const lines = content.split('\n').filter(l => l.trim() !== '');
                const cleanName = item.name.replace(/^✅\s*/, '');

                // Filtrar por busca
                const matchedLines = filter
                    ? lines.filter(l => l.toLowerCase().includes(filter) || cleanName.toLowerCase().includes(filter))
                    : lines;

                if (matchedLines.length === 0) return;

                // Adicionar header do grupo (uma vez por grupo)
                if (!groupAdded) {
                    if (totalLines > 0) {
                        const sep = document.createElement('div');
                        sep.className = 'aprendPicker-separator';
                        listEl.appendChild(sep);
                    }
                    const groupEl = document.createElement('div');
                    groupEl.className = 'aprendPicker-group';
                    groupEl.textContent = label.replace(/^\S+\s/, '').toUpperCase();
                    listEl.appendChild(groupEl);
                    groupAdded = true;
                }

                // Header do item
                const itemHeader = document.createElement('div');
                itemHeader.className = 'aprendPicker-item-header';
                itemHeader.textContent = cleanName;
                listEl.appendChild(itemHeader);

                // Cada linha
                matchedLines.forEach((lineText, lineIdx) => {
                    // índice real na lista de linhas (para checar checkedLines)
                    const realIdx = lines.indexOf(lineText);
                    const isChecked = !!checkedLines[realIdx];

                    const lineEl = document.createElement('div');
                    lineEl.className = 'aprendPicker-line';
                    lineEl.innerHTML = `
                        <svg class="aprendPicker-line-icon${isChecked ? ' done' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                            ${isChecked
                                ? '<polyline points="20 6 9 17 4 12"></polyline>'
                                : '<circle cx="12" cy="12" r="9"></circle>'
                            }
                        </svg>
                        <span></span>
                    `;
                    lineEl.querySelector('span').textContent = lineText;

                    lineEl.addEventListener('click', async (e) => {
                        e.stopPropagation();
                        await this._addAprendLineToHoje(key, item.id, lineText);
                        // Fechar dropdown
                        document.getElementById('aprendPickerDropdown')?.classList.add('hidden');
                        document.getElementById('btnAprend')?.classList.remove('is-open');
                    });

                    listEl.appendChild(lineEl);
                    totalLines++;
                });
            });
        });

        if (totalLines === 0) {
            const empty = document.createElement('div');
            empty.className = 'aprendPicker-empty';
            empty.textContent = filter
                ? 'Nenhum resultado encontrado'
                : 'Nenhuma anotação em Aprendizados ainda';
            listEl.appendChild(empty);
        }
    }

    async _addAprendLineToHoje(category, itemId, lineText) {
        try {
            const dateStr = this.getDateString();
            const existing = await StorageManager.getItemStatus(dateStr, category, itemId);
            const existingNote = existing.note || '';
            // Evita duplicar linha
            const newNote = existingNote
                ? (existingNote.includes(lineText) ? existingNote : existingNote + '\n' + lineText)
                : lineText;
            await StorageManager.saveItemStatus(dateStr, category, itemId, existing.status || 'none', newNote);
            this._todayScrollTop = window.scrollY;
            this._pendingScrollRestore = true;
            this.renderTodayView();

            // Feedback visual no botão
            const btn = document.getElementById('btnAprend');
            if (btn) {
                const orig = btn.innerHTML;
                btn.innerHTML = '✓ Adicionado!';
                btn.style.color = '#22c55e';
                btn.style.borderColor = '#22c55e';
                setTimeout(() => {
                    btn.innerHTML = orig;
                    btn.style.color = '';
                    btn.style.borderColor = '';
                }, 1800);
            }
        } catch(err) {
            console.error('Erro ao adicionar linha ao Hoje:', err);
        }
    }

    // ─── Dropdown de aprendizados por item ──────────────────────────────
    _closeAllItemAprendDropdowns() {
        document.querySelectorAll('.item-aprend-dropdown').forEach(d => {
            if (d.parentElement === document.body) {
                d.remove();
            }
        });
        document.querySelectorAll('.btn-aprend-item.active').forEach(b => b.classList.remove('active'));
    }

    _navigateToAprend(category, itemId) {
        if (typeof Aprendizados !== 'undefined') {
            Aprendizados.openItem(category, itemId);
        }
        this.showView('aprendizados');
    }

    async _toggleItemAprendDropdown(btn, category, itemId, noteEditable) {
        // Se já há um dropdown aberto para este botão, fechar
        const existing = document.querySelector(`.item-aprend-dropdown[data-item-id="${itemId}"][data-category="${category}"]`);
        if (existing) {
            this._closeAllItemAprendDropdowns();
            return;
        }

        // Fechar qualquer outro dropdown aberto
        this._closeAllItemAprendDropdowns();

        // Construir dropdown
        const dropdown = document.createElement('div');
        dropdown.className = 'item-aprend-dropdown';
        dropdown.dataset.itemId = itemId;
        dropdown.dataset.category = category;
        dropdown._noteEditable = noteEditable; // referência para refresh
        dropdown._anchorBtn = btn;             // referência para reposicionar no refresh

        // Preencher conteúdo
        await this._fillAprendDropdown(dropdown, category, itemId, noteEditable);

        // Portal: mover para body com position fixed
        dropdown.style.position = 'fixed';
        dropdown.style.top = '-9999px';
        dropdown.style.left = '-9999px';
        document.body.appendChild(dropdown);
        btn.classList.add('active');

        // Posicionar após render
        requestAnimationFrame(() => this._positionAprendDropdown(dropdown, btn));

        // Fechar ao clicar fora; scroll DENTRO do dropdown é permitido
        const closeHandler = (ev) => {
            if (!dropdown.contains(ev.target) && ev.target !== btn) {
                this._closeAllItemAprendDropdowns();
                document.removeEventListener('click', closeHandler, true);
                window.removeEventListener('scroll', scrollClose, true);
            }
        };
        const scrollClose = (ev) => {
            const path = ev.composedPath ? ev.composedPath() : [ev.target];
            if (path.includes(dropdown)) return;
            this._closeAllItemAprendDropdowns();
            document.removeEventListener('click', closeHandler, true);
            window.removeEventListener('scroll', scrollClose, true);
        };
        setTimeout(() => {
            document.addEventListener('click', closeHandler, true);
            window.addEventListener('scroll', scrollClose, true);
        }, 0);
    }

    _positionAprendDropdown(dropdown, btn) {
        const btnRect = btn.getBoundingClientRect();
        const dropRect = dropdown.getBoundingClientRect();
        const spaceBelow = window.innerHeight - btnRect.bottom;
        const spaceAbove = btnRect.top;
        if (spaceBelow < dropRect.height + 8 && spaceAbove > dropRect.height) {
            dropdown.style.top = `${btnRect.top - dropRect.height - 6}px`;
        } else {
            dropdown.style.top = `${btnRect.bottom + 4}px`;
        }
        const left = Math.min(btnRect.right - dropRect.width, window.innerWidth - dropRect.width - 8);
        dropdown.style.left = `${Math.max(8, left)}px`;
    }

    // Preenche (ou re-preenche) o conteúdo de um dropdown já existente
    async _fillAprendDropdown(dropdown, category, itemId, noteEditable) {
        // Guardar grupos abertos antes de limpar
        const openGroups = new Set();
        dropdown.querySelectorAll('.item-aprend-note-group.open').forEach(g => {
            const label = g.querySelector('.aprend-note-label')?.textContent;
            if (label) openGroups.add(label);
        });

        dropdown.innerHTML = '';

        // Ler todas as notas do item
        let aprendData = {};
        try { aprendData = JSON.parse(localStorage.getItem('aprendizadosData') || '{}'); } catch {}

        const rawItem = aprendData[category]?.[itemId];
        let notes = [];
        if (rawItem) {
            if (Array.isArray(rawItem.notes) && rawItem.notes.length > 0) {
                // Filtrar tombstones (deleted: true) — igual ao que Aprendizados.getItemNotes() faz
                notes = rawItem.notes.filter(n => !n.deleted);
            } else if (typeof rawItem.content !== 'undefined') {
                notes = [{
                    id: '__legacy__',
                    title: '',
                    content: rawItem.content || '',
                    checkedLines: rawItem.checkedLines || {},
                }];
            }
        }

        // Ler nota atual do item no hoje
        const dateStr = this.getDateString();
        let currentNoteText = '';
        try {
            const cur = await StorageManager.getItemStatus(dateStr, category, itemId);
            currentNoteText = cur.note || '';
        } catch {}
        const todayLines = new Set(
            currentNoteText.split('\n').map(l => l.trim()).filter(Boolean)
        );

        const totalLines = notes.reduce((acc, n) =>
            acc + (n.content || '').split('\n').filter(l => l.trim()).length, 0);

        if (totalLines === 0) {
            dropdown.innerHTML = `<div class="item-aprend-empty">Nenhuma anotação em Aprendizados para este item</div>`;
            const footerEmpty = document.createElement('div');
            footerEmpty.className = 'item-aprend-footer';
            footerEmpty.innerHTML = '<button class="item-aprend-goto-btn">📝 Criar nota</button>';
            footerEmpty.querySelector('.item-aprend-goto-btn').addEventListener('mousedown', (ev) => {
                ev.preventDefault(); ev.stopPropagation();
                this._closeAllItemAprendDropdowns();
                this._navigateToAprend(category, itemId);
            });
            dropdown.appendChild(footerEmpty);
        } else {
            notes.forEach((note, noteIdx) => {
                const noteLines = (note.content || '').split('\n').filter(l => l.trim() !== '');
                if (noteLines.length === 0) return;

                const groupEl = document.createElement('div');
                const label = note.title || (notes.length > 1 ? `Nota ${noteIdx + 1}` : 'Nota');
                groupEl.className = 'item-aprend-note-group' + (openGroups.has(label) ? ' open' : '');

                const headerEl = document.createElement('div');
                headerEl.className = 'item-aprend-note-header collapsible';
                headerEl.innerHTML = `<span class="aprend-note-label">${label}</span><span class="aprend-note-chevron">▶</span>`;

                const linesEl = document.createElement('div');
                linesEl.className = 'item-aprend-note-lines';

                headerEl.addEventListener('mousedown', (ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    groupEl.classList.toggle('open');
                });

                noteLines.forEach((lineText, lineIdx) => {
                    const allLines = (note.content || '').split('\n');
                    let realIdx = 0, nonEmptyCount = 0;
                    for (let i = 0; i < allLines.length; i++) {
                        if (allLines[i].trim() !== '') {
                            if (nonEmptyCount === lineIdx) { realIdx = i; break; }
                            nonEmptyCount++;
                        }
                    }

                    const inNote = todayLines.has(lineText.trim());
                    const isChecked = !!(note.checkedLines && note.checkedLines[realIdx]) || inNote;

                    const lineEl = document.createElement('div');
                    lineEl.className = 'item-aprend-line' + (isChecked ? ' done' : '');
                    lineEl.innerHTML = `
                        <svg class="item-aprend-icon${isChecked ? ' done' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                            ${isChecked
                                ? '<polyline points="20 6 9 17 4 12"></polyline>'
                                : '<circle cx="12" cy="12" r="9"></circle>'
                            }
                        </svg>
                        <span></span>
                    `;
                    lineEl.querySelector('span').textContent = lineText;
                    lineEl.addEventListener('mousedown', async (ev) => {
                        ev.preventDefault();
                        ev.stopPropagation();

                        // noteEditable pode ser null quando o dropdown foi aberto
                        // num contexto sem campo de nota visível (ex: refresh remoto)
                        if (noteEditable) {
                            const currentText = noteEditable.innerText.trim();
                            noteEditable.innerText = currentText
                                ? (currentText.includes(lineText) ? currentText : currentText + '\n' + lineText)
                                : lineText;
                        }

                        const noteText = noteEditable ? noteEditable.innerText.trim() : lineText;
                        const existingData = await StorageManager.getItemStatus(dateStr, category, itemId);
                        await StorageManager.saveItemStatus(dateStr, category, itemId, existingData.status || 'none', noteText);

                        if (typeof Aprendizados !== 'undefined' && Aprendizados.setLineChecked) {
                            Aprendizados.setLineChecked(category, itemId, realIdx, true, note.id);
                        }

                        lineEl.classList.add('done');
                        lineEl.querySelector('.item-aprend-icon')?.classList.add('done');
                        lineEl.querySelector('.item-aprend-icon').innerHTML = '<polyline points="20 6 9 17 4 12"></polyline>';

                        setTimeout(() => this._closeAllItemAprendDropdowns(), 350);
                        this._todayScrollTop = window.scrollY;
                        this._pendingScrollRestore = true;
                        this.renderTodayView();
                    });
                    linesEl.appendChild(lineEl);
                });

                groupEl.appendChild(headerEl);
                groupEl.appendChild(linesEl);
                dropdown.appendChild(groupEl);
            });

            const footerNotes = document.createElement('div');
            footerNotes.className = 'item-aprend-footer';
            footerNotes.innerHTML = '<button class="item-aprend-goto-btn">📚 Ver todas as notas</button>';
            footerNotes.querySelector('.item-aprend-goto-btn').addEventListener('mousedown', (ev) => {
                ev.preventDefault(); ev.stopPropagation();
                this._closeAllItemAprendDropdowns();
                this._navigateToAprend(category, itemId);
            });
            dropdown.appendChild(footerNotes);
        }
    }

    // API pública: chamada por aprendizados.js após salvar/deletar nota
    // Usa debounce para evitar re-renders em cascata durante digitação rápida
    refreshItemAprendDropdown(category, itemId) {
        if (!this._aprendRefreshTimers) this._aprendRefreshTimers = {};
        const key = `${category}__${itemId}`;
        clearTimeout(this._aprendRefreshTimers[key]);
        this._aprendRefreshTimers[key] = setTimeout(async () => {
            const dropdown = document.querySelector(`.item-aprend-dropdown[data-item-id="${itemId}"][data-category="${category}"]`);
            if (!dropdown) return;
            const noteEditable = dropdown._noteEditable || null;
            const btn = dropdown._anchorBtn
                     || document.querySelector(`.btn-aprend-item[data-item-id="${itemId}"][data-category="${category}"]`)
                     || document.querySelector(`[data-category="${category}"][data-item-id="${itemId}"] .btn-aprend-item`);
            await this._fillAprendDropdown(dropdown, category, itemId, noteEditable);
            requestAnimationFrame(() => {
                if (btn) this._positionAprendDropdown(dropdown, btn);
            });
        }, 80);
    }

    async showView(view, opts = {}) {
        // Salvar nota de aprendizado se estava nessa aba
        if (this.currentView === 'aprendizados' && typeof Aprendizados !== 'undefined') {
            Aprendizados.onHide();
        }

        // Salvar posição de scroll antes de sair
        const mainContent = document.getElementById('mainContent');
        if (this.currentView === 'today') {
            this._todayScrollTop = window.scrollY;
        } else if (this.currentView === 'history') {
            this._historyScrollTop = window.scrollY;
        } else if (this.currentView === 'reports') {
            this._reportsScrollTop = window.scrollY;
        }

        this.currentView = view;

        // Browser history — push a new state so the back button works between tabs
        if (!opts.fromPopState) {
            history.pushState({ view }, '', '#' + view);
        }

        document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
        
        // Update active button state
        document.querySelectorAll('.btn-nav-header').forEach(btn => btn.classList.remove('active'));

        // Ajuste de largura: histórico usa largura total, outras abas ficam no max-width padrão
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
            // Scroll será restaurado após o render (via _pendingHistoryScrollRestore)
            this._pendingHistoryScrollRestore = true;
            // Inicializa a data do histórico no dia de hoje
            if (!this.historyDate) {
                this.historyDate = new Date();
                this.historyDate.setHours(12, 0, 0, 0);
            }
            this._updateHistoryDateLabel();
            await this.renderHistoryAsSpreadsheet(this.getDateString(this.historyDate));
            // Re-mede após o filtro estar visível (necessário no iOS PWA para calcular --history-filter-h)
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
                // Inicializar na primeira visita
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
        }
    }

    changeDate(days) {
        this._todayScrollTop = window.scrollY; // preservar posição ao trocar de dia
        this._pendingScrollRestore = true;
        this.currentDate.setDate(this.currentDate.getDate() + days);
        this.renderTodayView();
    }

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
    }

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
    }

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
                    <button class="settings-delete-btn" title="Remover demanda">✕</button>
                `;

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
    }

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
    }

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
    }

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
    }

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
    }

    /** Chamado quando o usuário muda o rótulo de uma categoria */
    _onCategoryLabelChange(cat, newLabel) {
        if (typeof newLabel !== 'string') return;
        newLabel = newLabel.slice(0, 50); // máx 50 chars
        const s = StorageManager.getSettings();
        if (!s.categoryLabels) s.categoryLabels = {};
        s.categoryLabels[cat] = newLabel;
        StorageManager.saveSettings(s);
        this._applySettingsCategoryLabels(s);
    }

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
    }

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
    }

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
    }

    _reRenderHistory() {
        if (!this.historyDate) {
            this.historyDate = new Date();
            this.historyDate.setHours(12, 0, 0, 0);
        }
        this.renderHistoryAsSpreadsheet(this.getDateString(this.historyDate));
    }

    _updateHistoryDateLabel() {
        const el = document.getElementById('historyCurrentDate');
        if (!el) return;
        if (this._historyDateRange) {
            el.textContent = this._historyDateRange.label || 'Semana';
        } else if (this.historyDate) {
            el.textContent = this.formatDate(this.historyDate);
        }
    }

    // ─── Barra Semanal ────────────────────────────────────────────────────────
    // Retorna a segunda-feira da semana que contém `date`
    getWeekMonday(date) {
        const d = new Date(date);
        const dow = d.getDay(); // 0=Dom, 1=Seg, ..., 6=Sab
        const diff = (dow === 0) ? -6 : 1 - dow;
        d.setDate(d.getDate() + diff);
        d.setHours(0, 0, 0, 0);
        return d;
    }

    // Constrói e retorna o elemento .item-week-bar para um item
    // Carrega os status dos 7 dias da semana atual (Seg→Dom) de forma assíncrona
    async renderItemWeekBar(category, itemId, refDate) {
        const labels      = ['S', 'T', 'Q', 'Q', 'S', 'S', 'D'];
        const monday      = this.getWeekMonday(refDate);
        const todayStr    = this.getDateString(new Date());
        const viewingStr  = this.getDateString(refDate);  // dia visualizado no date-selector

        const bar = document.createElement('div');
        bar.className = 'item-week-bar';
        bar.dataset.category = category;
        bar.dataset.itemId   = itemId;

        // Buscar status dos 7 dias em paralelo
        const days = Array.from({ length: 7 }, (_, i) => {
            const d = new Date(monday);
            d.setDate(monday.getDate() + i);
            return d;
        });

        const statuses = await Promise.all(
            days.map(d => StorageManager.getItemStatus(this.getDateString(d), category, itemId))
        );

        days.forEach((d, i) => {
            const dateStr   = this.getDateString(d);
            const status    = statuses[i].status || 'none';
            const note      = statuses[i].note || '';
            const isToday   = dateStr === todayStr;
            const isViewing = dateStr === viewingStr;

            let cls = 'week-bar-day';
            if (isToday)   cls += ' is-today';
            if (isViewing) cls += ' is-viewing';

            const dayEl = document.createElement('div');
            dayEl.className = cls;
            dayEl.dataset.dateStr = dateStr;
            dayEl.dataset.status  = status;

            const labelEl = document.createElement('div');
            labelEl.className = 'week-bar-label';
            labelEl.textContent = labels[i];

            const daynumEl = document.createElement('div');
            daynumEl.className = 'week-bar-daynum';
            daynumEl.textContent = d.getDate();

            const block = document.createElement('div');
            block.className = 'week-bar-block';
            block.dataset.status = status;
            block.dataset.date = dateStr;
            block.dataset.category = category;
            block.dataset.itemId = itemId;
            if (isToday) block.dataset.isToday = '1';
            if (note.trim()) block.dataset.note = note;

            dayEl.appendChild(labelEl);
            dayEl.appendChild(daynumEl);
            dayEl.appendChild(block);

            // Seta: laranja para dia visualizado, azul para hoje real (só se diferente)
            if (isViewing || isToday) {
                const arrow = document.createElement('div');
                arrow.className = 'week-bar-arrow' + (isViewing ? ' week-bar-arrow--viewing' : '');
                arrow.textContent = '▲';
                dayEl.appendChild(arrow);
            }

            // O clique é tratado por delegação no container (renderCategoryItems)
            bar.appendChild(dayEl);
        });

        return bar;
    }

    _showWeekDayPicker(dayEl, blockEl, dateStr, category, itemId, item) {
        // Fechar tooltip de nota se estiver aberto
        this._hideWeekBarTooltip(true);
        // Fechar qualquer picker anterior
        document.querySelectorAll('.wday-picker').forEach(p => p.remove());

        const STATUS_OPTIONS = [
            { key: 'none',         label: 'Nenhum',       color: 'rgba(107,114,128,0.5)' },
            { key: 'concluido',    label: 'Concluído',    color: '#22c55e' },
            { key: 'em-andamento', label: 'Em andamento', color: '#eab308' },
            { key: 'parcialmente', label: 'Parcialmente', color: '#f97316' },
            { key: 'nao-feito',    label: 'Não feito',    color: '#ef4444' },
            { key: 'bloqueado',    label: 'Bloqueado',    color: 'rgba(239,68,68,0.6)' },
            { key: 'aguardando',   label: 'Aguardando',   color: '#95d3ee' },
            { key: 'prioridade',   label: 'Prioridade',   color: '#a855f7' },
            { key: 'pular',        label: 'Pular',        color: 'rgba(107,114,128,0.4)' },
        ];

        const current = dayEl.dataset.status || 'none';
        const d = new Date(dateStr + 'T12:00:00');
        const months = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
        const weekdays = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
        const label = `${weekdays[d.getDay()]} ${d.getDate()} ${months[d.getMonth()]}`;

        const picker = document.createElement('div');
        picker.className = 'wday-picker';

        const header = document.createElement('div');
        header.className = 'wday-picker-header';
        header.textContent = label;
        picker.appendChild(header);

        STATUS_OPTIONS.forEach(opt => {
            const row = document.createElement('div');
            row.className = 'wday-picker-option' + (opt.key === current ? ' active' : '');

            const dot = document.createElement('span');
            dot.className = 'wday-picker-dot';
            dot.style.background = opt.color;

            row.appendChild(dot);
            row.appendChild(document.createTextNode(opt.label));

            row.addEventListener('click', async (e) => {
                e.stopPropagation();
                picker.remove();

                const existing = await StorageManager.getItemStatus(dateStr, category, itemId);
                await StorageManager.saveItemStatus(dateStr, category, itemId, opt.key, existing.note || '');

                // Propagar status para itens vinculados
                await this._propagateStatusToLinks(dateStr, category, itemId, opt.key);

                // Atualizar bloco visual
                dayEl.dataset.status = opt.key;
                blockEl.dataset.status = opt.key;

                const todayStr = this.getDateString(new Date());
                if (opt.key === 'concluido' && dateStr === todayStr) {
                    this.showAprendizadoPopup(category, itemId, item?.name || itemId)
                        .then(() => {
                            this._todayScrollTop = window.scrollY;
                            this._pendingScrollRestore = true;
                            this.renderTodayView();
                        });
                }
                if (opt.key === 'bloqueado' && dateStr === todayStr) {
                    this.showBloqueadoPopup(category, itemId)
                        .then(() => {
                            this._todayScrollTop = window.scrollY;
                            this._pendingScrollRestore = true;
                            this.renderTodayView();
                        });
                }
                if (opt.key === 'parcialmente' && dateStr === todayStr) {
                    this.showParcialmentePopup(category, itemId)
                        .then(() => {
                            this._todayScrollTop = window.scrollY;
                            this._pendingScrollRestore = true;
                            this.renderTodayView();
                        });
                }
                if (dateStr === todayStr) {
                    this._todayScrollTop = window.scrollY;
                    this._pendingScrollRestore = true;
                    this.renderTodayView();
                }
            });

            picker.appendChild(row);
        });

        document.body.appendChild(picker);

        // Posicionar surgindo a partir do bloco
        const rect = blockEl.getBoundingClientRect();
        const pickerW = 162;

        // Centralizar horizontalmente no bloco, surgir abaixo
        let left = rect.left + rect.width / 2 - pickerW / 2;
        let top  = rect.bottom + 6;

        // Bounds
        if (left < 6) left = 6;
        if (left + pickerW > window.innerWidth - 6) left = window.innerWidth - pickerW - 6;
        if (top + 280 > window.innerHeight - 6) top = rect.top - 280 - 4;

        picker.style.left  = `${left}px`;
        picker.style.top   = `${top}px`;
        picker.style.width = `${pickerW}px`;
        // Origem da animação: centro do bloco
        picker.style.transformOrigin = `${rect.left + rect.width/2 - left}px top`;

        // Fechar ao clicar fora
        const close = (e) => {
            if (!picker.contains(e.target)) {
                picker.classList.add('wday-picker-out');
                picker.addEventListener('animationend', () => picker.remove(), { once: true });
                document.removeEventListener('click', close, true);
            }
        };
        setTimeout(() => document.addEventListener('click', close, true), 10);
    }

    // ── Note Image Paste (Ctrl/Cmd+V com imagem) ──────────────────────────
    _initNoteImagePaste() {
        if (this._noteImagePasteInited) return;
        this._noteImagePasteInited = true;

        // Interceptar Ctrl/Cmd+V em qualquer .item-note-editable
        document.addEventListener('paste', async (ev) => {
            const target = ev.target;
            if (!target.closest('.item-note-editable')) return;

            const items = ev.clipboardData?.items;
            if (!items) return;

            // Verificar se tem imagem no clipboard
            let imageFile = null;
            for (const item of items) {
                if (item.type.startsWith('image/')) {
                    imageFile = item.getAsFile();
                    break;
                }
            }
            if (!imageFile) return;

            // Impedir o comportamento padrão (colagem de imagem inline no contentEditable)
            ev.preventDefault();
            ev.stopPropagation();

            const noteEditable = target.closest('.item-note-editable');
            const itemEl       = noteEditable.closest('.item');
            if (!itemEl) return;
            const category = itemEl.dataset.category;
            const itemId   = itemEl.dataset.itemId;
            if (!category || !itemId) return;

            // Mostrar indicador de upload
            const uploadIndicator = document.createElement('div');
            uploadIndicator.className = 'note-img-upload-indicator';
            uploadIndicator.textContent = '📷 Enviando imagem…';
            noteEditable.insertAdjacentElement('afterend', uploadIndicator);

            try {
                const url = await StorageManager.uploadNoteImage(imageFile);
                uploadIndicator.remove();

                if (!url) {
                    // Fallback: usar base64 local se upload falhar
                    const reader = new FileReader();
                    reader.onload = (e) => {
                        const b64url = e.target.result;
                        this._insertImageInNote(noteEditable, itemEl, category, itemId, b64url);
                    };
                    reader.readAsDataURL(imageFile);
                    return;
                }

                this._insertImageInNote(noteEditable, itemEl, category, itemId, url);
            } catch (err) {
                uploadIndicator.remove();
                console.error('Erro ao colar imagem:', err);
            }
        }, true);

        // ── Hover preview nas miniaturas dentro de .item-note ────────────
        this._imgPreviewTimer = null;
        this._activeImgPreview = null;

        document.addEventListener('mouseenter', (ev) => {
            const wrap = ev.target.closest('.note-img-wrap');
            if (!wrap) return;
            const thumb = wrap.querySelector('.note-img-thumb');
            if (!thumb) return;
            clearTimeout(this._imgPreviewTimer);
            this._imgPreviewTimer = setTimeout(() => {
                this._showNoteImgPreview(thumb);
            }, 500);
        }, true);

        document.addEventListener('mouseleave', (ev) => {
            const wrap = ev.target.closest('.note-img-wrap');
            if (!wrap) return;
            clearTimeout(this._imgPreviewTimer);
            // Não fechar se mouse foi para o preview
        }, true);

        document.addEventListener('mouseenter', (ev) => {
            if (ev.target.closest('.note-img-preview')) {
                clearTimeout(this._imgPreviewTimer);
            }
        }, true);

        document.addEventListener('mouseleave', (ev) => {
            if (ev.target.closest('.note-img-preview')) {
                this._hideNoteImgPreview();
            }
        }, true);
    }

    _insertImageInNote(noteEditable, itemEl, category, itemId, url) {
        // Pegar texto atual e adicionar marcador de imagem no final
        const currentText = this._getEditableText(noteEditable);
        const imgMarker   = `[img:${url}]`;
        const newText     = currentText ? `${currentText}\n${imgMarker}` : imgMarker;

        // Atualizar conteúdo do editable mostrando as imagens renderizadas
        this._textToEditable(noteEditable, newText);

        // Salvar e depois sair do modo edição para que _updateNoteDisplay
        // renderize o .item-note com a miniatura visível
        this.saveInlineNote(itemEl, category, itemId, newText).then(() => {
            // Breve timeout para garantir que _updateNoteDisplay já atualizou o DOM
            setTimeout(() => {
                this.exitCurrentEditMode(false); // false = já salvou acima
            }, 50);
        });
    }

    _showNoteImgPreview(thumb) {
        this._hideNoteImgPreview(true);

        const src = thumb.dataset.src || thumb.src;
        if (!src) return;

        const preview = document.createElement('div');
        preview.className = 'note-img-preview';

        const img = document.createElement('img');
        img.src = src;
        img.alt = 'Pré-visualização';
        preview.appendChild(img);

        document.body.appendChild(preview);
        this._activeImgPreview = preview;

        // Posicionar ao lado da miniatura
        const rect   = thumb.getBoundingClientRect();
        const margin = 8;

        // Tentar posicionar à direita; se não couber, à esquerda
        const previewW = 480;
        const previewH = 400;
        let left = rect.right + margin;
        let top  = rect.top;

        if (left + previewW > window.innerWidth - margin) {
            left = rect.left - previewW - margin;
        }
        if (left < margin) left = margin;
        if (top + previewH > window.innerHeight - margin) {
            top = window.innerHeight - previewH - margin;
        }
        if (top < margin) top = margin;

        preview.style.left = `${left}px`;
        preview.style.top  = `${top}px`;
    }

    _hideNoteImgPreview(immediate = false) {
        const prev = this._activeImgPreview;
        if (!prev) return;
        this._activeImgPreview = null;
        clearTimeout(this._imgPreviewTimer);

        if (immediate) {
            prev.remove();
            return;
        }
        prev.classList.add('note-img-preview--closing');
        prev.addEventListener('animationend', () => prev.remove(), { once: true });
        setTimeout(() => { if (prev.parentNode) prev.remove(); }, 200);
    }

    // ── Weekbar Note Tooltip ──────────────────────────────────────────────
    _initWeekBarTooltips() {
        if (this._weekbarTooltipInited) return;
        this._weekbarTooltipInited = true;

        // State
        this._activeTooltip = null;
        this._tooltipHideTimer = null;
        this._tooltipHoverTimer = null;  // delay antes de mostrar tooltip no desktop
        this._longPressTimer = null;
        this._tooltipSaveTimer = null;

        const isMobile = () => window.matchMedia('(max-width: 768px)').matches || ('ontouchstart' in window);

        // Selector: qualquer bloco que NÃO seja hoje
        const getBlock = (el) => {
            const block = el.closest('.week-bar-block');
            if (!block || block.dataset.isToday === '1') return null;
            return block;
        };

        // ── Desktop: hover ──────────────────────────────────────────
        // Helper: não fechar tooltip se textarea estiver com foco
        const shouldKeepOpen = () => {
            if (!this._activeTooltip) return false;
            const ta = this._activeTooltip.querySelector('.weekbar-tooltip-textarea');
            return ta && ta === document.activeElement;
        };

        document.addEventListener('mouseenter', (ev) => {
            if (isMobile()) return;
            const block = getBlock(ev.target);
            if (!block) return;
            clearTimeout(this._tooltipHideTimer);
            // Se já temos tooltip aberto para outro bloco E textarea focada, não trocar
            if (this._activeTooltipBlock && this._activeTooltipBlock !== block && shouldKeepOpen()) return;
            // Delay de 0.5s para não atrapalhar scroll entre demandas
            clearTimeout(this._tooltipHoverTimer);
            this._tooltipHoverTimer = setTimeout(() => {
                this._showWeekBarTooltip(block);
            }, 500);
        }, true);

        document.addEventListener('mouseleave', (ev) => {
            if (isMobile()) return;
            const block = getBlock(ev.target);
            if (!block) return;
            // Cancelar o delay de abertura se mouse saiu antes dos 2.5s
            clearTimeout(this._tooltipHoverTimer);
            // Não fechar se textarea estiver com foco (usuário editando)
            if (shouldKeepOpen()) return;
            // Delay to allow mouse to enter the tooltip
            this._tooltipHideTimer = setTimeout(() => {
                if (!shouldKeepOpen()) this._hideWeekBarTooltip();
            }, 300);
        }, true);

        // Keep tooltip alive when mouse enters it
        document.addEventListener('mouseenter', (ev) => {
            if (isMobile()) return;
            if (ev.target.closest('.weekbar-tooltip')) {
                clearTimeout(this._tooltipHideTimer);
            }
        }, true);

        document.addEventListener('mouseleave', (ev) => {
            if (isMobile()) return;
            if (ev.target.closest('.weekbar-tooltip')) {
                if (shouldKeepOpen()) return;
                this._tooltipHideTimer = setTimeout(() => {
                    if (!shouldKeepOpen()) this._hideWeekBarTooltip();
                }, 300);
            }
        }, true);

        // ── Mobile: long-press ──────────────────────────────────────
        let _longPressBlock = null;
        document.addEventListener('touchstart', (ev) => {
            const block = getBlock(ev.target);
            if (!block) return;
            _longPressBlock = block;
            this._longPressTimer = setTimeout(() => {
                this._showWeekBarTooltip(block, true);
                _longPressBlock = null; // consumed — don't let click fire picker
            }, 400);
        }, { passive: true });

        document.addEventListener('touchend', (ev) => {
            clearTimeout(this._longPressTimer);
            // If long-press tooltip is open, prevent click-through to picker
            if (this._activeTooltip && !_longPressBlock) {
                // tooltip was just shown by long-press, swallow the touchend
            }
            _longPressBlock = null;
        }, true);

        document.addEventListener('touchmove', () => {
            clearTimeout(this._longPressTimer);
            _longPressBlock = null;
        }, true);
    }

    _showWeekBarTooltip(block, isMobile = false) {
        // Remove existing tooltip
        this._hideWeekBarTooltip(true);

        const note      = (block.dataset.note || '').trim();
        const dateStr   = block.dataset.date;
        const category  = block.dataset.category;
        const itemId    = block.dataset.itemId;
        if (!dateStr || !category || !itemId) return;

        // Determinar se é passado ou futuro (tooltip não aparece para hoje)
        const todayStr  = this.getDateString(new Date());
        const isFuture  = dateStr > todayStr;
        const isPast    = dateStr < todayStr;

        // Se não tem nota E é passado, não abre tooltip vazio (só futuro abre vazio)
        // EDIT: abrir para ambos – passado e futuro – para permitir anotações retroativas
        // (se quiser bloquear passado vazio, descomentar a linha abaixo)
        // if (!note && isPast) return;

        const tooltip = document.createElement('div');
        tooltip.className = 'weekbar-tooltip weekbar-tooltip--editable';

        // Header: data formatada
        const d = new Date(dateStr + 'T12:00:00');
        const weekdays = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
        const months = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
        const dateLabel = `${weekdays[d.getDay()]} ${d.getDate()} ${months[d.getMonth()]}`;

        const headerEl = document.createElement('div');
        headerEl.className = 'weekbar-tooltip-header';
        headerEl.textContent = dateLabel;
        tooltip.appendChild(headerEl);

        // Close button
        const closeBtn = document.createElement('button');
        closeBtn.className = 'weekbar-tooltip-close';
        closeBtn.textContent = '✕';
        closeBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            this._hideWeekBarTooltip();
        });
        tooltip.appendChild(closeBtn);

        // Textarea editável
        const textarea = document.createElement('textarea');
        textarea.className = 'weekbar-tooltip-textarea';
        textarea.value = note;
        textarea.placeholder = isFuture
            ? 'Escreva demanda futura…'
            : 'Adicionar anotação…';
        textarea.rows = 3;
        tooltip.appendChild(textarea);

        // Indicador de salvamento
        const saveIndicator = document.createElement('div');
        saveIndicator.className = 'weekbar-tooltip-save-indicator';
        tooltip.appendChild(saveIndicator);

        // Declarar saveTimer aqui para ser acessível pelo botão nextDay e pelo autoSave
        let saveTimer = null;
        const nextDayBtn = document.createElement('button');
        nextDayBtn.className = 'weekbar-tooltip-next-day';
        nextDayBtn.title = 'Passar para próximo dia';
        nextDayBtn.textContent = '⏭';
        nextDayBtn.addEventListener('click', async (ev) => {
            ev.stopPropagation();

            // Calcular próximo dia a partir de dateStr (não de "hoje")
            const [y, m, d] = dateStr.split('-').map(Number);
            const nextDate    = new Date(y, m - 1, d + 1);
            const nextDateStr = this.getDateString(nextDate);

            // Salvar nota atual antes de avançar (se houver texto pendente)
            clearTimeout(saveTimer);
            const currentNote = textarea.value.trim();
            if (currentNote !== (block.dataset.note || '').trim()) {
                const existing = await StorageManager.getItemStatus(dateStr, category, itemId);
                await StorageManager.saveItemStatus(
                    dateStr, category, itemId,
                    existing.status || 'none',
                    currentNote,
                    existing.links || null
                );
                block.dataset.note = currentNote;
            }

            // Ler nota/status do próximo dia
            const nextData   = await StorageManager.getItemStatus(nextDateStr, category, itemId);
            const nextNote   = (nextData.note || '').trim();
            const nextStatus = nextData.status || 'none';

            // Apenas copiar a nota para o próximo dia — se já tiver nota, preserva
            const mergedNote = nextNote ? nextNote : currentNote;

            await StorageManager.saveItemStatus(nextDateStr, category, itemId, nextStatus, mergedNote);

            // Feedback visual no botão
            nextDayBtn.textContent = '✅ Copiado!';
            nextDayBtn.disabled = true;

            // Fechar tooltip e re-renderizar view ativa
            setTimeout(() => {
                this._hideWeekBarTooltip(true);
                if (this.currentView === 'today' || this.currentView === 'history') {
                    this._todayScrollTop = window.scrollY;
                    this._pendingScrollRestore = true;
                    this.renderTodayView();
                }
            }, 700);
        });
        tooltip.appendChild(nextDayBtn);

        const autoSave = async () => {
            const newNote = textarea.value.trim();
            saveIndicator.textContent = 'salvando…';
            saveIndicator.classList.add('visible');

            // Atualizar data-note no bloco
            if (newNote) {
                block.dataset.note = newNote;
            } else {
                delete block.dataset.note;
            }

            // Salvar via StorageManager (preserva status e links)
            const existing = await StorageManager.getItemStatus(dateStr, category, itemId);
            await StorageManager.saveItemStatus(
                dateStr, category, itemId,
                existing.status || 'none',
                newNote,
                existing.links || null
            );

            saveIndicator.textContent = '✓ salvo';
            setTimeout(() => {
                saveIndicator.classList.remove('visible');
            }, 1200);
        };

        textarea.addEventListener('input', () => {
            clearTimeout(saveTimer);
            saveTimer = setTimeout(autoSave, 600);
        });

        // Salvar ao perder foco também
        textarea.addEventListener('blur', () => {
            clearTimeout(saveTimer);
            const newNote = textarea.value.trim();
            const oldNote = (block.dataset.note || '').trim();
            if (newNote !== oldNote || (newNote && !block.dataset.note)) {
                autoSave();
            }
        });

        // Impedir que clique no textarea feche tooltip ou propague
        textarea.addEventListener('click', (ev) => ev.stopPropagation());
        textarea.addEventListener('mousedown', (ev) => ev.stopPropagation());

        document.body.appendChild(tooltip);
        this._activeTooltip = tooltip;
        this._activeTooltipBlock = block;

        // Position above the block
        const blockRect = block.getBoundingClientRect();
        const tipRect   = tooltip.getBoundingClientRect();

        let left = blockRect.left + blockRect.width / 2 - tipRect.width / 2;
        let top  = blockRect.top - tipRect.height - 8;

        // Keep within viewport
        const margin = 8;
        if (left < margin) left = margin;
        if (left + tipRect.width > window.innerWidth - margin) {
            left = window.innerWidth - margin - tipRect.width;
        }
        // If no room above, place below
        if (top < margin) {
            top = blockRect.bottom + 8;
            tooltip.classList.add('weekbar-tooltip--below');
        }

        tooltip.style.left = `${left}px`;
        tooltip.style.top  = `${top}px`;

        // Adjust arrow position to point at the block
        const arrowLeft = blockRect.left + blockRect.width / 2 - left;
        tooltip.style.setProperty('--arrow-left', `${arrowLeft}px`);

        // Auto-focus textarea (desktop: delay pequeno; mobile: não focar para evitar teclado indesejado)
        if (!isMobile) {
            setTimeout(() => {
                textarea.focus();
                textarea.setSelectionRange(textarea.value.length, textarea.value.length);
            }, 80);

            // Desktop: fechar ao clicar fora do tooltip
            const closeDesktop = (e) => {
                if (!tooltip.contains(e.target) && !block.contains(e.target)) {
                    // Salvar se mudou antes de fechar
                    const newNote = textarea.value.trim();
                    if (newNote !== note) autoSave();
                    this._hideWeekBarTooltip();
                    document.removeEventListener('mousedown', closeDesktop, true);
                }
            };
            setTimeout(() => document.addEventListener('mousedown', closeDesktop, true), 100);
            // Guardar ref para remover no hide
            tooltip._desktopCloseHandler = closeDesktop;
        }

        // On mobile, close when tapping outside
        if (isMobile) {
            const closeMobile = (e) => {
                if (!tooltip.contains(e.target)) {
                    // Salvar se mudou antes de fechar
                    const newNote = textarea.value.trim();
                    if (newNote !== note) autoSave();
                    setTimeout(() => {
                        this._hideWeekBarTooltip();
                        document.removeEventListener('touchstart', closeMobile, true);
                    }, 50);
                }
            };
            setTimeout(() => document.addEventListener('touchstart', closeMobile, true), 50);
        }
    }

    _hideWeekBarTooltip(immediate = false) {
        const tip = this._activeTooltip;
        if (!tip) return;
        this._activeTooltip = null;
        this._activeTooltipBlock = null;
        clearTimeout(this._tooltipSaveTimer);
        clearTimeout(this._tooltipHoverTimer);

        // Remover handler de click-outside (desktop)
        if (tip._desktopCloseHandler) {
            document.removeEventListener('mousedown', tip._desktopCloseHandler, true);
        }

        if (immediate) {
            tip.remove();
            return;
        }
        tip.classList.add('weekbar-tooltip--closing');
        tip.addEventListener('animationend', () => tip.remove(), { once: true });
        // Fallback removal
        setTimeout(() => { if (tip.parentNode) tip.remove(); }, 200);
    }

    // ── Item Link / Vincular ──────────────────────────────────────────────
    async _showLinkPicker(btn, category, itemId, itemEl) {
        // Fechar qualquer picker anterior
        document.querySelectorAll('.link-picker-overlay').forEach(p => p.remove());

        const dateStr = this.getDateString();
        const currentData = await StorageManager.getItemStatus(dateStr, category, itemId);
        const currentLinks = currentData.links || [];

        // Coletar todos os itens de todas as categorias
        const groups = [
            { key: 'clientes',   label: '👥 Clientes',  items: APP_DATA.clientes },
            { key: 'categorias', label: '🏢 Empresa',   items: APP_DATA.categorias },
            { key: 'atividades', label: '👤 Pessoal',   items: APP_DATA.atividades }
        ];

        // Overlay
        const overlay = document.createElement('div');
        overlay.className = 'link-picker-overlay';

        const popup = document.createElement('div');
        popup.className = 'link-picker-popup';

        // Header
        const header = document.createElement('div');
        header.className = 'link-picker-header';
        header.innerHTML = `<span>🔗 Vincular item</span><button class="link-picker-close">✕</button>`;
        popup.appendChild(header);

        // Bloco fixo: mostra o item de origem (nome + nota) para referência
        const sourceItem = (APP_DATA[category] || []).find(i => i.id === itemId);
        const sourceName = sourceItem ? sourceItem.name : itemId;
        const sourceNote = (currentData.note || '').trim();
        const sourceBlock = document.createElement('div');
        sourceBlock.className = 'link-picker-source';
        sourceBlock.innerHTML = `<div class="link-picker-source-name">${this._escapeHtml(sourceName)}</div>`
            + (sourceNote ? `<div class="link-picker-source-note">${this._escapeHtml(sourceNote)}</div>` : '');
        popup.appendChild(sourceBlock);

        // List
        const listWrap = document.createElement('div');
        listWrap.className = 'link-picker-list';

        for (const group of groups) {
            const groupEl = document.createElement('div');
            groupEl.className = 'link-picker-group-label';
            groupEl.textContent = group.label;
            listWrap.appendChild(groupEl);

            for (const it of group.items) {
                // Não mostrar o próprio item
                if (group.key === category && it.id === itemId) continue;

                const isLinked = currentLinks.some(l => l.category === group.key && l.itemId === it.id);

                // Buscar status do item para hoje (mostrar nota/demanda)
                const itData = await StorageManager.getItemStatus(dateStr, group.key, it.id);
                const noteText = (itData.note || '').trim();

                const row = document.createElement('label');
                row.className = 'link-picker-row';

                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.className = 'link-picker-cb';
                cb.checked = isLinked;
                cb.dataset.cat = group.key;
                cb.dataset.itemId = it.id;

                const infoWrap = document.createElement('div');
                infoWrap.className = 'link-picker-info';

                const nameSpan = document.createElement('span');
                nameSpan.className = 'link-picker-name';
                nameSpan.textContent = it.name;
                infoWrap.appendChild(nameSpan);

                if (noteText) {
                    const notePreview = document.createElement('span');
                    notePreview.className = 'link-picker-note-preview';
                    notePreview.textContent = noteText;
                    infoWrap.appendChild(notePreview);
                }

                row.appendChild(cb);
                row.appendChild(infoWrap);
                listWrap.appendChild(row);
            }
        }

        popup.appendChild(listWrap);

        // Actions
        const actions = document.createElement('div');
        actions.className = 'link-picker-actions';
        const btnOk = document.createElement('button');
        btnOk.className = 'link-picker-btn-ok';
        btnOk.textContent = 'OK';
        const btnCancel = document.createElement('button');
        btnCancel.className = 'link-picker-btn-cancel';
        btnCancel.textContent = 'Cancelar';
        actions.appendChild(btnCancel);
        actions.appendChild(btnOk);
        popup.appendChild(actions);

        overlay.appendChild(popup);
        document.body.appendChild(overlay);

        // Focus trap
        requestAnimationFrame(() => popup.focus());

        const close = () => {
            overlay.classList.add('link-picker-closing');
            overlay.addEventListener('animationend', () => overlay.remove(), { once: true });
            setTimeout(() => { if (overlay.parentNode) overlay.remove(); }, 300);
        };

        // Close handlers
        header.querySelector('.link-picker-close').addEventListener('click', close);
        btnCancel.addEventListener('click', close);
        overlay.addEventListener('click', (ev) => {
            if (ev.target === overlay) close();
        });

        // OK handler — salva os links bidirecionais
        btnOk.addEventListener('click', async () => {
            const checkboxes = listWrap.querySelectorAll('.link-picker-cb');
            const newLinks = [];
            checkboxes.forEach(cb => {
                if (cb.checked) {
                    newLinks.push({ category: cb.dataset.cat, itemId: cb.dataset.itemId });
                }
            });

            // Salvar links do item atual
            await StorageManager.saveItemStatus(dateStr, category, itemId, currentData.status || 'none', currentData.note || '', newLinks);

            // Para cada item selecionado, garantir que o link reverso existe
            for (const lnk of newLinks) {
                const targetData = await StorageManager.getItemStatus(dateStr, lnk.category, lnk.itemId);
                const targetLinks = targetData.links || [];
                const alreadyLinked = targetLinks.some(l => l.category === category && l.itemId === itemId);
                if (!alreadyLinked) {
                    targetLinks.push({ category, itemId });
                    await StorageManager.saveItemStatus(dateStr, lnk.category, lnk.itemId, targetData.status || 'none', targetData.note || '', targetLinks);
                }
            }

            // Remover links reversos dos itens que foram desmarcados
            const removedLinks = currentLinks.filter(old => !newLinks.some(n => n.category === old.category && n.itemId === old.itemId));
            for (const lnk of removedLinks) {
                const targetData = await StorageManager.getItemStatus(dateStr, lnk.category, lnk.itemId);
                const targetLinks = (targetData.links || []).filter(l => !(l.category === category && l.itemId === itemId));
                await StorageManager.saveItemStatus(dateStr, lnk.category, lnk.itemId, targetData.status || 'none', targetData.note || '', targetLinks);
            }

            close();
            this._todayScrollTop = window.scrollY;
            this._pendingScrollRestore = true;
            this.renderTodayView();
        });
    }

    async _removeLink(sourceCat, sourceId, targetCat, targetId) {
        const dateStr = this.getDateString();

        // Remover do item fonte
        const sourceData = await StorageManager.getItemStatus(dateStr, sourceCat, sourceId);
        const sourceLinks = (sourceData.links || []).filter(l => !(l.category === targetCat && l.itemId === targetId));
        await StorageManager.saveItemStatus(dateStr, sourceCat, sourceId, sourceData.status || 'none', sourceData.note || '', sourceLinks);

        // Remover link reverso do item alvo
        const targetData = await StorageManager.getItemStatus(dateStr, targetCat, targetId);
        const targetLinks = (targetData.links || []).filter(l => !(l.category === sourceCat && l.itemId === sourceId));
        await StorageManager.saveItemStatus(dateStr, targetCat, targetId, targetData.status || 'none', targetData.note || '', targetLinks);

        this._todayScrollTop = window.scrollY;
        this._pendingScrollRestore = true;
        this.renderTodayView();
    }

    // Propaga mudança de status para todos os itens vinculados
    async _propagateStatusToLinks(dateStr, category, itemId, newStatus) {
        const data = await StorageManager.getItemStatus(dateStr, category, itemId);
        const links = data.links || [];
        if (links.length === 0) return;

        for (const lnk of links) {
            const targetData = await StorageManager.getItemStatus(dateStr, lnk.category, lnk.itemId);
            // Só propagar se o status é diferente
            if (targetData.status !== newStatus) {
                await StorageManager.saveItemStatus(dateStr, lnk.category, lnk.itemId, newStatus, targetData.note || '');
            }
        }
    }
    // ─── Fim Barra Semanal ────────────────────────────────────────────────────

    getDateString(date = this.currentDate) {
        // Usa data LOCAL (não UTC) para evitar bug de virada de dia em fusos horários como Brasil (UTC-3)
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

    renderTodayView() {
        // Clear any existing edit mode when re-rendering
        this.exitCurrentEditMode(true);
        // Fechar dropdown de aprendizados por item se aberto
        this._closeAllItemAprendDropdowns();
        // Fechar popup de resumo semanal se aberto
        this._closeWeekSummaryPopup();
        
        // Clean up old event listeners
        if (this._statusClickHandlers) {
            this._statusClickHandlers.forEach(handler => {
                document.removeEventListener('click', handler);
            });
            this._statusClickHandlers = [];
        }
        
        if (this._statusEscapeHandlers) {
            this._statusEscapeHandlers.forEach(handler => {
                document.removeEventListener('keydown', handler);
            });
            this._statusEscapeHandlers = [];
        }

        if (this._statusScrollHandlers) {
            this._statusScrollHandlers.forEach(handler => {
                window.removeEventListener('scroll', handler, true);
            });
            this._statusScrollHandlers = [];
        }
        
        document.getElementById('currentDate').textContent = this.formatDate(this.currentDate);
        const dateStr = this.getDateString();

        // Render each category (now async)
        Promise.all([
            this.renderCategoryItems('clientes', 'clientesList', APP_DATA.clientes, dateStr),
            this.renderCategoryItems('categorias', 'categoriasList', APP_DATA.categorias, dateStr),
            this.renderCategoryItems('atividades', 'atividadesList', APP_DATA.atividades, dateStr)
        ]).then(() => {
            this._applyTodayFilter();
            // Re-sincroniza alturas após render completo (importante para iOS PWA)
            requestAnimationFrame(() => {
                this._syncHeaderHeight();
                // Navegar até item vindo do histórico
                if (this._pendingHighlightItemId) {
                    const itemId   = this._pendingHighlightItemId;
                    const category = this._pendingHighlightCategory;
                    this._pendingHighlightItemId   = null;
                    this._pendingHighlightCategory = null;
                    const el = document.querySelector(`.item[data-item-id="${itemId}"][data-category="${category}"]`);
                    if (el) {
                        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        el.classList.add('item-highlight-pulse');
                        el.addEventListener('animationend', () => el.classList.remove('item-highlight-pulse'), { once: true });
                    }
                    return; // não restaurar scroll antigo
                }
                // Restaurar scroll da aba Hoje após DOM totalmente montado
                if (this._pendingScrollRestore) {
                    this._pendingScrollRestore = false;
                    window.scrollTo({ top: this._todayScrollTop || 0, behavior: 'instant' });
                }
            });
        });
    }

    _applyTodayFilter() {
        const filter = this._activeTodayFilter || 'all';
        const query  = (this._todaySearchQuery || '').toLowerCase().trim();

        document.querySelectorAll('#todayView .item').forEach(itemEl => {
            // Filtro de status
            let statusOk;
            if (filter === 'all') {
                statusOk = true;
            } else if (filter === 'sem-nota') {
                // Tem nota se: .item-note existe OU .item-note-editable tem texto
                const noteDisplay  = itemEl.querySelector('.item-note');
                const noteEditable = itemEl.querySelector('.item-note-editable');
                const hasNote = !!(noteDisplay) || !!(noteEditable && noteEditable.innerText.trim());
                statusOk = !hasNote;
            } else {
                statusOk = itemEl.classList.contains('status-' + filter);
            }

            let searchOk = true;
            if (query) {
                const nameEl = itemEl.querySelector('.item-name');
                // Usar data-original-name para sempre comparar contra o nome limpo
                if (nameEl && !nameEl.dataset.originalName) {
                    nameEl.dataset.originalName = nameEl.textContent;
                }
                const originalName = nameEl?.dataset.originalName || nameEl?.textContent || '';
                searchOk = originalName.toLowerCase().includes(query);

                // Highlight no nome
                if (nameEl) {
                    if (searchOk) {
                        const idx = originalName.toLowerCase().indexOf(query);
                        if (idx >= 0) {
                            nameEl.innerHTML = this._escapeHtml(originalName.slice(0, idx))
                                + '<mark class="tsf-highlight">' + this._escapeHtml(originalName.slice(idx, idx + query.length)) + '</mark>'
                                + this._escapeHtml(originalName.slice(idx + query.length));
                        }
                    } else {
                        nameEl.textContent = originalName;
                    }
                }
            } else {
                // Limpar highlight
                const nameEl = itemEl.querySelector('.item-name');
                if (nameEl?.querySelector('.tsf-highlight')) {
                    nameEl.textContent = nameEl.textContent;
                }
            }

            itemEl.style.display = (statusOk && searchOk) ? '' : 'none';
        });

        // Ocultar categorias sem itens visíveis
        const filtering = filter !== 'all' || query;
        document.querySelectorAll('#todayView .category').forEach(cat => {
            const visible = [...cat.querySelectorAll('.item')].filter(el => el.style.display !== 'none');
            cat.style.display = (visible.length === 0 && filtering) ? 'none' : '';
        });
    }

    async renderCategoryItems(category, containerId, items, dateStr) {
        const container = document.getElementById(containerId);
        container.innerHTML = '';

        // Interceptar cliques na barra semanal em capture, antes de qualquer handler dos items
        // Usar uma única delegação no container para garantir prioridade
        if (!container._weekBarHandlerAttached) {
            container._weekBarHandlerAttached = true;
            container.addEventListener('click', (ev) => {
                const dayEl = ev.target.closest('.week-bar-day');
                if (!dayEl) return;
                ev.stopImmediatePropagation();
                ev.preventDefault();
                const bar = dayEl.closest('.item-week-bar');
                if (!bar) return;
                const cat  = bar.dataset.category;
                const iid  = bar.dataset.itemId;
                const dstr = dayEl.dataset.dateStr;
                const block = dayEl.querySelector('.week-bar-block');
                // Encontrar o item nos dados
                const itemObj = (APP_DATA[cat] || []).find(i => i.id === iid);
                this._showWeekDayPicker(dayEl, block || dayEl, dstr, cat, iid, itemObj);
            }, true); // capture: true — roda antes de qualquer handler filho
        }

        for (const item of items) {
            const itemData = await StorageManager.getItemStatus(dateStr, category, item.id);
            const statusConfig = STATUS_CONFIG[itemData.status];
            
            const itemEl = document.createElement('div');
            itemEl.className = 'item';
            itemEl.dataset.category = category;
            itemEl.dataset.itemId   = item.id;
            // add status class to paint the whole item according to status
            const initialStatus = itemData.status || 'none';
            itemEl.classList.add(`status-${initialStatus}`);
            
            let noteHtml = '';
            if (itemData.note && itemData.note.trim()) {
                const noteWithLinks = this._buildNoteHtml(itemData.note);
                noteHtml = `<div class="item-note" data-item-id="${item.id}" data-category="${category}">${noteWithLinks}<button class="btn-note-delete" data-item-id="${item.id}" data-category="${category}" title="Apagar nota">✖</button></div>`;
            }

            // Build link tags HTML
            let linkTagsHtml = '';
            if (itemData.links && itemData.links.length > 0) {
                const tagItems = itemData.links.map(lnk => {
                    const linkedItem = (APP_DATA[lnk.category] || []).find(i => i.id === lnk.itemId);
                    const name = linkedItem ? linkedItem.name : lnk.itemId;
                    return `<span class="item-link-tag" data-link-cat="${lnk.category}" data-link-id="${lnk.itemId}" title="Vinculado a ${this._escapeHtml(name)}">🔗 ${this._escapeHtml(name)}<button class="item-link-tag-remove" data-link-cat="${lnk.category}" data-link-id="${lnk.itemId}">✕</button></span>`;
                }).join('');
                linkTagsHtml = `<div class="item-link-tags" data-item-id="${item.id}" data-category="${category}">${tagItems}</div>`;
            }

            // Build header with mic button (custom status dropdown will be inserted programmatically)
            const hasNoteInitially = !!(itemData.note && itemData.note.trim());
            const hasLinksInitially = !!(itemData.links && itemData.links.length > 0);

            // Verificar se o item tem notas de aprendizados
            let hasAprendNotes = false;
            try {
                const aprendData = JSON.parse(localStorage.getItem('aprendizadosData') || '{}');
                const itemAprendEntry = aprendData[category]?.[item.id];
                const aprendNotes = Array.isArray(itemAprendEntry?.notes) ? itemAprendEntry.notes : [];
                hasAprendNotes = aprendNotes.some(n => n.content && n.content.trim().length > 0)
                    || !!(itemAprendEntry?.content && itemAprendEntry.content.trim());
            } catch {}

            const headerHtml = `
                <div class="item-header">
                    <span class="item-name" tabindex="0">${this._escapeHtml(item.name)}</span>
                    <div style="display:flex;gap:0.5rem;align-items:center;">
                        <button class="btn-google-search" title="Pesquisar nota no Google" aria-label="Pesquisar no Google" style="display:${hasNoteInitially ? 'inline-flex' : 'none'};align-items:center;justify-content:center;padding:2px 4px;background:none;border:none;cursor:pointer;border-radius:4px;opacity:0.75;" tabindex="-1"><img src="https://www.google.com/favicon.ico" alt="Google" width="14" height="14" style="display:block;pointer-events:none;"></button>
                        <button class="btn-week-summary" title="Resumo semanal" aria-label="Resumo semanal" data-category="${category}" data-item-id="${item.id}" data-item-name="${this._escapeHtmlAttr(item.name)}">📋</button>
                        <button class="btn-link-item${hasLinksInitially ? ' has-links' : ''}" title="Vincular a outro item" aria-label="Vincular item">🔗</button>
                        <button class="btn-next-day" title="Passar para próximo dia" aria-label="Próximo dia">⏭</button>
                        <button class="btn-aprend-item${hasAprendNotes ? ' has-notes' : ''}" title="Inserir nota de Aprendizados" aria-label="Aprendizados">📚</button>
                    </div>
                </div>
            `;

            itemEl.innerHTML = headerHtml + `${linkTagsHtml}${noteHtml}`;

            // Inline note editor (editable directly) - one click to type
            const noteText = itemData.note || '';
            const noteEditable = document.createElement('div');
            noteEditable.className = 'item-note-editable';
            noteEditable.contentEditable = true;
            noteEditable.spellcheck = true;
            this._textToEditable(noteEditable, noteText);
            // Insert editable note (after header)
            const headerEl = itemEl.querySelector('.item-header');
            headerEl.insertAdjacentElement('afterend', noteEditable);

            // If there's already a displayed note (noteHtml), hide editable until user focuses to edit
            if (noteText && noteText.trim()) {
                noteEditable.style.display = 'none';
            } else {
                // show editable when there's no note yet
                noteEditable.style.display = 'block';
            }

            // Clicking the item name focuses the editable note (quick typing)
            const nameEl = itemEl.querySelector('.item-name');
            const handleEditMode = () => {
                // Force immediate switch using the centralized method
                this.forceEditMode(itemEl, noteEditable, category, item.id);
            };

            // Rastrear se houve drag (seleção de texto) entre mousedown e click
            let _mouseDownX = 0, _mouseDownY = 0, _hasDragged = false;
            itemEl.addEventListener('mousedown', (ev) => {
                _mouseDownX = ev.clientX;
                _mouseDownY = ev.clientY;
                _hasDragged = false;
            }, true);
            itemEl.addEventListener('mousemove', (ev) => {
                if (Math.abs(ev.clientX - _mouseDownX) > 4 || Math.abs(ev.clientY - _mouseDownY) > 4) {
                    _hasDragged = true;
                }
            }, true);

            // Universal click handler for edit mode - works for any click that should trigger editing
            const handleItemClick = (ev) => {
                const clickedElement = ev.target;

                // Skip if clicked on interactive elements that shouldn't trigger edit mode
                if (clickedElement.closest('.btn-mic') || 
                    clickedElement.closest('.custom-status') ||
                    clickedElement.closest('.btn-note-delete') ||
                    clickedElement.closest('.btn-aprend-item') ||
                    clickedElement.closest('.btn-next-day') ||
                    clickedElement.closest('.btn-google-search') ||
                    clickedElement.closest('.btn-link-item') ||
                    clickedElement.closest('.btn-week-summary') ||
                    clickedElement.closest('.week-summary-popup') ||
                    clickedElement.closest('.item-aprend-dropdown') ||
                    clickedElement.closest('.item-week-bar') ||
                    clickedElement.closest('.note-img-remove') ||
                    clickedElement.closest('.note-img-thumb') ||
                    clickedElement.closest('.note-img-wrap')) {
                    return;
                }

                // Se clicou num link dentro da nota exibida: deixar o navegador abrir normalmente
                if (clickedElement.closest('a') && clickedElement.closest('.item-note')) {
                    return;
                }

                // Se o usuário estava arrastando (selecionando texto), não entrar em modo edição
                if (_hasDragged) {
                    _hasDragged = false;
                    return;
                }

                // Se o clique foi dentro do noteEditable já visível, deixar o browser gerenciar
                if (clickedElement.closest('.item-note-editable') &&
                    noteEditable.style.display !== 'none') {
                    return;
                }

                // Always enter edit mode, regardless of current state
                ev.preventDefault();
                ev.stopPropagation();
                handleEditMode();
            };

            // Add click handlers based on status - use capturing to ensure we get the event first
            if (initialStatus === 'none') {
                // For items with no status, any click should enter edit mode
                itemEl.addEventListener('click', handleItemClick, true); // Use capturing phase
            } else {
                // For items with status, only specific areas trigger edit mode
                nameEl.addEventListener('click', handleItemClick, true); // Use capturing phase
                
                // Also clicking on existing note enters edit mode
                const displayedNote = itemEl.querySelector('.item-note');
                if (displayedNote) {
                    displayedNote.addEventListener('click', handleItemClick, true); // Use capturing phase
                }
            }

            nameEl.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter' || ev.key === ' ') {
                    ev.preventDefault();
                    handleEditMode();
                }
            });

            // Save on blur — captura o texto no momento do blur, sem depender de estado externo
            noteEditable.addEventListener('blur', () => {
                const text = this._getEditableText(noteEditable);
                // Salva sempre que perder o foco (o lock por item evita duplicatas)
                this.saveInlineNote(itemEl, category, item.id, text);
            });
            
            noteEditable.addEventListener('keydown', (ev) => {
                if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
                    ev.preventDefault();
                    this.exitCurrentEditMode(true); // Use the centralized method
                }
                // Ctrl+A dentro do editable: seleciona tudo sem propagar para cima
                if ((ev.ctrlKey || ev.metaKey) && ev.key === 'a') {
                    ev.stopPropagation();
                    // deixa o browser selecionar normalmente
                }
            });

            // Ctrl+A na nota estática (.item-note): entrar em edição e selecionar tudo
            const displayedNoteEl = itemEl.querySelector('.item-note');
            if (displayedNoteEl) {
                displayedNoteEl.setAttribute('tabindex', '0');
                displayedNoteEl.addEventListener('keydown', (ev) => {
                    if ((ev.ctrlKey || ev.metaKey) && ev.key === 'a') {
                        ev.preventDefault();
                        handleEditMode();
                        setTimeout(() => {
                            const range = document.createRange();
                            const sel = window.getSelection();
                            range.selectNodeContents(noteEditable);
                            sel.removeAllRanges();
                            sel.addRange(range);
                        }, 20);
                    }
                });
            }

            // Custom status dropdown (button + list) to replace native select for consistent styling
            const statusContainer = document.createElement('div');
            statusContainer.className = 'custom-status';

            const statusBtn = document.createElement('button');
            statusBtn.type = 'button';
            statusBtn.className = 'custom-status-btn';
            statusBtn.setAttribute('aria-haspopup', 'listbox');

            const statusList = document.createElement('ul');
            statusList.className = 'custom-status-list hidden';
            statusList.setAttribute('role', 'listbox');

            // populate list from STATUS_CONFIG (order matters - 'none' first)
            const statusOrder = ['none', ...Object.keys(STATUS_CONFIG).filter(k => k !== 'none')];
            statusOrder.forEach(key => {
                const cfg = STATUS_CONFIG[key];
                const li = document.createElement('li');
                li.className = 'custom-status-option';
                li.setAttribute('role', 'option');
                li.dataset.value = key;
                li.innerText = cfg.label || '—';
                statusList.appendChild(li);
            });

            statusContainer.appendChild(statusBtn);
            statusContainer.appendChild(statusList);
            // insert the custom control into the header area (replace the select spot)
            const headerRight = itemEl.querySelector('.item-header > div');
            if (headerRight) headerRight.appendChild(statusContainer);

            // Ocultar o botão de status em todas as categorias (mudança feita pelo week-bar-block)
            statusBtn.style.display = 'none';

            // helper to show current selected label on button
            const setStatusUI = (statusKey) => {
                const cfg = STATUS_CONFIG[statusKey] || STATUS_CONFIG['none'];
                statusBtn.innerText = cfg.label || '—';
                // attach data-status for backward CSS compatibility
                statusBtn.dataset.status = statusKey;
                statusContainer.dataset.status = statusKey;
                // update item class
                Array.from(itemEl.classList).filter(c => c.startsWith('status-')).forEach(c => itemEl.classList.remove(c));
                itemEl.classList.add(`status-${statusKey}`);
                
                // Update selected class on options
                statusList.querySelectorAll('.custom-status-option').forEach(opt => {
                    opt.classList.toggle('selected', opt.dataset.value === statusKey);
                });
            };

            // initialize with current value
            const initialStatusKey = itemData.status || 'none';
            setStatusUI(initialStatusKey);

            // open/close logic — portal pattern: move list to body to escape overflow:hidden / stacking contexts
            const detachStatusList = () => {
                if (statusList.parentElement === document.body) {
                    statusContainer.appendChild(statusList);
                }
                statusList.classList.add('hidden');
                statusList.classList.remove('open-upward');
                statusContainer.classList.remove('is-open');
                statusList.style.position = '';
                statusList.style.top = '';
                statusList.style.bottom = '';
                statusList.style.left = '';
                statusList.style.right = '';
                statusList.style.width = '';
            };

            const closeAllStatusLists = () => {
                document.querySelectorAll('.custom-status-list').forEach(l => {
                    const parent = l.parentElement;
                    // se está no body como portal, devolver ao container original
                    if (parent === document.body) {
                        const lid = l.dataset.listId;
                        const container = lid ? document.querySelector(`.custom-status[data-list-id="${lid}"]`) : null;
                        if (container) {
                            container.appendChild(l);
                            container.classList.remove('is-open');
                        } else {
                            l.remove(); // fallback seguro
                        }
                    }
                    l.classList.add('hidden');
                    l.classList.remove('open-upward');
                    l.style.position = '';
                    l.style.top = '';
                    l.style.bottom = '';
                    l.style.left = '';
                    l.style.right = '';
                    l.style.width = '';
                });
            };

            // Atribui ID único para poder localizar o statusContainer ao fechar
            const listId = `sl-${category}-${item.id}`.replace(/[^a-z0-9-_]/gi, '_');
            statusList.dataset.listId = listId;
            statusContainer.dataset.listId = listId;

            statusBtn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                const isHidden = statusList.classList.contains('hidden');
                closeAllStatusLists();
                
                if (isHidden) {
                    // Mover para body (portal) para escapar overflow:hidden e stacking contexts
                    document.body.appendChild(statusList);
                    statusList.style.position = 'fixed';
                    // Posicionar fora da tela inicialmente para medir sem flicker
                    statusList.style.top = '-9999px';
                    statusList.style.left = '-9999px';
                    statusList.classList.remove('hidden');
                    statusContainer.classList.add('is-open');
                    
                    // Aguarda o render para usar dimensões reais
                    requestAnimationFrame(() => {
                        const btnRect = statusBtn.getBoundingClientRect();
                        const listRect = statusList.getBoundingClientRect();
                        const listWidth = Math.max(listRect.width, 220);
                        const listHeight = listRect.height;

                        const spaceBelow = window.innerHeight - btnRect.bottom;
                        const spaceAbove = btnRect.top;

                        // Posição vertical
                        if (spaceBelow < listHeight + 8 && spaceAbove > listHeight) {
                            // Abre para cima
                            statusList.classList.add('open-upward');
                            statusList.style.top = `${btnRect.top - listHeight - 6}px`;
                        } else {
                            // Abre para baixo
                            statusList.classList.remove('open-upward');
                            statusList.style.top = `${btnRect.bottom + 6}px`;
                        }

                        // Posição horizontal: alinha pela direita do botão
                        const leftPos = btnRect.right - listWidth;
                        statusList.style.left = `${Math.max(4, leftPos)}px`;
                        statusList.style.right = '';
                    });
                } else {
                    detachStatusList();
                }
            });

            // clicking an option
            statusList.addEventListener('click', async (ev) => {
                const li = ev.target.closest('.custom-status-option');
                if (!li) return;
                const newStatus = li.dataset.value || 'none';
                setStatusUI(newStatus);

                // save (sempre para o dia atual)
                const dateStr = this.getDateString();
                const existing = await StorageManager.getItemStatus(dateStr, category, item.id);
                await StorageManager.saveItemStatus(dateStr, category, item.id, newStatus, existing.note || '');

                // Propagar status para itens vinculados
                await this._propagateStatusToLinks(dateStr, category, item.id, newStatus);

                // Atualizar bloco de hoje na barra semanal
                const barEl = itemEl.querySelector('.item-week-bar');
                if (barEl) {
                    const todayStr = this.getDateString(new Date());
                    const todayDayEl = barEl.querySelector(`.week-bar-day[data-date-str="${todayStr}"]`);
                    if (todayDayEl) {
                        todayDayEl.dataset.status = newStatus;
                        const block = todayDayEl.querySelector('.week-bar-block');
                        if (block) block.dataset.status = newStatus;
                    }
                }

                detachStatusList();
                this._todayScrollTop = window.scrollY;
                this._pendingScrollRestore = true;
                this.renderTodayView();

                // Se concluído hoje: perguntar aprendizado
                if (newStatus === 'concluido') {
                    this.showAprendizadoPopup(category, item.id, item.name || item.id)
                        .then(() => {
                            this._todayScrollTop = window.scrollY;
                            this._pendingScrollRestore = true;
                            this.renderTodayView();
                        });
                }

                // Se bloqueado hoje: perguntar razão
                if (newStatus === 'bloqueado') {
                    this.showBloqueadoPopup(category, item.id)
                        .then(() => {
                            this._todayScrollTop = window.scrollY;
                            this._pendingScrollRestore = true;
                            this.renderTodayView();
                        });
                }

                // Se parcialmente hoje: perguntar o que falta
                if (newStatus === 'parcialmente') {
                    this.showParcialmentePopup(category, item.id)
                        .then(() => {
                            this._todayScrollTop = window.scrollY;
                            this._pendingScrollRestore = true;
                            this.renderTodayView();
                        });
                }
            });

            // close when clicking outside - use event delegation
            const closeOnOutsideClick = (ev) => {
                if (!statusContainer.contains(ev.target) && !statusList.contains(ev.target)) {
                    detachStatusList();
                }
            };
            
            // Close on scroll anywhere (dropdown is fixed so it would desync)
            const closeOnScroll = () => {
                if (!statusList.classList.contains('hidden')) {
                    detachStatusList();
                }
            };

            // Store reference for cleanup
            if (!this._statusClickHandlers) this._statusClickHandlers = [];
            this._statusClickHandlers.push(closeOnOutsideClick);
            document.addEventListener('click', closeOnOutsideClick);

            if (!this._statusScrollHandlers) this._statusScrollHandlers = [];
            this._statusScrollHandlers.push(closeOnScroll);
            window.addEventListener('scroll', closeOnScroll, true); // capture: true para pegar scroll de qualquer container

            // Close on ESC key
            const closeOnEscape = (ev) => {
                if (ev.key === 'Escape' && !statusList.classList.contains('hidden')) {
                    detachStatusList();
                }
            };
            
            if (!this._statusEscapeHandlers) this._statusEscapeHandlers = [];
            this._statusEscapeHandlers.push(closeOnEscape);
            document.addEventListener('keydown', closeOnEscape);

            // Mic button logic (botão removido da UI, mas lógica preservada caso seja restaurado)
            const micBtn = itemEl.querySelector('.btn-mic');
            if (micBtn) {
                micBtn.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    if (!this.recognitionSupported) {
                        alert('Transcrição por voz não suportada neste navegador. Use Chrome ou Safari (com suporte).');
                        return;
                    }

                    if (this.isRecording && this.currentRecording && this.currentRecording.itemId === item.id && this.currentRecording.category === category) {
                        this.stopRecording();
                    } else {
                        this.startRecordingFor(itemEl, category, item.id);
                    }
                });
            }

            // ── Google Search por nota do item ───────────────────────────
            const googleBtn = itemEl.querySelector('.btn-google-search');
            if (googleBtn) {
                googleBtn.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    ev.preventDefault();
                    const noteContent = (noteEditable.innerText || '').trim()
                        || itemEl.querySelector('.item-note')?.innerText?.replace(/✖$/, '').trim()
                        || '';
                    if (noteContent) {
                        window.open('https://www.google.com/search?q=' + encodeURIComponent(noteContent), '_blank');
                    }
                });
            }

            // Atualiza visibilidade do botão Google conforme conteúdo digitado
            noteEditable.addEventListener('input', () => {
                if (googleBtn) {
                    const hasText = noteEditable.innerText.trim().length > 0;
                    googleBtn.style.display = hasText ? 'inline-flex' : 'none';
                }
            });

            // ── Link / vincular a outro item ─────────────────────────────
            const linkBtn = itemEl.querySelector('.btn-link-item');
            if (linkBtn) {
                linkBtn.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    ev.preventDefault();
                    this._showLinkPicker(linkBtn, category, item.id, itemEl);
                });
            }

            // ── Remover link individual (click na tag ✕) ─────────────────
            const linkTagsContainer = itemEl.querySelector('.item-link-tags');
            if (linkTagsContainer) {
                linkTagsContainer.addEventListener('click', async (ev) => {
                    const removeBtn = ev.target.closest('.item-link-tag-remove');
                    if (!removeBtn) return;
                    ev.stopPropagation();
                    ev.preventDefault();
                    const linkCat = removeBtn.dataset.linkCat;
                    const linkId  = removeBtn.dataset.linkId;
                    await this._removeLink(category, item.id, linkCat, linkId);
                });
            }

            // ── Aprendizados picker por item ─────────────────────────────
            const aprendBtn = itemEl.querySelector('.btn-aprend-item');
            if (aprendBtn) {
                aprendBtn.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    ev.preventDefault();
                    this._toggleItemAprendDropdown(aprendBtn, category, item.id, noteEditable);
                });
            }

            // ── Passar para próximo dia ───────────────────────────────────
            const nextDayBtn = itemEl.querySelector('.btn-next-day');
            if (nextDayBtn) {
                nextDayBtn.addEventListener('click', async (ev) => {
                    ev.stopPropagation();
                    ev.preventDefault();

                    const currentDateStr = this.getDateString();

                    // Calcular próximo dia
                    const nextDate = new Date(
                        this.currentDate.getFullYear(),
                        this.currentDate.getMonth(),
                        this.currentDate.getDate() + 1
                    );
                    const nextDateStr = this.getDateString(nextDate);

                    // Ler dados do dia atual
                    const currentData = await StorageManager.getItemStatus(currentDateStr, category, item.id);
                    const currentStatus = currentData.status || 'none';
                    const currentNote = currentData.note || '';

                    // Ler dados do próximo dia (preservar se já existir)
                    const nextData = await StorageManager.getItemStatus(nextDateStr, category, item.id);
                    const nextNote = (nextData.note || '').trim();
                    const nextStatus = nextData.status || 'none';

                    // Duplicar para o próximo dia: preserva o que já existe
                    const mergedNote = nextNote ? nextNote : currentNote;
                    const mergedStatus = nextStatus !== 'none' ? nextStatus : currentStatus;
                    await StorageManager.saveItemStatus(nextDateStr, category, item.id, mergedStatus, mergedNote);

                    // Marcar dia atual como não feito
                    await StorageManager.saveItemStatus(currentDateStr, category, item.id, 'nao-feito', currentNote);

                    // Feedback e re-render
                    nextDayBtn.textContent = '✅';
                    nextDayBtn.disabled = true;
                    setTimeout(() => {
                        this._todayScrollTop = window.scrollY;
                        this._pendingScrollRestore = true;
                        this.renderTodayView();
                    }, 700);
                });
            }

            // Note delete button handler - NOW HANDLED BY GLOBAL DELEGATION
            // const deleteBtn = itemEl.querySelector('.btn-note-delete');
            // if (deleteBtn) {
            //     deleteBtn.addEventListener('click', (ev) => {
            //         ev.stopPropagation();
            //         ev.preventDefault();
            //         console.log('Delete button clicked!'); // Debug log
            //         const ok = confirm('Deseja apagar esta nota?');
            //         if (!ok) return;
            //         console.log('User confirmed deletion'); // Debug log
            //         const dateStr = this.getDateString();
            //         const existing = StorageManager.getItemStatus(dateStr, category, item.id);
            //         StorageManager.saveItemStatus(dateStr, category, item.id, existing.status || 'none', '');
            //         this.renderTodayView();
            //     });
            // }

            // ── Botão Resumo Semanal ──────────────────────────────────────
            const weekSummaryBtn = itemEl.querySelector('.btn-week-summary');
            if (weekSummaryBtn) {
                weekSummaryBtn.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    ev.preventDefault();
                    this._showWeekSummaryPopup(category, item.id, item.name);
                });
            }

            container.appendChild(itemEl);

            // Barra semanal de blocos — carrega async e appenda ao itemEl
            this.renderItemWeekBar(category, item.id, this.currentDate).then(bar => {
                itemEl.appendChild(bar);
            });
        }
    }

    // Convert URLs in text to clickable links
    linkifyText(text) {
        const urlRegex = /(https?:\/\/[^\s]+)/g;
        // Split on URLs, escape non-URL parts, wrap URLs in <a>
        return text
            .split('\n')
            .map(line => {
                const parts = line.split(urlRegex);
                return parts.map((part, i) => {
                    // Odd indices are URL capture groups
                    if (i % 2 === 1) {
                        return `<a href="${this._escapeHtml(part)}" target="_blank" rel="noopener noreferrer" class="note-link">${this._escapeHtml(part)}</a>`;
                    }
                    return this._escapeHtml(part);
                }).join('');
            })
            .join('<br>');
    }

    // Build note HTML, rendering 🧠, 🚫 and ⏳ lines as colored status tags
    // and [img:URL] markers as inline thumbnails
    _buildNoteHtml(text) {
        if (!text || !text.trim()) return '';
        const lines = text.split('\n');
        const tagParts  = [];   // tags flutuantes (🧠 🚫 ⏳) — vão primeiro no HTML
        const textParts = [];   // linhas de texto normal e imagens
        // Regex permissivo: captura tudo entre [img: e o último ] da linha
        const imgRegex  = /\[img:(.+?)\](?:\s*)$/;

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            // Imagem colada: [img:URL] — testar antes de qualquer outro parser
            const imgMatch = trimmed.match(imgRegex);
            if (imgMatch && trimmed.startsWith('[img:')) {
                const src = imgMatch[1].trim();
                // Wrapper relativo para o botão de remover
                textParts.push(
                    `<span class="note-img-wrap">` +
                    `<img class="note-img-thumb" src="${this._escapeHtml(src)}" data-src="${this._escapeHtml(src)}" alt="imagem" loading="lazy">` +
                    `<button class="note-img-remove" data-src="${this._escapeHtml(src)}" title="Remover imagem">✕</button>` +
                    `</span>`
                );
            } else if (trimmed.startsWith('🧠')) {
                const content = trimmed.slice(2).trim();
                tagParts.push(`<span class="status-note-tag status-note-tag--concluido">🧠 ${this._escapeHtml(content)}</span>`);
            } else if (trimmed.startsWith('🚫')) {
                const content = trimmed.slice(2).trim();
                tagParts.push(`<span class="status-note-tag status-note-tag--bloqueado">🚫 ${this._escapeHtml(content)}</span>`);
            } else if (trimmed.startsWith('⏳')) {
                const content = trimmed.slice(2).trim();
                tagParts.push(`<span class="status-note-tag status-note-tag--parcialmente">⏳ ${this._escapeHtml(content)}</span>`);
            } else {
                // Não transformar [img:...] em link — apenas URLs puras
                const urlRegex = /(https?:\/\/[^\s\]]+)/g;
                const parts = line.split(urlRegex);
                const linked = parts.map((part, i) => {
                    if (i % 2 === 1) {
                        return `<a href="${this._escapeHtml(part)}" target="_blank" rel="noopener noreferrer" class="note-link">${this._escapeHtml(part)}</a>`;
                    }
                    return this._escapeHtml(part);
                }).join('');
                textParts.push(linked);
            }
        }
        // Tags vêm primeiro no HTML para que o float:right funcione corretamente,
        // depois o texto normal com quebras de linha
        const tagsHtml  = tagParts.join('');
        const textHtml  = textParts.join('<br>');
        return tagsHtml + textHtml;
    }

    // Versão readonly de _buildNoteHtml — sem botão de remover imagem.
    // Usada no histórico para renderizar miniaturas sem controles de edição.
    _buildNoteHtmlReadonly(text) {
        if (!text || !text.trim()) return '';
        const lines = text.split('\n');
        const tagParts  = [];
        const textParts = [];
        const imgRegex  = /\[img:(.+?)\](?:\s*)$/;

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            const imgMatch = trimmed.match(imgRegex);
            if (imgMatch && trimmed.startsWith('[img:')) {
                const src = imgMatch[1].trim();
                textParts.push(
                    `<span class="note-img-wrap note-img-wrap--readonly">` +
                    `<img class="note-img-thumb" src="${this._escapeHtml(src)}" data-src="${this._escapeHtml(src)}" alt="imagem" loading="lazy">` +
                    `</span>`
                );
            } else if (trimmed.startsWith('🧠')) {
                const content = trimmed.slice(2).trim();
                tagParts.push(`<span class="status-note-tag status-note-tag--concluido">🧠 ${this._escapeHtml(content)}</span>`);
            } else if (trimmed.startsWith('🚫')) {
                const content = trimmed.slice(2).trim();
                tagParts.push(`<span class="status-note-tag status-note-tag--bloqueado">🚫 ${this._escapeHtml(content)}</span>`);
            } else if (trimmed.startsWith('⏳')) {
                const content = trimmed.slice(2).trim();
                tagParts.push(`<span class="status-note-tag status-note-tag--parcialmente">⏳ ${this._escapeHtml(content)}</span>`);
            } else {
                const urlRegex = /(https?:\/\/[^\s\]]+)/g;
                const parts = line.split(urlRegex);
                const linked = parts.map((part, i) => {
                    if (i % 2 === 1) {
                        return `<a href="${this._escapeHtml(part)}" target="_blank" rel="noopener noreferrer" class="note-link">${this._escapeHtml(part)}</a>`;
                    }
                    return this._escapeHtml(part);
                }).join('');
                textParts.push(linked);
            }
        }
        return tagParts.join('') + textParts.join('<br>');
    }

    _escapeHtml(str) {
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    _escapeHtmlAttr(str) {
        if (!str) return '';
        return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // ── Resumo Semanal Popup ──────────────────────────────────────────────
    // Fecha qualquer popup de resumo semanal aberto
    _closeWeekSummaryPopup() {
        const existing = document.querySelector('.week-summary-overlay');
        if (existing) existing.remove();
    }

    // Mostra popup com resumo da semana para um item (status + nota de cada dia)
    async _showWeekSummaryPopup(category, itemId, itemName) {
        // Fechar popup anterior se houver
        this._closeWeekSummaryPopup();

        const dayLabels = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];
        const monday = this.getWeekMonday(this.currentDate);
        const todayStr = this.getDateString(new Date());

        // Buscar dados dos 7 dias
        const days = Array.from({ length: 7 }, (_, i) => {
            const d = new Date(monday);
            d.setDate(monday.getDate() + i);
            return d;
        });

        const statuses = await Promise.all(
            days.map(d => StorageManager.getItemStatus(this.getDateString(d), category, itemId))
        );

        // Montar overlay
        const overlay = document.createElement('div');
        overlay.className = 'week-summary-overlay';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-label', 'Resumo semanal');

        const popup = document.createElement('div');
        popup.className = 'week-summary-popup';

        // Header do popup
        const popupHeader = document.createElement('div');
        popupHeader.className = 'week-summary-header';

        const titleEl = document.createElement('span');
        titleEl.className = 'week-summary-title';
        titleEl.textContent = itemName; // textContent auto-escapes HTML entities

        const closeBtn = document.createElement('button');
        closeBtn.className = 'week-summary-close';
        closeBtn.textContent = '✕';
        closeBtn.title = 'Fechar';
        closeBtn.setAttribute('aria-label', 'Fechar resumo semanal');

        popupHeader.appendChild(titleEl);
        popupHeader.appendChild(closeBtn);
        popup.appendChild(popupHeader);

        // Subtitle com intervalo da semana
        const weekStart = days[0];
        const weekEnd = days[6];
        const fmtDay = (d) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
        const subtitleEl = document.createElement('div');
        subtitleEl.className = 'week-summary-subtitle';
        subtitleEl.textContent = `Semana ${fmtDay(weekStart)} – ${fmtDay(weekEnd)}`;
        popup.appendChild(subtitleEl);

        // Lista de dias
        const listEl = document.createElement('div');
        listEl.className = 'week-summary-list';

        days.forEach((d, i) => {
            const dateStr = this.getDateString(d);
            const data = statuses[i];
            const status = data.status || 'none';
            const note = data.note || '';
            const cfg = STATUS_CONFIG[status] || STATUS_CONFIG['none'];
            const isToday = dateStr === todayStr;

            const row = document.createElement('div');
            row.className = 'week-summary-row' + (isToday ? ' is-today' : '');

            // Indicador de status (bolinha colorida)
            const statusDot = document.createElement('span');
            statusDot.className = 'week-summary-dot';
            statusDot.dataset.status = status;

            // Label do dia
            const dayLabel = document.createElement('span');
            dayLabel.className = 'week-summary-day';
            dayLabel.textContent = dayLabels[i];

            // Status text
            const statusText = document.createElement('span');
            statusText.className = 'week-summary-status';
            statusText.textContent = cfg.label || '—';
            statusText.dataset.status = status;

            // Nota (se houver)
            const noteEl = document.createElement('div');
            noteEl.className = 'week-summary-note';
            if (note.trim()) {
                // Sanitizar a nota: apenas texto puro, sem HTML
                noteEl.textContent = note.replace(/\[img:[^\]]*\]/g, '[imagem]');
            } else {
                noteEl.textContent = '—';
                noteEl.classList.add('empty');
            }

            // Botão copiar (só aparece se houver nota)
            const copyBtn = document.createElement('button');
            copyBtn.className = 'week-summary-copy';
            copyBtn.textContent = '📄';
            copyBtn.title = 'Copiar nota';
            copyBtn.setAttribute('aria-label', `Copiar nota de ${dayLabels[i]}`);
            if (!note.trim()) {
                copyBtn.style.visibility = 'hidden';
            }
            copyBtn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                ev.preventDefault();
                // Copiar apenas a nota pura
                const textToCopy = note.replace(/\[img:[^\]]*\]/g, '').trim();
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(textToCopy).then(() => {
                        copyBtn.textContent = '✅';
                        setTimeout(() => { copyBtn.textContent = '📄'; }, 1200);
                    }).catch(() => {
                        this._fallbackCopyText(textToCopy, copyBtn);
                    });
                } else {
                    this._fallbackCopyText(textToCopy, copyBtn);
                }
            });

            // Montar a row
            const topRow = document.createElement('div');
            topRow.className = 'week-summary-row-top';
            topRow.appendChild(statusDot);
            topRow.appendChild(dayLabel);
            topRow.appendChild(statusText);
            topRow.appendChild(copyBtn);

            row.appendChild(topRow);
            row.appendChild(noteEl);
            listEl.appendChild(row);
        });

        popup.appendChild(listEl);

        // Botão copiar tudo
        const copyAllBtn = document.createElement('button');
        copyAllBtn.className = 'week-summary-copy-all';
        copyAllBtn.textContent = '📋 Copiar tudo';
        copyAllBtn.setAttribute('aria-label', 'Copiar resumo completo da semana');
        copyAllBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            ev.preventDefault();
            // Copiar apenas as notas (sem nome, semana, dia ou status)
            const lines = days.map((d, i) => {
                const note = (statuses[i].note || '').replace(/\[img:[^\]]*\]/g, '').trim();
                return note;
            }).filter(n => n.length > 0);
            const fullText = lines.join('\n');
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(fullText).then(() => {
                    copyAllBtn.textContent = '✅ Copiado!';
                    setTimeout(() => { copyAllBtn.textContent = '📋 Copiar tudo'; }, 1500);
                }).catch(() => {
                    this._fallbackCopyText(fullText, copyAllBtn);
                });
            } else {
                this._fallbackCopyText(fullText, copyAllBtn);
            }
        });
        popup.appendChild(copyAllBtn);

        overlay.appendChild(popup);
        document.body.appendChild(overlay);

        // Fechar ao clicar no overlay (fora do popup)
        overlay.addEventListener('click', (ev) => {
            if (ev.target === overlay) {
                this._closeWeekSummaryPopup();
            }
        });

        // Fechar ao clicar no X
        closeBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            this._closeWeekSummaryPopup();
        });

        // Fechar com Escape
        const escHandler = (ev) => {
            if (ev.key === 'Escape') {
                this._closeWeekSummaryPopup();
                document.removeEventListener('keydown', escHandler);
            }
        };
        document.addEventListener('keydown', escHandler);

        // Focus trap: foco inicial no botão de fechar
        requestAnimationFrame(() => closeBtn.focus());
    }

    // Fallback para copiar texto quando Clipboard API não está disponível
    _fallbackCopyText(text, feedbackEl) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;';
        ta.setAttribute('readonly', '');
        document.body.appendChild(ta);
        ta.select();
        try {
            document.execCommand('copy');
            if (feedbackEl) {
                const original = feedbackEl.textContent;
                feedbackEl.textContent = '✅';
                setTimeout(() => { feedbackEl.textContent = original; }, 1200);
            }
        } catch (e) {
            // Silently fail
        }
        document.body.removeChild(ta);
    }

    // Extrai texto de um contentEditable preservando quebras de linha corretamente
    // Popula um contentEditable com o texto, convertendo [img:URL] em <img> visíveis.
    // As imagens recebem data-img-marker="URL" para serem reconvertidas em _getEditableText.
    _textToEditable(el, text) {
        el.innerHTML = '';
        if (!text) return;
        const imgRegex = /\[img:(.+?)\](?:\s*)$/;
        const lines = text.split('\n');
        lines.forEach((line, idx) => {
            const trimmed = line.trim();
            const imgMatch = trimmed.match(imgRegex);
            if (imgMatch && trimmed.startsWith('[img:')) {
                const src = imgMatch[1].trim();
                const img = document.createElement('img');
                img.src = src;
                img.dataset.imgMarker = src;
                img.className = 'note-img-thumb note-img-editable';
                img.alt = 'imagem';
                img.loading = 'lazy';
                el.appendChild(img);
            } else {
                // Texto normal: nó de texto
                el.appendChild(document.createTextNode(line));
            }
            // Separador entre linhas (exceto na última)
            if (idx < lines.length - 1) {
                el.appendChild(document.createElement('br'));
            }
        });
    }

    // innerText pode colapsar \n em alguns browsers/situações; esta função é robusta
    // Reconhece <img data-img-marker="URL"> e converte de volta para [img:URL]
    _getEditableText(el) {
        let text = '';
        const walk = (node) => {
            if (node.nodeType === Node.TEXT_NODE) {
                text += node.nodeValue;
            } else if (node.nodeType === Node.ELEMENT_NODE) {
                const tag = node.nodeName.toUpperCase();
                if (tag === 'IMG' && node.dataset.imgMarker) {
                    // Imagem inserida via _textToEditable ou paste — serializar de volta
                    if (text.length > 0 && !text.endsWith('\n')) text += '\n';
                    text += `[img:${node.dataset.imgMarker}]`;
                } else if (tag === 'BR') {
                    text += '\n';
                } else if (tag === 'DIV' || tag === 'P') {
                    // Bloco = nova linha, mas não adicionar \n no início
                    if (text.length > 0 && !text.endsWith('\n')) {
                        text += '\n';
                    }
                    node.childNodes.forEach(walk);
                    // Não adiciona \n após o bloco — o próximo bloco adicionará
                } else {
                    node.childNodes.forEach(walk);
                }
            }
        };
        el.childNodes.forEach(walk);
        // Normalizar: remover \n extra no final
        return text.replace(/\n+$/, '');
    }

    openModal(category, itemId, itemName, currentData) {
        this.selectedItem = { category, itemId };
        
        document.getElementById('modalTitle').textContent = itemName;
        document.getElementById('itemNote').value = currentData.note || '';
        
        // Set dropdown value
        const dropdown = document.getElementById('statusSelect');
        dropdown.value = currentData.status;
        
        document.getElementById('itemModal').classList.remove('hidden');
        
        // Focus on textarea
        setTimeout(() => {
            document.getElementById('itemNote').focus();
        }, 100);
    }

    closeModal() {
        document.getElementById('itemModal').classList.add('hidden');
        this.selectedItem = null;
    }

    async saveItem() {
        if (!this.selectedItem) return;

        const dateStr = this.getDateString();
        const note = document.getElementById('itemNote').value;
        const status = document.getElementById('statusSelect').value;
        
        await StorageManager.saveItemStatus(
            dateStr,
            this.selectedItem.category,
            this.selectedItem.itemId,
            status,
            note
        );

        this.closeModal();
        this._todayScrollTop = window.scrollY;
        this._pendingScrollRestore = true;
        this.renderTodayView();
    }

    // Inline editing functions
    startInlineEdit(itemEl, category, itemId, currentData) {
        // If an editor already exists, focus it
        if (itemEl.querySelector('.inline-editor')) {
            itemEl.querySelector('.inline-editor textarea').focus();
            return;
        }

        const noteText = currentData.note || '';
        // Hide existing note display
        const noteDisplay = itemEl.querySelector('.item-note');
        if (noteDisplay) noteDisplay.style.display = 'none';

        const editor = document.createElement('div');
        editor.className = 'inline-editor';
        editor.innerHTML = `
            <textarea class="inline-textarea" placeholder="Escreva sua nota..."></textarea>
            <div style="display:flex;gap:0.5rem;margin-top:0.5rem;">
                <button class="btn-inline-save">Salvar</button>
                <button class="btn-inline-cancel">Cancelar</button>
            </div>
        `;
        editor.querySelector('.inline-textarea').value = noteText;

        // Insert editor after header
        const header = itemEl.querySelector('.item-header');
        header.insertAdjacentElement('afterend', editor);

        const textarea = editor.querySelector('.inline-textarea');
        textarea.focus();

        // Save on blur (with small timeout to allow click on save)
        textarea.addEventListener('keydown', (ev) => {
            if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
                ev.preventDefault();
                this.saveInlineNote(itemEl, category, itemId, textarea.value);
            }
        });

        editor.querySelector('.btn-inline-save').addEventListener('click', () => {
            this.saveInlineNote(itemEl, category, itemId, textarea.value);
        });

        editor.querySelector('.btn-inline-cancel').addEventListener('click', () => {
            editor.remove();
            if (noteDisplay) noteDisplay.style.display = '';
        });
    }

    async saveInlineNote(itemEl, category, itemId, text) {
        // Lock por item — não bloqueia saves de itens diferentes
        const lockKey = `${category}::${itemId}`;
        if (!this._saveLocks) this._saveLocks = new Set();
        if (this._saveLocks.has(lockKey)) return;
        this._saveLocks.add(lockKey);
        // libera o lock após a operação (no finally)

        try {
            const dateStr = this.getDateString();
            const existing = await StorageManager.getItemStatus(dateStr, category, itemId);
            const status = existing.status || 'none';

            // Comparar preservando quebras de linha (não colapsar \n em espaço)
            const normalize = (s) => (s || '').trim();
            const oldNote = normalize(existing.note || '');
            const newNote = normalize(text || '');

            // Nada mudou — apenas garantir que a exibição está correta
            if (oldNote === newNote) {
                this._updateNoteDisplay(itemEl, category, itemId, existing.note || '');
                return;
            }

            // Salvar no localStorage + enfileirar push para Supabase
            await StorageManager.saveItemStatus(dateStr, category, itemId, status, text);
            console.log(`💾 Nota salva: [${category}] ${itemId}`);

            // Atualiza só o .item-note deste item (sem re-render total)
            this._updateNoteDisplay(itemEl, category, itemId, text);

        } catch (err) {
            console.error('❌ Erro ao salvar nota:', err);
        } finally {
            this._saveLocks.delete(lockKey);
        }
    }

    // Atualiza visualmente o .item-note de um item sem re-renderizar a página
    _updateNoteDisplay(itemEl, category, itemId, text) {
        const noteEditable = itemEl.querySelector('.item-note-editable');
        let noteDisplay = itemEl.querySelector('.item-note');

        if (!text || !text.trim()) {
            // Sem nota: esconder display, mostrar editable vazio
            if (noteDisplay) noteDisplay.style.display = 'none';
            if (noteEditable) {
                noteEditable.style.display = 'block';
            }
            return;
        }

        // Com nota: atualizar/criar o display e esconder o editable
        const noteWithLinks = this._buildNoteHtml(text);
        const newInner = `${noteWithLinks}<button class="btn-note-delete" data-item-id="${itemId}" data-category="${category}" title="Apagar nota">✖</button>`;

        // Sincronizar o editable com o texto salvo (preserva imagens para próxima edição)
        if (noteEditable && noteEditable.style.display === 'none') {
            this._textToEditable(noteEditable, text);
        }

        if (noteDisplay) {
            noteDisplay.innerHTML = newInner;
            noteDisplay.style.display = '';
        } else {
            noteDisplay = document.createElement('div');
            noteDisplay.className = 'item-note';
            noteDisplay.dataset.itemId = itemId;
            noteDisplay.dataset.category = category;
            noteDisplay.innerHTML = newInner;
            // Inserir após o noteEditable (ou após o header)
            if (noteEditable) {
                noteEditable.insertAdjacentElement('afterend', noteDisplay);
            } else {
                const header = itemEl.querySelector('.item-header');
                header?.insertAdjacentElement('afterend', noteDisplay);
            }
        }

        if (noteEditable) noteEditable.style.display = 'none';

        // Atualizar ícone do Google Search
        const googleBtn = itemEl.querySelector('.btn-google-search');
        if (googleBtn) googleBtn.style.display = 'inline-flex';
    }

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
    }

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
    }

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
    }

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
    }

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
    }

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
    }
    
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
    }
    
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
    }
    
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
    }

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
                        <h3>Comparativo por Grupo</h3>
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
    }

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
    }

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
    }

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
    }

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
    }

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
    }

    /** Computes stats for a single item from pre-loaded rangeData */
    _getItemStatsFromRangeData(itemId, category, rangeData, startDate, endDate, period) {
        const stats = { concluido: 0, andamento: 0, aguardando: 0, bloqueado: 0, naoFeito: 0, total: 0, history: [] };
        const scoreMap = { 'concluido': 1, 'concluido-ongoing': 1, 'parcialmente': 0.7, 'em-andamento': 0.5, 'aguardando': 0.3, 'bloqueado': 0, 'nao-feito': 0, 'prioridade': 0 };

        if (period === 'week') {
            // Mesma lógica do performanceChart: 7 dias fixos Seg→Dom da semana atual
            // Dias futuros = null no sparkline, não contam no total
            // O denominador da % são TODOS os dias passados da semana (com ou sem registro)
            const monday = this.getWeekMonday(new Date());
            const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);
            let diasPassados = 0; // denominador real: dias passados da semana

            for (let i = 0; i < 7; i++) {
                const d = new Date(monday);
                d.setDate(monday.getDate() + i);
                if (d > todayEnd) {
                    // Dia futuro — não conta
                    stats.history.push(null);
                    continue;
                }
                diasPassados++;
                const ds = this.getDateString(d);
                const itemData = rangeData[ds]?.[category]?.[itemId];
                const s = itemData
                    ? (typeof itemData === 'string' ? itemData : (itemData.status || 'none'))
                    : 'none';

                // Sparkline: score do dia (null se sem registro)
                const sc = scoreMap[s];
                stats.history.push(sc !== undefined ? sc : null);

                // Contagens (pular não entra no total, mas dias sem registro contam como denominador)
                if (s === 'pular') continue;
                if (s === 'none') continue; // sem registro: entra no denominador mas não em nenhum bucket
                stats.total++; // dias COM registro (exceto pular)
                if (s === 'concluido' || s === 'concluido-ongoing') stats.concluido++;
                else if (s === 'em-andamento' || s === 'parcialmente') stats.andamento++;
                else if (s === 'aguardando') stats.aguardando++;
                else if (s === 'bloqueado') stats.bloqueado++;
                else if (s === 'nao-feito') stats.naoFeito++;
            }
            // Usa dias passados da semana como denominador da %
            // Assim 1 concluído em 3 dias passados = 33%, não 100%
            stats._weekDaysElapsed = diasPassados;
        } else {
            // Mês/Ano/Geral: lógica existente por rangeData
            const dayMs = 86400000;
            const totalDays = Math.round((endDate - startDate) / dayMs) + 1;
            const useWeekly = totalDays > 60;

            if (useWeekly) {
                // Agrega por semana para modo ano/geral
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
                // Sparkline diário para mês
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

            // Contagem de totais por rangeData (mês/ano/geral)
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

        // Para week: denominador = dias passados da semana (não apenas dias com registro)
        const rateDenominator = stats._weekDaysElapsed ?? stats.total;
        stats.rate = rateDenominator > 0 ? Math.round(stats.concluido / rateDenominator * 100) : 0;
        return stats;
    }

    /** Returns badge label for a status */
    _getStatusBadgeLabel(status) {
        const m = { 'concluido': '✅ Concluído', 'concluido-ongoing': '✅ Contínuo', 'em-andamento': '🟡 Andamento', 'aguardando': '🔵 Aguardando', 'bloqueado': '🚫 Bloqueado', 'nao-feito': '❌ Não Feito', 'parcialmente': '🟠 Parcial', 'pular': '⏭️ Pulado', 'prioridade': '⚫ Prio', 'none': '— Sem status' };
        return m[status] || '— Sem status';
    }

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
                    // Mostrar todo o mês atual como range
                    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
                    monthStart.setHours(0, 0, 0, 0);
                    const monthEnd = new Date(today);
                    monthEnd.setHours(23, 59, 59, 999);
                    const fmt = d => `${String(d.getDate()).padStart(2,'0')}/${d.getMonth()+1}`;
                    const label = `${fmt(monthStart)}–${fmt(monthEnd)}`;
                    this._navigateToHistoryWithFilter(histFilter, '', today, { start: monthStart, end: monthEnd, label });
                } else if (period === 'year' || period === 'all') {
                    // Mostrar todo o ano atual como range
                    const yearStart = new Date(today.getFullYear(), 0, 1);
                    yearStart.setHours(0, 0, 0, 0);
                    const yearEnd = new Date(today);
                    yearEnd.setHours(23, 59, 59, 999);
                    const label = `Jan–${today.toLocaleString('pt-BR',{month:'short'})} ${today.getFullYear()}`;
                    this._navigateToHistoryWithFilter(histFilter, '', today, { start: yearStart, end: yearEnd, label });
                } else {
                    // Semana → navega para o dia de hoje (visualização normal)
                    this._navigateToHistoryWithFilter(histFilter, '', today);
                }
            });
        });

        this._sqDocListener = e => { if (!e.target.closest('.status-square')) hide(); };
        document.addEventListener('click', this._sqDocListener);
    }

    /** Sets up collapsible demand category sections and card click-to-history */
    _setupDemandSectionToggle() {
        // Restore previously open sections
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
                    // Semana atual: segunda → domingo (igual ao performanceChart)
                    const weekStart = this.getWeekMonday(new Date());
                    weekStart.setHours(0, 0, 0, 0);
                    const weekEnd = new Date(weekStart);
                    weekEnd.setDate(weekStart.getDate() + 6);
                    weekEnd.setHours(23, 59, 59, 999);
                    const fmt = d => `${d.getDate()}/${d.getMonth() + 1}`;
                    const rangeLabel = `${itemName} · ${fmt(weekStart)}–${fmt(weekEnd)}`;
                    this._navigateToHistoryWithFilter('all', itemName, today, { start: weekStart, end: weekEnd, label: rangeLabel });
                } else if (period === 'month') {
                    // Mês completo como range, filtrado pelo nome da demanda
                    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
                    monthStart.setHours(0, 0, 0, 0);
                    const monthEnd = new Date(today);
                    monthEnd.setHours(23, 59, 59, 999);
                    const fmt = d => `${d.getDate()}/${d.getMonth()+1}`;
                    const rangeLabel = `${itemName} · ${fmt(monthStart)}–${fmt(monthEnd)}`;
                    this._navigateToHistoryWithFilter('all', itemName, today, { start: monthStart, end: monthEnd, label: rangeLabel });
                } else {
                    // Ano completo como range, filtrado pelo nome da demanda
                    const yearStart = new Date(today.getFullYear(), 0, 1);
                    yearStart.setHours(0, 0, 0, 0);
                    const yearEnd = new Date(today);
                    yearEnd.setHours(23, 59, 59, 999);
                    const rangeLabel = `${itemName} · Jan–${today.toLocaleString('pt-BR',{month:'short'})} ${today.getFullYear()}`;
                    this._navigateToHistoryWithFilter('all', itemName, today, { start: yearStart, end: yearEnd, label: rangeLabel });
                }
            });
        });
    }

    /** Navigates to history tab with a status filter and optional search query */
    async _navigateToHistoryWithFilter(statusFilter, searchQuery, date, dateRange) {
        // Set history date and optional range
        this.historyDate = new Date(date || new Date());
        this.historyDate.setHours(12, 0, 0, 0);
        this._historyDateRange = dateRange || null;

        // Set filters before rendering
        this._activeHistoryFilter = statusFilter || 'all';
        this._historySearchQuery = searchQuery ? searchQuery.toLowerCase() : '';

        // Navigate to history view
        await this.showView('history');

        // Sync filter buttons to match active filter
        document.querySelectorAll('#historyStatusFilter .tsf-btn').forEach(b => {
            b.classList.toggle('tsf-active', b.dataset.status === this._activeHistoryFilter);
        });

        // Sync search input
        const input    = document.getElementById('historySearchInput');
        const wrap     = document.getElementById('historySearchWrap');
        const clearBtn = document.getElementById('historySearchClear');
        if (searchQuery) {
            if (input)    input.value = searchQuery;
            if (wrap)     wrap.classList.add('tsf-search-open');
            if (clearBtn) clearBtn.style.display = 'flex';
        } else {
            // No search — ensure search bar is hidden/empty
            if (input)    input.value = '';
            if (wrap)     wrap.classList.remove('tsf-search-open');
            if (clearBtn) clearBtn.style.display = 'none';
        }
    }

    /** Triggers sparkline drawing on all visible canvases */
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
            // Daily from start of current month to today
            const today = new Date(); today.setHours(23, 59, 59, 999);
            for (let d = new Date(startDate); d <= today; d.setDate(d.getDate() + 1)) {
                labels.push(d.getDate() + '/' + (d.getMonth() + 1));
                pushCounts(countDay(this.getDateString(new Date(d))));
            }
        } else {
            // year/all: aggregate by month
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
    }

    /** Renders a mini bar chart on a .demand-mini-chart canvas */
    _renderCategoryMiniChart(canvas) {
        if (typeof Chart === 'undefined') return;
        try {
            const raw = canvas.dataset.minidata;
            if (!raw) return;
            const { labels, concluido, emAndamento, aguardando, naoFeito } = JSON.parse(decodeURIComponent(raw));
            const totalItems = parseInt(canvas.dataset.total || '0', 10);
            if (!labels || !labels.length) return;

            // Destroy previous chart instance if exists
            const existing = Chart.getChart(canvas);
            if (existing) existing.destroy();

            new Chart(canvas, {
                type: 'bar',
                data: {
                    labels,
                    datasets: [
                        { label: 'Concluído',    data: concluido,    backgroundColor: '#22c55e', borderRadius: 4 },
                        { label: 'Andamento',    data: emAndamento,  backgroundColor: '#eab308', borderRadius: 4 },
                        { label: 'Aguardando',   data: aguardando,   backgroundColor: '#95d3ee', borderRadius: 4 },
                        { label: 'Não Feito',    data: naoFeito,     backgroundColor: '#ef4444', borderRadius: 4 },
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    animation: { duration: 400, easing: 'easeInOutQuart' },
                    plugins: {
                        legend: {
                            display: true,
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
    }

    /** Renders all visible category mini-charts */
    _renderAllCategoryMiniCharts() {
        document.querySelectorAll('.demand-section-body.open .demand-mini-chart').forEach(canvas => {
            this._renderCategoryMiniChart(canvas);
        });
    }

    _renderAllSparklines() {
        document.querySelectorAll('.demand-sparkline').forEach(canvas => {
            try {
                const history = JSON.parse(canvas.dataset.history || '[]');
                this._drawSparkline(canvas, history);
            } catch (e) {}
        });
    }

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
    }

    async renderPerformanceChart(period, startDate, endDate) {
        // Check if Chart.js is loaded
        if (typeof Chart === 'undefined') {
            console.warn('Chart.js not loaded yet');
            return;
        }

        const canvas = document.getElementById('performanceChart');
        if (!canvas) return;

        // Destroy existing chart
        if (this.performanceChart) {
            this.performanceChart.destroy();
        }

        const { labels, datasets } = await this.getChartData(period, startDate, endDate);

        // Para semana: limite fixo = total de demandas ativas (um dia não pode ter mais do que isso)
        // Para mês/ano/all: limite dinâmico = maior valor acumulado encontrado nos dados (pode ser múltiplos dias somados)
        const totalDemandas = APP_DATA.clientes.length + APP_DATA.categorias.length + APP_DATA.atividades.length;

        let yMax;
        if (period === 'week') {
            yMax = totalDemandas;
        } else {
            // Calcula o valor máximo real dos dados para expandir o eixo Y dinamicamente
            const allValues = [
                ...datasets.concluido,
                ...datasets.emAndamento,
                ...datasets.aguardando,
                ...datasets.naoFeito,
                ...datasets.pulado
            ];
            const dataMax = Math.max(...allValues, 1);
            // Adiciona 10% de margem superior para melhor visualização
            yMax = Math.ceil(dataMax * 1.10);
        }

        const yStepSize = Math.ceil(yMax / 8);

        const ctx = canvas.getContext('2d');
        this.performanceChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [
                    {
                        label: 'Concluído',
                        data: datasets.concluido,
                        backgroundColor: '#22c55e',
                        borderRadius: 6,
                    },
                    {
                        label: 'Em Andamento',
                        data: datasets.emAndamento,
                        backgroundColor: '#eab308',
                        borderRadius: 6,
                    },
                    {
                        label: 'Aguardando',
                        data: datasets.aguardando,
                        backgroundColor: '#95d3ee',
                        borderRadius: 6,
                    },
                    {
                        label: 'Não Feito',
                        data: datasets.naoFeito,
                        backgroundColor: '#ef4444',
                        borderRadius: 6,
                    },
                    {
                        label: 'Pulado',
                        data: datasets.pulado,
                        backgroundColor: 'rgba(255, 255, 255, 0.3)',
                        borderRadius: 6,
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
                            font: {
                                family: 'Quicksand',
                                size: 11
                            },
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
                            font: {
                                family: 'Quicksand',
                                size: 11
                            }
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
                            font: {
                                family: 'Quicksand',
                                size: 11
                            },
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
    }

    async renderGroupChart(period, startDate, endDate) {
        // Check if Chart.js is loaded
        if (typeof Chart === 'undefined') {
            console.warn('Chart.js not loaded yet');
            return;
        }

        const canvas = document.getElementById('groupChart');
        if (!canvas) return;

        // Destroy existing chart
        if (this.groupChart) {
            this.groupChart.destroy();
        }

        const { labels, groupData } = await this.getGroupChartData(period, startDate, endDate);

        // Lê os rótulos personalizados das categorias
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
                            font: {
                                family: 'Quicksand',
                                size: 11
                            },
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
                            font: {
                                family: 'Quicksand',
                                size: 11
                            }
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
                            font: {
                                family: 'Quicksand',
                                size: 11
                            },
                            callback: function(value) {
                                return value + '%';
                            }
                        }
                    }
                }
            }
        });
    }

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
            // All 7 days of current week (Mon→Sun), future days show zero
            const dayNames = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
            const monday = this.getWeekMonday(new Date());
            const today = new Date();
            today.setHours(23, 59, 59, 999);
            for (let i = 0; i < 7; i++) {
                const date = new Date(monday);
                date.setDate(monday.getDate() + i);
                labels.push(dayNames[date.getDay()]);
                if (date > today) {
                    // Future day — push zeros
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
            // 4 weeks
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
            // 12 months
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
            // Get all months with data
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
    }

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

        // Retornar contagens absolutas (não percentagens)
        return {
            concluido: counts.concluido,
            emAndamento: counts.emAndamento,
            aguardando: counts.aguardando,
            naoFeito: counts.naoFeito,
            pulado: 0
        };
    }

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

        // Retornar contagens absolutas (não percentagens)
        return {
            concluido: counts.concluido,
            emAndamento: counts.emAndamento,
            aguardando: counts.aguardando,
            naoFeito: counts.naoFeito,
            pulado: 0
        };
    }

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
                    // Future day — push zeros
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
    }

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
                if (dayData[category]) {
                    Object.values(dayData[category]).forEach(item => {
                        const status = item.status || 'none';
                        if (status !== 'none' && status !== 'pular') {
                            groups[category].total++;
                            
                            // Score-based completion
                            if (status === 'concluido' || status === 'concluido-ongoing') {
                                groups[category].completed += 1.0;
                            } else if (status === 'parcialmente') {
                                groups[category].completed += 0.7;
                            } else if (status === 'em-andamento') {
                                groups[category].completed += 0.5;
                            } else if (status === 'aguardando') {
                                groups[category].completed += 0.3;
                            }
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
    }

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
    }

    async renderDrillTable(category, period, startDate, endDate) {
        const dates = [];
        let currentDate = new Date(startDate);
        
        // Collect dates for the period
        while (currentDate <= endDate) {
            dates.push(new Date(currentDate));
            currentDate.setDate(currentDate.getDate() + 1);
        }

        // Get all items in this category
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
        
        // Limit to last 30 days for readability
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
                
                // Toggle current item
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