// app-modals.js — Mixin: Modal dialogs (confirm, aprendizado, bloqueado, parcialmente)
// Extends HabitTrackerApp.prototype

Object.assign(HabitTrackerApp.prototype, {

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
    },

    // Show popup asking for the learning/aprendizado when an item is marked as concluido
    showAprendizadoPopup(category, itemId, itemName) {
        return new Promise((resolve) => {
            const modal = document.getElementById('aprendizadoModal');
            const input = document.getElementById('aprendizadoInput');
            const btnSave = document.getElementById('btnAprendSave');
            const btnSkip = document.getElementById('btnAprendSkip');
            const btnAddNote = document.getElementById('btnAprendAddNote');
            if (!modal) { resolve(null); return; }

            input.value = '';
            btnSave.disabled = true;
            if (btnAddNote) btnAddNote.disabled = true;
            modal.classList.add('show');

            // Auto-focus input after animation
            setTimeout(() => input.focus(), 80);

            const onInput = () => {
                const hasText = input.value.trim().length > 0;
                btnSave.disabled = !hasText;
                if (btnAddNote) btnAddNote.disabled = !hasText;
            };
            input.addEventListener('input', onInput);

            const cleanup = () => {
                modal.classList.remove('show');
                input.removeEventListener('input', onInput);
                btnSave.removeEventListener('click', handleSave);
                btnSkip.removeEventListener('click', handleSkip);
                if (btnAddNote) btnAddNote.removeEventListener('click', handleAddNote);
                document.removeEventListener('keydown', handleKey);
            };

            const handleSave = async () => {
                const text = input.value.trim();
                if (!text) return;
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

            const handleAddNote = async () => {
                const text = input.value.trim();
                if (!text) return;
                cleanup();
                // Append to fixed note "📝 Notas" (same pattern as Concluídos/Bloqueados)
                if (typeof Aprendizados !== 'undefined' && text) {
                    Aprendizados.addToFixedNote(category, itemId, 'notas', text);
                }
                // Also save first line to history with 📝
                const dateStr = this.getDateString();
                const existing = await StorageManager.getItemStatus(dateStr, category, itemId);
                const prevNote = existing.note ? existing.note.trim() : '';
                const notaEntry = `📝 ${text.split('\n')[0]}`;
                const newNote = prevNote ? `${prevNote}\n${notaEntry}` : notaEntry;
                await StorageManager.saveItemStatus(dateStr, category, itemId, 'notas', newNote);
                // Navigate to aprendizados tab
                if (typeof App !== 'undefined') App.showView('aprendizados');
                resolve(text);
            };

            const handleSkip = () => { cleanup(); resolve(null); };

            // Enter adds new line in textarea; only Escape triggers skip
            const handleKey = (e) => {
                if (e.key === 'Escape') handleSkip();
            };

            btnSave.addEventListener('click', handleSave);
            btnSkip.addEventListener('click', handleSkip);
            if (btnAddNote) btnAddNote.addEventListener('click', handleAddNote);
            document.addEventListener('keydown', handleKey);
        });
    },

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
    },

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
    },

});
