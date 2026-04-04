// app-edit.js — Mixin: Edit mode, inline editing, modal editing
// Extends HabitTrackerApp.prototype

Object.assign(HabitTrackerApp.prototype, {

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
    },

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
    },

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
    },

    closeModal() {
        document.getElementById('itemModal').classList.add('hidden');
        this.selectedItem = null;
    },

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
    },

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
    },

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
    },

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
    },

});
