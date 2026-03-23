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
        // Charts
        this.performanceChart = null;
        this.groupChart = null;
        this.currentReportPeriod = 'week';
        this.init();
    }

    init() {
        this.setupEventListeners();
        this.initSpeech();
        this._syncHeaderHeight();
        window.addEventListener('resize', () => this._syncHeaderHeight());
        this.renderTodayView();
        // Se havia um re-render pendente (sync do Supabase chegou antes do app inicializar)
        if (window._pendingRerender) {
            window._pendingRerender = false;
            this.renderCurrentView();
        }
        // Verifica se houve virada de dia perdida e agenda rollover da meia-noite
        this._checkMissedRollover();
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
                        const text = noteEditable.innerText.trim();
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
                    const text = noteEditable.innerText.trim();
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
    // Garante que o date-selector sticky nunca fique sob o header
    _syncHeaderHeight() {
        const headerEl = document.querySelector('.header');
        if (headerEl) {
            const h = headerEl.getBoundingClientRect().height;
            document.documentElement.style.setProperty('--header-h', Math.round(h) + 'px');
        }
    }

    // Re-renderiza a view ativa atual (usado após sync do Supabase)
    renderCurrentView() {
        console.log('Re-renderizando view após sync:', this.currentView);
        if (this.currentView === 'today') {
            this.renderTodayView();
        } else if (this.currentView === 'history') {
            this.renderHistory(7);
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
                    Aprendizados.addQuickEntry(category, itemId, itemName, text);
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

    // Centralized method to exit edit mode for any currently editing item
    exitCurrentEditMode(saveChanges = true) {
        if (this.currentlyEditingItem) {
            const { element, noteEditable, category, itemId } = this.currentlyEditingItem;

            if (saveChanges && noteEditable) {
                const text = noteEditable.innerText.trim();
                this.saveInlineNote(element, category, itemId, text);
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
                const text = current.noteEditable.innerText.trim();
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
                await this.renderReports(period);
            });
        });

        // Custom Period Selector
        const periodSelectorBtn = document.getElementById('periodSelectorBtn');
        const periodDropdown = document.getElementById('periodDropdown');
        const periodOptions = document.querySelectorAll('.period-option');
        
        // Toggle dropdown
        periodSelectorBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            periodSelectorBtn.classList.toggle('active');
            periodDropdown.classList.toggle('hidden');
        });
        
        // Close dropdown when clicking outside
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.period-selector-wrapper')) {
                periodSelectorBtn?.classList.remove('active');
                periodDropdown?.classList.add('hidden');
            }
        });
        
        // Period option selection
        periodOptions.forEach(option => {
            option.addEventListener('click', (e) => {
                const days = parseInt(e.currentTarget.dataset.days);
                const type = e.currentTarget.dataset.type;
                const label = e.currentTarget.querySelector('span').textContent;
                
                // Update active state
                periodOptions.forEach(opt => opt.classList.remove('active'));
                e.currentTarget.classList.add('active');
                
                // Update button label
                document.getElementById('periodSelectorLabel').textContent = label;
                
                // Close dropdown
                periodSelectorBtn.classList.remove('active');
                periodDropdown.classList.add('hidden');
                
                // Clear specific date when period changes
                document.getElementById('specificDate').value = '';
                document.getElementById('btnClearDate').classList.add('hidden');
                
                // Render history based on type
                if (type === 'week') {
                    this.renderHistoryForCurrentWeek();
                } else if (type === 'month') {
                    this.renderHistoryForCurrentMonth();
                } else if (days) {
                    this.renderHistory(days);
                }
            });
        });
        
        // Specific date selector
        document.getElementById('specificDate')?.addEventListener('change', (e) => {
            const dateValue = e.target.value;
            if (dateValue) {
                document.getElementById('btnClearDate').classList.remove('hidden');
                this.renderHistoryForSpecificDate(dateValue);
            } else {
                document.getElementById('btnClearDate').classList.add('hidden');
                // Get current selected period from active option
                const activeOption = document.querySelector('.period-option.active');
                const currentPeriod = activeOption ? parseInt(activeOption.dataset.days) : 7;
                this.renderHistory(currentPeriod);
            }
        });
        
        // Clear date button
        document.getElementById('btnClearDate')?.addEventListener('click', () => {
            document.getElementById('specificDate').value = '';
            document.getElementById('btnClearDate').classList.add('hidden');
            // Get current selected period from active option
            const activeOption = document.querySelector('.period-option.active');
            const currentPeriod = activeOption ? parseInt(activeOption.dataset.days) : 7;
            this.renderHistory(currentPeriod);
        });
        
        // Toggle empty items in history
        document.getElementById('toggleEmptyItems')?.addEventListener('change', (e) => {
            const specificDate = document.getElementById('specificDate').value;
            if (specificDate) {
                this.renderHistoryForSpecificDate(specificDate);
            } else {
                // Get current selected period from active option
                const activeOption = document.querySelector('.period-option.active');
                const currentPeriod = activeOption ? parseInt(activeOption.dataset.days) : 7;
                this.renderHistory(currentPeriod);
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
            this.renderTodayView();
        }, true); // Use capturing phase

        // Aprendizados Picker
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
                        <span>${lineText}</span>
                    `;

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

        // Ler todas as notas do item (formato novo notes:[] e legado)
        let aprendData = {};
        try { aprendData = JSON.parse(localStorage.getItem('aprendizadosData') || '{}'); } catch {}

        const rawItem = aprendData[category]?.[itemId];
        let notes = [];
        if (rawItem) {
            if (Array.isArray(rawItem.notes) && rawItem.notes.length > 0) {
                notes = rawItem.notes;
            } else if (typeof rawItem.content !== 'undefined') {
                // Formato legado: criar nota virtual
                notes = [{
                    id: '__legacy__',
                    title: '',
                    content: rawItem.content || '',
                    checkedLines: rawItem.checkedLines || {},
                }];
            }
        }

        // Ler nota atual do item no hoje (para saber quais linhas já foram adicionadas)
        const dateStr = this.getDateString();
        let currentNoteText = '';
        try {
            const cur = await StorageManager.getItemStatus(dateStr, category, itemId);
            currentNoteText = cur.note || '';
        } catch {}
        const todayLines = new Set(
            currentNoteText.split('\n').map(l => l.trim()).filter(Boolean)
        );

        // Construir dropdown
        const dropdown = document.createElement('div');
        dropdown.className = 'item-aprend-dropdown';
        dropdown.dataset.itemId = itemId;
        dropdown.dataset.category = category;

        // Contar total de linhas com conteúdo em todas as notas
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
            notes.forEach((note) => {
                const noteLines = (note.content || '').split('\n').filter(l => l.trim() !== '');
                if (noteLines.length === 0) return;

                // Cabeçalho da nota (só se houver título ou múltiplas notas)
                if (notes.length > 1 || note.title) {
                    const headerEl = document.createElement('div');
                    headerEl.className = 'item-aprend-note-header';
                    headerEl.textContent = note.title || 'Nota';
                    dropdown.appendChild(headerEl);
                }

                noteLines.forEach((lineText, lineIdx) => {
                    // realIdx = índice no content.split('\n') incluindo linhas vazias
                    // (para bater com checkedLines que usa esse índice)
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
                        <span>${lineText}</span>
                    `;
                    lineEl.addEventListener('mousedown', async (ev) => {
                        ev.preventDefault();
                        ev.stopPropagation();

                        // Inserir no noteEditable
                        const currentText = noteEditable.innerText.trim();
                        noteEditable.innerText = currentText
                            ? (currentText.includes(lineText) ? currentText : currentText + '\n' + lineText)
                            : lineText;

                        // Salvar imediatamente
                        const existingData = await StorageManager.getItemStatus(dateStr, category, itemId);
                        await StorageManager.saveItemStatus(dateStr, category, itemId, existingData.status || 'none', noteEditable.innerText.trim());

                        // Marcar verde na aba Aprendizados
                        if (typeof Aprendizados !== 'undefined' && Aprendizados.setLineChecked) {
                            Aprendizados.setLineChecked(category, itemId, realIdx, true, note.id);
                        }

                        // Atualizar visual da linha no dropdown imediatamente
                        lineEl.classList.add('done');
                        lineEl.querySelector('.item-aprend-icon')?.classList.add('done');
                        lineEl.querySelector('.item-aprend-icon').innerHTML = '<polyline points="20 6 9 17 4 12"></polyline>';

                        // Fechar dropdown com pequeno delay para mostrar o verde
                        setTimeout(() => this._closeAllItemAprendDropdowns(), 350);
                        this.renderTodayView();
                    });
                    dropdown.appendChild(lineEl);
                });
            });

            // Botão "Ver todas as notas" no rodapé
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

        // Portal: mover para body com position fixed
        dropdown.style.position = 'fixed';
        dropdown.style.top = '-9999px';
        dropdown.style.left = '-9999px';
        document.body.appendChild(dropdown);
        btn.classList.add('active');

        // Posicionar após render
        requestAnimationFrame(() => {
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
        });

        // Fechar ao clicar fora; scroll DENTRO do dropdown é permitido
        const closeHandler = (ev) => {
            if (!dropdown.contains(ev.target) && ev.target !== btn) {
                this._closeAllItemAprendDropdowns();
                document.removeEventListener('click', closeHandler, true);
                window.removeEventListener('scroll', scrollClose, true);
            }
        };
        const scrollClose = (ev) => {
            // Ignorar scroll que originou DENTRO do dropdown (permite rolar a lista)
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

    async showView(view) {
        // Salvar nota de aprendizado se estava nessa aba
        if (this.currentView === 'aprendizados' && typeof Aprendizados !== 'undefined') {
            Aprendizados.onHide();
        }

        this.currentView = view;
        document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
        
        // Update active button state
        document.querySelectorAll('.btn-nav-header').forEach(btn => btn.classList.remove('active'));
        
        if (view === 'today') {
            document.getElementById('todayView').classList.remove('hidden');
            document.getElementById('btnToday').classList.add('active');
            this.renderTodayView();
        } else if (view === 'history') {
            document.getElementById('historyView').classList.remove('hidden');
            document.getElementById('btnHistory').classList.add('active');
            await this.renderHistory(7);
        } else if (view === 'reports') {
            document.getElementById('reportsView').classList.remove('hidden');
            document.getElementById('btnReports').classList.add('active');
            await this.renderReports('week');
        } else if (view === 'aprendizados') {
            document.getElementById('aprendizadosView').classList.remove('hidden');
            document.getElementById('btnAprendizados').classList.add('active');
            if (typeof Aprendizados !== 'undefined') {
                // Inicializar na primeira visita
                if (!this._aprendizadosInited) {
                    Aprendizados.init();
                    this._aprendizadosInited = true;
                } else {
                    Aprendizados.onShow();
                }
            }
        }
    }

    changeDate(days) {
        this.currentDate.setDate(this.currentDate.getDate() + days);
        this.renderTodayView();
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

                // Atualizar bloco visual
                dayEl.dataset.status = opt.key;
                blockEl.dataset.status = opt.key;

                const todayStr = this.getDateString(new Date());
                if (opt.key === 'concluido' && dateStr === todayStr) {
                    this.showAprendizadoPopup(category, itemId, item?.name || itemId);
                }
                if (dateStr === todayStr) {
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
        ]).then(() => this._applyTodayFilter());
    }

    _applyTodayFilter() {
        const filter = this._activeTodayFilter || 'all';
        const query  = (this._todaySearchQuery || '').toLowerCase().trim();

        document.querySelectorAll('#todayView .item').forEach(itemEl => {
            const statusOk = filter === 'all' || itemEl.classList.contains('status-' + filter);

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
                            nameEl.innerHTML = originalName.slice(0, idx)
                                + '<mark class="tsf-highlight">' + originalName.slice(idx, idx + query.length) + '</mark>'
                                + originalName.slice(idx + query.length);
                        }
                    } else {
                        nameEl.innerHTML = originalName;
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
            // add status class to paint the whole item according to status
            const initialStatus = itemData.status || 'none';
            itemEl.classList.add(`status-${initialStatus}`);
            
            let noteHtml = '';
            if (itemData.note && itemData.note.trim()) {
                const noteWithLinks = this.linkifyText(itemData.note);
                noteHtml = `<div class="item-note" data-item-id="${item.id}" data-category="${category}">${noteWithLinks}<button class="btn-note-delete" data-item-id="${item.id}" data-category="${category}" title="Apagar nota">✖</button></div>`;
            }

            // Build header with mic button (custom status dropdown will be inserted programmatically)
            const hasNoteInitially = !!(itemData.note && itemData.note.trim());
            const headerHtml = `
                <div class="item-header">
                    <span class="item-name" tabindex="0">${item.name}</span>
                    <div style="display:flex;gap:0.5rem;align-items:center;">
                        <button class="btn-google-search" title="Pesquisar nota no Google" aria-label="Pesquisar no Google" style="display:${hasNoteInitially ? 'inline-flex' : 'none'};align-items:center;justify-content:center;padding:2px 4px;background:none;border:none;cursor:pointer;border-radius:4px;opacity:0.75;" tabindex="-1"><img src="https://www.google.com/favicon.ico" alt="Google" width="14" height="14" style="display:block;pointer-events:none;"></button>
                        <button class="btn-next-day" title="Passar para próximo dia" aria-label="Próximo dia">⏭</button>
                        <button class="btn-aprend-item" title="Inserir nota de Aprendizados" aria-label="Aprendizados">📚</button>
                        <button class="btn-mic" title="Gravar nota por voz" aria-label="Gravar nota por voz">🎙️</button>
                    </div>
                </div>
            `;

            itemEl.innerHTML = headerHtml + `${noteHtml}`;

            // Inline note editor (editable directly) - one click to type
            const noteText = itemData.note || '';
            const noteEditable = document.createElement('div');
            noteEditable.className = 'item-note-editable';
            noteEditable.contentEditable = true;
            noteEditable.spellcheck = true;
            noteEditable.innerText = noteText;
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
                    clickedElement.closest('.item-aprend-dropdown') ||
                    clickedElement.closest('.item-week-bar')) {
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
                const text = noteEditable.innerText.trim();
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
                this.renderTodayView();

                // Se concluído hoje: perguntar aprendizado
                if (newStatus === 'concluido') {
                    this.showAprendizadoPopup(category, item.id, item.name || item.id);
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

            // Mic button logic
            const micBtn = itemEl.querySelector('.btn-mic');
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
                    setTimeout(() => this.renderTodayView(), 700);
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
        return text.replace(urlRegex, '<a href="$1" target="_blank" rel="noopener noreferrer" class="note-link">$1</a>')
                   .replace(/\n/g, '<br>');
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
            <textarea class="inline-textarea" placeholder="Escreva sua nota...">${noteText}</textarea>
            <div style="display:flex;gap:0.5rem;margin-top:0.5rem;">
                <button class="btn-inline-save">Salvar</button>
                <button class="btn-inline-cancel">Cancelar</button>
            </div>
        `;

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
        const noteWithLinks = this.linkifyText(text);
        const newInner = `${noteWithLinks}<button class="btn-note-delete" data-item-id="${itemId}" data-category="${category}" title="Apagar nota">✖</button>`;

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
            const noteWithLinks = this.linkifyText(itemInfo.note);
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
        
        if (!container) {
            console.error('reportsContent container not found!');
            return;
        }
        
        console.log('Rendering reports for period:', period);
        
        let startDate = new Date();
        const endDate = new Date();
        
        switch(period) {
            case 'week':
                startDate.setDate(startDate.getDate() - 7);
                break;
            case 'month':
                startDate.setMonth(startDate.getMonth() - 1);
                break;
            case 'year':
                startDate.setFullYear(startDate.getFullYear() - 1);
                break;
            case 'all':
                startDate = new Date(2020, 0, 1);
                break;
        }

        const stats = await StorageManager.calculateStats(startDate, endDate);
        
        // Ensure stats have default values
        if (!stats.overall.completionRate) stats.overall.completionRate = 0;
        if (!stats.totalDays) stats.totalDays = 0;
        
        // Create charts section first
        let html = `
            <div class="charts-section">
                <div class="charts-grid">
                    <div class="chart-container">
                        <h3>Desempenho por Status</h3>
                        <div class="chart-wrapper">
                            <canvas id="performanceChart"></canvas>
                        </div>
                    </div>
                    <div class="chart-container">
                        <h3>Comparativo por Grupo</h3>
                        <div class="chart-wrapper">
                            <canvas id="groupChart"></canvas>
                        </div>
                    </div>
                </div>
            </div>
        `;
        
        html += `
            <div class="stats-grid">
                <div class="stat-card">
                    <h4>Taxa de Conclusão Geral</h4>
                    <div class="stat-value">${stats.overall.completionRate}%</div>
                    <div class="progress-bar">
                        <div class="progress-fill" style="width: ${stats.overall.completionRate}%"></div>
                    </div>
                    <div class="stat-label">${stats.overall.completed} de ${stats.overall.total - stats.overall.skipped} tarefas</div>
                </div>
                
                <div class="stat-card">
                    <h4>Dias Registrados</h4>
                    <div class="stat-value">${stats.totalDays}</div>
                    <div class="stat-label">Dias com atividades</div>
                </div>
                
                <div class="stat-card">
                    <h4>Total Concluído</h4>
                    <div class="stat-value">${stats.overall.completed}</div>
                    <div class="stat-label">Tarefas finalizadas</div>
                </div>
                
                <div class="stat-card">
                    <h4>Em Andamento</h4>
                    <div class="stat-value">${stats.overall.inProgress}</div>
                    <div class="stat-label">Tarefas em progresso</div>
                </div>
            </div>
        `;

        // Category breakdown
        html += '<div class="category-stats">';
        html += '<h4>📊 Desempenho por Categoria</h4>';
        
        const categoryNames = {
            'clientes': '👥 Clientes',
            'categorias': '🗂️ Categorias',
            'atividades': '🎯 Atividades'
        };

        for (const cat in stats.byCategory) {
            const catStats = stats.byCategory[cat];
            if (catStats.total > 0) {
                html += `
                    <div class="stats-row">
                        <span class="stats-label">${categoryNames[cat]}</span>
                        <span class="stats-value">${catStats.completionRate}%</span>
                    </div>
                    <div class="progress-bar" style="margin-bottom: 0.75rem;">
                        <div class="progress-fill" style="width: ${catStats.completionRate}%"></div>
                    </div>
                `;
            }
        }
        
        html += '</div>';

        // Detailed stats
        html += '<div class="category-stats">';
        html += '<h4>📈 Estatísticas Detalhadas</h4>';
        html += `
            <div class="stats-row">
                <span class="stats-label">✅ Concluído</span>
                <span class="stats-value">${stats.overall.completed}</span>
            </div>
            <div class="stats-row">
                <span class="stats-label">🟡 Em Andamento</span>
                <span class="stats-value">${stats.overall.inProgress}</span>
            </div>
            <div class="stats-row">
                <span class="stats-label">❌ Não Feito</span>
                <span class="stats-value">${stats.overall.notDone}</span>
            </div>
            <div class="stats-row">
                <span class="stats-label">⏭️ Pulado</span>
                <span class="stats-value">${stats.overall.skipped}</span>
            </div>
        `;
        html += '</div>';

        // Drill-down section
        html += await this.renderDrillDown(period, startDate, endDate);

        container.innerHTML = html;
        
        // Render charts after DOM is ready and Chart.js is loaded
        setTimeout(async () => {
            if (typeof Chart !== 'undefined') {
                await this.renderPerformanceChart(period, startDate, endDate);
                await this.renderGroupChart(period, startDate, endDate);
            } else {
                console.warn('Chart.js is not loaded. Charts will not be displayed.');
            }
            this.setupAccordions();
        }, 100);
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
                                return context.dataset.label + ': ' + context.parsed.y.toFixed(1) + '%';
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

        const ctx = canvas.getContext('2d');
        this.groupChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [
                    {
                        label: 'Clientes',
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
                        label: 'Categorias',
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
                        label: 'Atividades',
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
            // Last 7 days with weekday abbreviations
            const dayNames = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
            for (let i = 6; i >= 0; i--) {
                const date = new Date();
                date.setDate(date.getDate() - i);
                labels.push(dayNames[date.getDay()]);
                
                const dayData = await this.calculateDayStatusPercentages(date);
                datasets.concluido.push(dayData.concluido);
                datasets.emAndamento.push(dayData.emAndamento);
                datasets.aguardando.push(dayData.aguardando);
                datasets.naoFeito.push(dayData.naoFeito);
                datasets.pulado.push(dayData.pulado);
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

        const validTotal = counts.total - counts.pulado;
        if (validTotal === 0) {
            return { concluido: 0, emAndamento: 0, aguardando: 0, naoFeito: 0, pulado: 0 };
        }

        return {
            concluido: (counts.concluido / validTotal) * 100,
            emAndamento: (counts.emAndamento / validTotal) * 100,
            aguardando: (counts.aguardando / validTotal) * 100,
            naoFeito: (counts.naoFeito / validTotal) * 100,
            pulado: 0 // Don't show pulado in percentage
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

        const validTotal = counts.total - counts.pulado;
        if (validTotal === 0) {
            return { concluido: 0, emAndamento: 0, aguardando: 0, naoFeito: 0, pulado: 0 };
        }

        return {
            concluido: (counts.concluido / validTotal) * 100,
            emAndamento: (counts.emAndamento / validTotal) * 100,
            aguardando: (counts.aguardando / validTotal) * 100,
            naoFeito: (counts.naoFeito / validTotal) * 100,
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
            for (let i = 6; i >= 0; i--) {
                const date = new Date();
                date.setDate(date.getDate() - i);
                const data = await this.calculateGroupPercentages(date, date);
                groupData.clientes.push(data.clientes);
                groupData.categorias.push(data.categorias);
                groupData.atividades.push(data.atividades);
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