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
        this.init();
    }

    init() {
        this.setupEventListeners();
        this.initSpeech();
        this.renderTodayView();
    }

    // Centralized method to exit edit mode for any currently editing item
    exitCurrentEditMode(saveChanges = true) {
        if (this.currentlyEditingItem) {
            const { element, noteEditable, category, itemId } = this.currentlyEditingItem;
            
            // Immediately blur and hide to prevent conflicts
            if (noteEditable) {
                noteEditable.blur();
                noteEditable.style.display = 'none';
            }
            
            if (saveChanges && noteEditable) {
                // Save the current content
                const text = noteEditable.innerText.trim();
                // Use setTimeout 0 to avoid blocking the UI
                setTimeout(() => {
                    this.saveInlineNote(element, category, itemId, text);
                }, 0);
            }
            
            // Show the regular note display if needed
            const displayedNote = element.querySelector('.item-note');
            if (displayedNote && displayedNote.innerHTML.trim()) {
                displayedNote.style.display = 'block';
            }
            
            // Clear the editing state immediately
            this.currentlyEditingItem = null;
        }
    }

    // Force immediate switch to edit mode for a specific item
    forceEditMode(element, noteEditable, category, itemId) {
        // Stop any current editing immediately without delay
        if (this.currentlyEditingItem && this.currentlyEditingItem.element !== element) {
            const current = this.currentlyEditingItem;
            // Save and close current item synchronously
            if (current.noteEditable) {
                current.noteEditable.blur();
                current.noteEditable.style.display = 'none';
                const text = current.noteEditable.innerText.trim();
                this.saveInlineNote(current.element, current.category, current.itemId, text);
                
                // Show note display for previous item
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

        this.recognition.addEventListener('result', (e) => {
            const transcript = Array.from(e.results)
                .map(r => r[0].transcript)
                .join('')
                .trim();

            if (!transcript) return;

            // Append transcript to existing note for the current recording target
            if (this.currentRecording) {
                const dateStr = this.getDateString();
                const { category, itemId } = this.currentRecording;
                const existing = StorageManager.getItemStatus(dateStr, category, itemId);
                const prevNote = existing.note || '';
                const timestamp = new Date().toLocaleTimeString();
                const appended = (prevNote ? prevNote + '\n' : '') + `[voz ${timestamp}] ` + transcript;

                StorageManager.saveItemStatus(dateStr, category, itemId, existing.status || 'none', appended);
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

        // Date navigation
        document.getElementById('btnPrevDay').addEventListener('click', () => this.changeDate(-1));
        document.getElementById('btnNextDay').addEventListener('click', () => this.changeDate(1));

        // Modal
        document.getElementById('btnSaveModal').addEventListener('click', () => this.saveItem());
        document.getElementById('btnCancelModal').addEventListener('click', () => this.closeModal());
        document.getElementById('itemModal').addEventListener('click', (e) => {
            if (e.target.id === 'itemModal') this.closeModal();
        });

        // Report period buttons
        document.querySelectorAll('.btn-period').forEach(btn => {
            btn.addEventListener('click', (e) => {
                document.querySelectorAll('.btn-period').forEach(b => b.classList.remove('active'));
                e.currentTarget.classList.add('active');
                const period = e.currentTarget.dataset.period;
                this.renderReports(period);
            });
        });

        // History period selector
        document.getElementById('historyPeriod').addEventListener('change', (e) => {
            this.renderHistory(parseInt(e.target.value));
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
    }

    showView(view) {
        this.currentView = view;
        document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
        
        if (view === 'today') {
            document.getElementById('todayView').classList.remove('hidden');
            this.renderTodayView();
        } else if (view === 'history') {
            document.getElementById('historyView').classList.remove('hidden');
            this.renderHistory(7);
        } else if (view === 'reports') {
            document.getElementById('reportsView').classList.remove('hidden');
            this.renderReports('week');
        }
    }

    changeDate(days) {
        this.currentDate.setDate(this.currentDate.getDate() + days);
        this.renderTodayView();
    }

    getDateString(date = this.currentDate) {
        return date.toISOString().split('T')[0];
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
        
        document.getElementById('currentDate').textContent = this.formatDate(this.currentDate);
        const dateStr = this.getDateString();

        // Render each category
        this.renderCategoryItems('clientes', 'clientesList', APP_DATA.clientes, dateStr);
        this.renderCategoryItems('categorias', 'categoriasList', APP_DATA.categorias, dateStr);
        this.renderCategoryItems('atividades', 'atividadesList', APP_DATA.atividades, dateStr);
    }

    renderCategoryItems(category, containerId, items, dateStr) {
        const container = document.getElementById(containerId);
        container.innerHTML = '';

        items.forEach(item => {
            const itemData = StorageManager.getItemStatus(dateStr, category, item.id);
            const statusConfig = STATUS_CONFIG[itemData.status];
            
            const itemEl = document.createElement('div');
            itemEl.className = 'item';
            // add status class to paint the whole item according to status
            const initialStatus = itemData.status || 'none';
            itemEl.classList.add(`status-${initialStatus}`);
            
            let noteHtml = '';
            if (itemData.note && itemData.note.trim()) {
                const noteWithLinks = this.linkifyText(itemData.note);
                noteHtml = `<div class="item-note" data-item-id="${item.id}">${noteWithLinks}<button class="btn-note-delete" title="Apagar nota">✖</button></div>`;
            }

            // Build header with mic button (custom status dropdown will be inserted programmatically)
            const headerHtml = `
                <div class="item-header">
                    <span class="item-name" tabindex="0">${item.name}</span>
                    <div style="display:flex;gap:0.5rem;align-items:center;">
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

            // Universal click handler for edit mode - works for any click that should trigger editing
            const handleItemClick = (ev) => {
                const clickedElement = ev.target;
                
                // Skip if clicked on interactive elements that shouldn't trigger edit mode
                if (clickedElement.closest('.btn-mic') || 
                    clickedElement.closest('.custom-status') ||
                    clickedElement.closest('.btn-note-delete')) {
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

            // Save on blur or Ctrl/Cmd+Enter - simplified logic
            noteEditable.addEventListener('blur', (ev) => {
                // Only save if this item is still the currently editing one
                // Use a shorter timeout to be more responsive
                setTimeout(() => {
                    if (this.currentlyEditingItem && this.currentlyEditingItem.noteEditable === noteEditable) {
                        this.saveInlineNote(itemEl, category, item.id, noteEditable.innerText.trim());
                        this.currentlyEditingItem = null; // Clear the editing state
                    }
                }, 50); // Reduced timeout for better responsiveness
            });
            
            noteEditable.addEventListener('keydown', (ev) => {
                if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
                    ev.preventDefault();
                    this.exitCurrentEditMode(true); // Use the centralized method
                }
            });

            // When saved via blur handler, the view will re-render and the display will update.

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

            // populate list from STATUS_CONFIG
            Object.keys(STATUS_CONFIG).forEach(key => {
                const cfg = STATUS_CONFIG[key];
                const li = document.createElement('li');
                li.className = 'custom-status-option';
                li.setAttribute('role', 'option');
                li.dataset.value = key;
                li.innerText = `${cfg.emoji} ${cfg.label}`;
                statusList.appendChild(li);
            });

            statusContainer.appendChild(statusBtn);
            statusContainer.appendChild(statusList);
            // insert the custom control into the header area (replace the select spot)
            const headerRight = itemEl.querySelector('.item-header > div');
            if (headerRight) headerRight.appendChild(statusContainer);

            // helper to show current selected label on button
            const setStatusUI = (statusKey) => {
                const cfg = STATUS_CONFIG[statusKey] || STATUS_CONFIG['none'];
                statusBtn.innerText = `${cfg.emoji} ${cfg.label}`;
                // attach data-status for backward CSS compatibility
                statusBtn.dataset.status = statusKey;
                statusContainer.dataset.status = statusKey;
                // update item class
                Array.from(itemEl.classList).filter(c => c.startsWith('status-')).forEach(c => itemEl.classList.remove(c));
                itemEl.classList.add(`status-${statusKey}`);
            };

            // initialize with current value
            const initialStatusKey = itemData.status || 'none';
            setStatusUI(initialStatusKey);

            // open/close logic
            const closeAllStatusLists = () => {
                document.querySelectorAll('.custom-status-list').forEach(l => l.classList.add('hidden'));
            };

            statusBtn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                const isHidden = statusList.classList.contains('hidden');
                closeAllStatusLists();
                if (isHidden) statusList.classList.remove('hidden');
                else statusList.classList.add('hidden');
            });

            // clicking an option
            statusList.addEventListener('click', (ev) => {
                const li = ev.target.closest('.custom-status-option');
                if (!li) return;
                const newStatus = li.dataset.value || 'none';
                setStatusUI(newStatus);

                // save
                const dateStr = this.getDateString();
                const existing = StorageManager.getItemStatus(dateStr, category, item.id);
                StorageManager.saveItemStatus(dateStr, category, item.id, newStatus, existing.note || '');

                // close and re-render
                statusList.classList.add('hidden');
                this.renderTodayView();
            });

            // close when clicking outside
            document.addEventListener('click', (ev) => {
                if (!statusContainer.contains(ev.target)) {
                    statusList.classList.add('hidden');
                }
            });

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

            container.appendChild(itemEl);

            // Note delete button handler (if present)
            const deleteBtn = itemEl.querySelector('.btn-note-delete');
            if (deleteBtn) {
                deleteBtn.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    const ok = confirm('Deseja apagar esta nota?');
                    if (!ok) return;
                    const dateStr = this.getDateString();
                    const existing = StorageManager.getItemStatus(dateStr, category, item.id);
                    StorageManager.saveItemStatus(dateStr, category, item.id, existing.status || 'none', '');
                    this.renderTodayView();
                });
            }
        });
    }

    // Convert URLs in text to clickable links
    linkifyText(text) {
        const urlRegex = /(https?:\/\/[^\s]+)/g;
        return text.replace(urlRegex, '<a href="$1" target="_blank" onclick="event.stopPropagation()">$1</a>')
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

    saveItem() {
        if (!this.selectedItem) return;

        const dateStr = this.getDateString();
        const note = document.getElementById('itemNote').value;
        const status = document.getElementById('statusSelect').value;
        
        StorageManager.saveItemStatus(
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

    saveInlineNote(itemEl, category, itemId, text) {
        // prevent concurrent saves
        if (this._saveLock) return;
        this._saveLock = true;
        setTimeout(() => { this._saveLock = false; }, 400);

        const dateStr = this.getDateString();
        const existing = StorageManager.getItemStatus(dateStr, category, itemId);
        const status = existing.status || 'none';

        // Normalize whitespace to avoid duplicate-saves producing identical content
        const normalize = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const oldNote = normalize(existing.note || '');
        const newNote = normalize(text || '');

        // If nothing changed, just remove any editor and return (avoid duplicate entries)
        if (oldNote === newNote) {
            // remove editor if present
            const editor = itemEl.querySelector('.inline-editor');
            if (editor) editor.remove();
            // also update displayed note (in case formatting changed)
            this.renderTodayView();
            return;
        }

        StorageManager.saveItemStatus(dateStr, category, itemId, status, text);
        // remove editor and re-render the item
        const editor = itemEl.querySelector('.inline-editor');
        if (editor) editor.remove();
        this.renderTodayView();
    }

    renderHistory(days) {
        const container = document.getElementById('historyContent');
        container.innerHTML = '<div class="history-timeline"></div>';
        const timeline = container.querySelector('.history-timeline');

        const endDate = new Date();
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days);

        const dates = [];
        for (let d = new Date(endDate); d >= startDate; d.setDate(d.getDate() - 1)) {
            dates.push(new Date(d));
        }

        dates.forEach(date => {
            const dateStr = this.getDateString(date);
            const dayData = StorageManager.getDateData(dateStr);
            
            if (Object.keys(dayData).length === 0) return;

            const dayEl = document.createElement('div');
            dayEl.className = 'history-day';
            
            let itemsHtml = '<div class="history-items">';
            
            // Process all categories
            ['clientes', 'categorias', 'atividades'].forEach(category => {
                if (dayData[category]) {
                    const categoryData = APP_DATA[category];
                    for (const itemId in dayData[category]) {
                        const item = categoryData.find(i => i.id === itemId);
                        if (item) {
                            const itemData = dayData[category][itemId];
                            // Handle both old and new format
                            const status = typeof itemData === 'string' ? itemData : itemData.status;
                            const note = typeof itemData === 'string' ? '' : (itemData.note || '');
                            const statusConfig = STATUS_CONFIG[status];
                            
                            let noteHtml = '';
                            if (note && note.trim()) {
                                const noteWithLinks = this.linkifyText(note);
                                noteHtml = `<div class="item-note">${noteWithLinks}</div>`;
                            }
                            
                            itemsHtml += `
                                <div class="history-item">
                                    <div class="item-header">
                                        <span class="history-item-name">${item.name}</span>
                                        <span class="item-status">${statusConfig.emoji}</span>
                                    </div>
                                    ${noteHtml}
                                </div>
                            `;
                        }
                    }
                }
            });
            
            itemsHtml += '</div>';
            
            dayEl.innerHTML = `
                <h4>${this.formatDate(date)}</h4>
                ${itemsHtml}
            `;
            
            timeline.appendChild(dayEl);
        });

        if (timeline.children.length === 0) {
            timeline.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-icon">📭</div>
                    <div class="empty-state-text">Nenhum histórico encontrado para este período</div>
                </div>
            `;
        }
    }

    renderReports(period) {
        const container = document.getElementById('reportsContent');
        
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

        const stats = StorageManager.calculateStats(startDate, endDate);
        
        let html = `
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

        container.innerHTML = html;
    }
}

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.app = new HabitTrackerApp();
});