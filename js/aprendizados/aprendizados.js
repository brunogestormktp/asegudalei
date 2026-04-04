// ============================================
// APRENDIZADOS.JS — Sistema de Notas v2
// Estrutura: Categorias → Itens → Notas (múltiplas por item)
// ============================================

const Aprendizados = (() => {
    const STORAGE_KEY = 'aprendizadosData';
    const SYNC_DEBOUNCE = 800;

    // ─── Estado de navegação ─────────────────────────────────────────
    const nav = {
        level: 'folders',       // 'folders' | 'notes' | 'editor'
        category: null,         // 'clientes' | 'categorias' | 'atividades' | '__recent__'
        itemId: null,
        noteId: null,
    };

    const NAV_KEY = '_aprendizadosNav';

    function saveNav() {
        try {
            localStorage.setItem(NAV_KEY, JSON.stringify({
                level:    nav.level,
                category: nav.category,
                itemId:   nav.itemId,
                // noteId não persiste — usuário volta à lista de notas, não direto ao editor
            }));
        } catch(e) {}
    }

    function restoreNav() {
        try {
            const raw = localStorage.getItem(NAV_KEY);
            if (raw) {
                const saved = JSON.parse(raw);
                nav.level    = saved.level    || 'notes';
                nav.category = saved.category || '__recent__';
                nav.itemId   = saved.itemId   || null;
                nav.noteId   = null; // nunca restaurar diretamente no editor
            } else {
                // Primeiro acesso: abrir em Recentes
                nav.level    = 'notes';
                nav.category = '__recent__';
                nav.itemId   = null;
                nav.noteId   = null;
            }
        } catch(e) {
            nav.level    = 'notes';
            nav.category = '__recent__';
        }
    }

    let _syncTimer = null;
    let _noteSaveTimer = null;
    let _editorMode = 'lines'; // 'lines' | 'text'
    let _pendingOpenNav = null; // nav a aplicar na próxima chamada de onShow

    // ─── Configurações de categoria ──────────────────────────────────
    const CATEGORY_COLORS = {
        clientes:   '#95d3ee',
        categorias: '#6bb8d9',
        atividades: '#4a9cc4',
    };

    // Dinâmico: reflete renomeações feitas na aba Configurações
    function getCategoryLabels() {
        const defaults = {
            clientes:   '👥 Clientes',
            categorias: '🏢 Empresa',
            atividades: '👤 Pessoal',
        };
        try {
            const s = (typeof StorageManager !== 'undefined') ? StorageManager.getSettings() : null;
            if (!s?.categoryLabels) return defaults;
            return {
                clientes:   s.categoryLabels.clientes   || defaults.clientes,
                categorias: s.categoryLabels.categorias || defaults.categorias,
                atividades: s.categoryLabels.atividades || defaults.atividades,
            };
        } catch(e) { return defaults; }
    }

    // ─── Helpers ─────────────────────────────────────────────────────
    function nowISO() { return new Date().toISOString(); }
    function uuid() {
        return 'n-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    }
    function formatDate(iso) {
        if (!iso) return '';
        const d = new Date(iso);
        return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
    }
    function formatRelative(iso) {
        if (!iso) return '';
        const d = new Date(iso);
        const diff = Math.floor((Date.now() - d) / 1000);
        if (diff < 60) return 'agora';
        if (diff < 3600) return `${Math.floor(diff / 60)}min`;
        if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
        const days = Math.floor(diff / 86400);
        if (days < 7) return `${days}d`;
        return formatDate(iso);
    }
    function getLocalDateString() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    }
    function escHtml(s) {
        return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }
    function escAttr(s) {
        return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }
    function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
    function highlight(text, term) {
        if (!term) return escHtml(text);
        const re = new RegExp(escapeRe(term), 'gi');
        return escHtml(text).replace(re, m => `<mark class="aprend-hl">${m}</mark>`);
    }

    // ─── Storage ─────────────────────────────────────────────────────
    function loadAll() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            return raw ? JSON.parse(raw) : {};
        } catch { return {}; }
    }

    function saveAllSync(data) {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch(e) { console.warn(e); }
        if (typeof StorageManager !== 'undefined') {
            // Push imediato: notas de Aprendizados devem chegar ao Supabase o mais rápido
            // possível para que outros dispositivos recebam via Realtime/polling.
            // Usamos debounce curto (300ms) apenas para agrupar edições em rajada
            // (ex: digitação rápida), mas bem menor que os 800ms anteriores.
            clearTimeout(_syncTimer);
            _syncTimer = setTimeout(() => StorageManager.saveAprendizados(data), 300);
        }
    }

    async function syncFromSupabase() {
        if (typeof StorageManager === 'undefined') return;
        try {
            const remote = await StorageManager.getAprendizados();
            const local = loadAll();
            if (!remote) {
                if (Object.keys(local).length > 0) await StorageManager.saveAprendizados(local);
                return;
            }
            const merged = mergeAll(local, remote);
            localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
            if (JSON.stringify(merged) !== JSON.stringify(remote)) {
                await StorageManager.saveAprendizados(merged);
            }
        } catch(e) { console.warn('Aprendizados sync error:', e); }
    }

    // Merge profundo: por categoria → item → nota (por updatedAt)
    function mergeAll(local, remote) {
        const result = JSON.parse(JSON.stringify(local));
        for (const cat of Object.keys(remote)) {
            if (!result[cat]) { result[cat] = remote[cat]; continue; }
            for (const itemId of Object.keys(remote[cat])) {
                const rItem = remote[cat][itemId];
                const lItem = result[cat][itemId];
                if (!lItem) { result[cat][itemId] = rItem; continue; }
                result[cat][itemId] = mergeItem(lItem, rItem);
            }
        }
        return result;
    }

    function mergeItem(local, remote) {
        const lNotes = normalizeToNotes(local);
        const rNotes = normalizeToNotes(remote);
        const map = {};
        for (const n of lNotes) map[n.id] = n;
        for (const n of rNotes) {
            if (!map[n.id]) { map[n.id] = n; continue; }
            const lTs = map[n.id].updatedAt ? new Date(map[n.id].updatedAt).getTime() : 0;
            const rTs = n.updatedAt ? new Date(n.updatedAt).getTime() : 0;
            if (rTs > lTs) map[n.id] = n;
            // Empate: tombstone tem prioridade para evitar ressurreição
            else if (rTs === lTs && n.deleted && !map[n.id].deleted) map[n.id] = n;
        }
        return { notes: Object.values(map).sort((a,b) => (b.updatedAt||'').localeCompare(a.updatedAt||'')) };
    }

    // Migrar formato legado (nota única) para array de notas
    function normalizeToNotes(item) {
        if (!item) return [];
        if (Array.isArray(item.notes)) return item.notes;
        if (typeof item.content !== 'undefined' || typeof item.checkedLines !== 'undefined') {
            const content = item.content || '';
            if (!content.trim()) return [];
            return [{
                id: uuid(),
                title: _titleFromContent(content),
                content,
                checkedLines: item.checkedLines || {},
                attachments: [],
                createdAt: item.updatedAt || nowISO(),
                updatedAt: item.updatedAt || nowISO(),
            }];
        }
        return [];
    }

    function _titleFromContent(content) {
        const first = (content || '').split('\n').find(l => l.trim() !== '');
        if (!first) return 'Sem título';
        return first.replace(/^[\-\*\[\]x\s]+/, '').trim().slice(0, 60) || 'Sem título';
    }

    // ─── Acesso a notas ───────────────────────────────────────────────
    function getItemNotes(category, itemId) {
        const all = loadAll();
        // Filtrar tombstones (deleted:true) — existem no storage para propagação
        // do merge entre dispositivos, mas nunca devem ser exibidos.
        return normalizeToNotes(all[category]?.[itemId]).filter(n => !n.deleted);
    }

    function getNote(category, itemId, noteId) {
        return getItemNotes(category, itemId).find(n => n.id === noteId) || null;
    }

    function saveNote(category, itemId, note) {
        const all = loadAll();
        if (!all[category]) all[category] = {};
        if (!all[category][itemId] || !Array.isArray(all[category][itemId].notes)) {
            all[category][itemId] = { notes: normalizeToNotes(all[category][itemId]) };
        }
        const idx = all[category][itemId].notes.findIndex(n => n.id === note.id);
        if (idx >= 0) {
            all[category][itemId].notes[idx] = note;
        } else {
            all[category][itemId].notes.unshift(note);
        }
        saveAllSync(all);
        _updateAprendBtnInDOM(category, itemId, all);
        _refreshDropdownIfOpen(category, itemId);
    }

    function deleteNote(category, itemId, noteId) {
        const all = loadAll();
        if (!all[category]?.[itemId]) return;
        // Tombstone: marca como deletada em vez de remover do array.
        // Isso garante que a exclusão se propague via merge para outros dispositivos.
        // O campo deleted:true + deletedAt são usados pelo merge para resolver conflitos.
        const notes = normalizeToNotes(all[category][itemId]);
        const idx = notes.findIndex(n => n.id === noteId);
        if (idx >= 0) {
            notes[idx] = { ...notes[idx], deleted: true, deletedAt: nowISO(), updatedAt: nowISO() };
            all[category][itemId] = { notes };
        }
        saveAllSync(all);
        _updateAprendBtnInDOM(category, itemId, all);
        _refreshDropdownIfOpen(category, itemId);
    }

    // Pede ao App para atualizar o dropdown se estiver aberto para este item
    function _refreshDropdownIfOpen(category, itemId) {
        try {
            if (typeof window.app !== 'undefined' && typeof window.app.refreshItemAprendDropdown === 'function') {
                window.app.refreshItemAprendDropdown(category, itemId);
            }
        } catch(e) { console.warn('[Aprendizados] refreshDropdown error:', e); }
    }

    // Atualiza a classe has-notes no botão 📚 do item no clientesList/DOM
    function _updateAprendBtnInDOM(category, itemId, allData) {
        try {
            const btn = document.querySelector(`[data-category="${category}"][data-item-id="${itemId}"] .btn-aprend-item`);
            if (!btn) return;
            const entry = allData?.[category]?.[itemId];
            // Considera "tem notas" apenas se houver ao menos uma nota com conteúdo não-vazio
            const notes = Array.isArray(entry?.notes) ? entry.notes : [];
            const hasNotes = notes.some(n => n.content && n.content.trim().length > 0)
                || !!(entry?.content && entry.content.trim());
            btn.classList.toggle('has-notes', hasNotes);
        } catch {}
    }

    function createNewNote(category, itemId) {
        const note = {
            id: uuid(),
            title: '',
            content: '',
            checkedLines: {},
            attachments: [],
            createdAt: nowISO(),
            updatedAt: nowISO(),
        };
        saveNote(category, itemId, note);
        return note;
    }

    // setLineChecked — API pública, compatível com app.js
    // noteId opcional: se fornecido marca na nota específica, senão usa a primeira
    function setLineChecked(category, itemId, lineIndex, checked, noteId) {
        const notes = getItemNotes(category, itemId);
        if (notes.length === 0) return;
        const note = noteId
            ? (notes.find(n => n.id === noteId) || notes[0])
            : notes[0];
        if (!note.checkedLines) note.checkedLines = {};
        if (checked) note.checkedLines[lineIndex] = true;
        else delete note.checkedLines[lineIndex];
        note.updatedAt = nowISO();
        saveNote(category, itemId, note);

        // Se o editor desta nota está aberto, atualizar visual da linha
        if (nav.noteId === note.id && nav.category === category && nav.itemId === itemId) {
            const rows = Array.from(document.querySelectorAll('#aprendLineRows .aprend-line-row'));
            const row = rows[lineIndex];
            if (row) {
                const checkBtn = row.querySelector('.aprend-line-check-btn');
                if (checked) {
                    row.classList.add('checked');
                    if (checkBtn) {
                        checkBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8"><polyline points="20 6 9 17 4 12"/></svg>`;
                        checkBtn.title = 'Marcado — clique para desmarcar';
                    }
                } else {
                    row.classList.remove('checked');
                    if (checkBtn) {
                        checkBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/></svg>`;
                        checkBtn.title = 'Marcar e enviar para Hoje';
                    }
                }
            }
        }
    }

    // ─── Contadores ───────────────────────────────────────────────────
    function countNotes(category, itemId) {
        return getItemNotes(category, itemId).length;
    }
    function countCategoryNotes(category) {
        const all = loadAll();
        return (APP_DATA[category] || []).reduce((acc, item) =>
            acc + normalizeToNotes(all[category]?.[item.id]).filter(n => !n.deleted).length, 0);
    }
    function getPreview(content) {
        if (!content) return '';
        return content.replace(/^[\s\-\*\[\]xX]+/gm, '').replace(/\n+/g, ' ').trim().slice(0, 80);
    }

    // ─── Texto puro ───────────────────────────────────────────────────
    function getPlainText(el) {
        const clone = el.cloneNode(true);
        clone.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
        clone.querySelectorAll('div').forEach(div => { div.prepend('\n'); div.replaceWith(...div.childNodes); });
        return clone.textContent;
    }
    function setPlainText(el, text) { el.textContent = text; }

    // Remove linhas em branco/vazias de um texto — mantém apenas linhas com conteúdo
    function _stripBlankLines(text) {
        if (!text) return '';
        return text.split('\n').filter(l => l.trim() !== '').join('\n');
    }

    // ─── RENDER: Nível 1 — Pastas ────────────────────────────────────
    function renderFolders() {
        const el = document.getElementById('aprendFolderList');
        if (!el) return;

        // Pasta especial "Recentes"
        const totalNotes  = countAllNotes();
        const isRecActive = nav.category === '__recent__';
        const recentHtml  = `
            <div class="aprend-folder-row${isRecActive ? ' active' : ''}" data-category="__recent__">
                <div class="aprend-folder-icon" style="color:#b0c4de">
                    🕐
                </div>
                <div class="aprend-folder-info">
                    <span class="aprend-folder-name">Recentes</span>
                    ${totalNotes > 0 ? `<span class="aprend-folder-count">${totalNotes}</span>` : ''}
                </div>
                <svg class="aprend-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#b0c4de" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
            </div>
            <div class="aprend-folder-sep"></div>`;

        const groups = [
            { key: 'clientes',   icon: '👥' },
            { key: 'categorias', icon: '🏢' },
            { key: 'atividades', icon: '👤' },
        ];
        const categoriesHtml = groups.map(({ key, icon }) => {
            const count = countCategoryNotes(key);
            const label = getCategoryLabels()[key].replace(/^\S+\s/, '');
            const color = CATEGORY_COLORS[key];
            const isActive = nav.category === key;
            return `
            <div class="aprend-folder-row${isActive ? ' active' : ''}" data-category="${key}">
                <div class="aprend-folder-icon" style="color:${color}">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" opacity="0.85">
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                    </svg>
                </div>
                <div class="aprend-folder-info">
                    <span class="aprend-folder-name">${icon} ${label}</span>
                    ${count > 0 ? `<span class="aprend-folder-count">${count}</span>` : ''}
                </div>
                <svg class="aprend-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
            </div>
            <div class="aprend-folder-sep"></div>`;
        }).join('');

        el.innerHTML = recentHtml + categoriesHtml;

        el.querySelectorAll('.aprend-folder-row').forEach(row => {
            row.addEventListener('click', () => {
                nav.category = row.dataset.category;
                nav.itemId   = null;
                nav.noteId   = null;
                saveNav();
                if (nav.category === '__recent__') {
                    renderFolders();
                    renderRecentNotes();
                    navigateTo('notes');
                } else {
                    renderFolders();
                    renderSubfolders();
                    navigateTo('notes');
                }
            });
        });
    }

    // ─── RENDER: Nível 2 — Subpastas / Lista de notas ────────────────
    function renderSubfolders() {
        const el    = document.getElementById('aprendNotesList');
        const title = document.getElementById('aprendNotesTitle');
        const btnNew = document.getElementById('aprendBtnNewNote');
        if (!el || !nav.category) return;

        if (nav.itemId) {
            // Mostrar lista de notas do item
            const item = (APP_DATA[nav.category] || []).find(i => i.id === nav.itemId);
            if (title && item) title.textContent = item.name.replace(/^✅\s*/, '');
            if (btnNew) btnNew.classList.remove('hidden');
            renderNotesList();
            return;
        }

        // Mostrar subpastas (itens)
        if (title) title.textContent = getCategoryLabels()[nav.category].replace(/^\S+\s/, '');
        if (btnNew) btnNew.classList.add('hidden');
        const color = CATEGORY_COLORS[nav.category];
        const items = APP_DATA[nav.category] || [];

        el.innerHTML = items.map(item => {
            const count = countNotes(nav.category, item.id);
            const cleanName = item.name.replace(/^✅\s*/, '');
            return `
            <div class="aprend-subfolder-row" data-item-id="${item.id}" data-item-name="${escHtml(item.name)}">
                <div class="aprend-subfolder-icon" style="color:${color}">
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" opacity="0.7">
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                    </svg>
                </div>
                <div class="aprend-subfolder-info">
                    <span class="aprend-subfolder-name">${escHtml(cleanName)}</span>
                    ${count > 0 ? `<span class="aprend-folder-count">${count}</span>` : ''}
                </div>
                <svg class="aprend-chevron" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
            </div>`;
        }).join('');

        el.querySelectorAll('.aprend-subfolder-row').forEach(row => {
            row.addEventListener('click', () => {
                nav.itemId = row.dataset.itemId;
                saveNav();
                const item = (APP_DATA[nav.category] || []).find(i => i.id === nav.itemId);
                if (title && item) title.textContent = item.name.replace(/^✅\s*/, '');
                if (btnNew) btnNew.classList.remove('hidden');
                renderNotesList();
                if (window.innerWidth <= 768) navigateTo('notes');
            });
        });
    }

    // ─── RENDER: Lista de notas ───────────────────────────────────────
    function renderNotesList() {
        const el = document.getElementById('aprendNotesList');
        if (!el || !nav.category || !nav.itemId) return;

        const notes = getItemNotes(nav.category, nav.itemId);
        if (notes.length === 0) {
            el.innerHTML = `<div class="aprend-notes-empty">Nenhuma nota ainda.<br>Toque em <b>+</b> para criar.</div>`;
            return;
        }

        el.innerHTML = notes.map(note => {
            const titleStr  = note.title || 'Sem título';
            const preview   = getPreview(note.content);
            const dateStr   = formatDate(note.updatedAt);
            const hasAttach = (note.attachments || []).length > 0;
            const isSelected = nav.noteId === note.id;
            const isAprend  = note.type === 'aprendizado';
            return `
            <div class="aprend-note-card${isSelected ? ' selected' : ''}${isAprend ? ' aprend-note-card--aprendizado' : ''}" data-note-id="${note.id}">
                <div class="aprend-note-card-top">
                    <span class="aprend-note-title">${escHtml(titleStr)}</span>
                    <span class="aprend-note-date">${dateStr}</span>
                </div>
                ${isAprend ? '<div class="aprend-type-badge">🧠 aprendizado</div>' : ''}
                <div class="aprend-note-preview">${escHtml(preview)}${hasAttach ? ' 📎' : ''}</div>
            </div>`;
        }).join('');

        el.querySelectorAll('.aprend-note-card').forEach(card => {
            card.addEventListener('click', () => {
                _flushNote();
                nav.noteId = card.dataset.noteId;
                saveNav();
                renderNotesList();
                renderEditor();
                navigateTo('editor');
            });
        });
    }

    // ─── Conta todas as notas do app ─────────────────────────────────
    function countAllNotes() {
        const all = loadAll();
        let total = 0;
        ['clientes', 'categorias', 'atividades'].forEach(cat => {
            (APP_DATA[cat] || []).forEach(item => {
                total += normalizeToNotes(all[cat]?.[item.id]).filter(n => !n.deleted).length;
            });
        });
        return total;
    }

    // ─── RENDER: Notas Recentes (todas as categorias, mais recente primeiro) ─
    function renderRecentNotes() {
        const el    = document.getElementById('aprendNotesList');
        const title = document.getElementById('aprendNotesTitle');
        const btnNew = document.getElementById('aprendBtnNewNote');
        if (!el) return;

        if (title) title.textContent = 'Recentes';
        if (btnNew) btnNew.classList.add('hidden');

        const all  = loadAll();
        const hits = [];

        ['clientes', 'categorias', 'atividades'].forEach(cat => {
            (APP_DATA[cat] || []).forEach(item => {
                normalizeToNotes(all[cat]?.[item.id]).filter(n => !n.deleted).forEach(note => {
                    hits.push({ note, cat, itemId: item.id, itemName: item.name });
                });
            });
        });

        // Ordenar por updatedAt desc
        hits.sort((a, b) => {
            const ta = a.note.updatedAt ? new Date(a.note.updatedAt).getTime() : 0;
            const tb = b.note.updatedAt ? new Date(b.note.updatedAt).getTime() : 0;
            return tb - ta;
        });

        if (!hits.length) {
            el.innerHTML = '<div class="aprend-notes-empty">Nenhuma nota ainda.</div>';
            return;
        }

        el.innerHTML = hits.map(({ note, cat, itemId, itemName }) => {
            const cleanName = itemName.replace(/^✅\s*/, '');
            const catLabel  = getCategoryLabels()[cat].replace(/^\S+\s/, '');
            const preview   = getPreview(note.content);
            const dateStr   = formatRelative(note.updatedAt);
            const hasAttach = (note.attachments || []).length > 0;
            const isAprend  = note.type === 'aprendizado';
            return `
            <div class="aprend-note-card${isAprend ? ' aprend-note-card--aprendizado' : ''}" data-note-id="${escHtml(note.id)}" data-cat="${cat}" data-item-id="${escHtml(itemId)}">
                <div class="aprend-note-card-top">
                    <span class="aprend-note-title">${escHtml(note.title || 'Sem título')}</span>
                    <span class="aprend-note-date">${dateStr}</span>
                </div>
                <div class="aprend-note-breadcrumb" style="font-size:0.7rem;opacity:0.55;margin:1px 0 3px;">${escHtml(catLabel)} › ${escHtml(cleanName)}</div>
                ${isAprend ? '<div class="aprend-type-badge">🧠 aprendizado</div>' : ''}
                <div class="aprend-note-preview">${escHtml(preview)}${hasAttach ? ' 📎' : ''}</div>
            </div>`;
        }).join('');

        el.querySelectorAll('.aprend-note-card').forEach(card => {
            card.addEventListener('click', () => {
                _flushNote();
                nav.category = card.dataset.cat;
                nav.itemId   = card.dataset.itemId;
                nav.noteId   = card.dataset.noteId;
                saveNav();
                renderFolders();
                renderSubfolders();
                renderNotesList();
                renderEditor();
                navigateTo('editor');
            });
        });
    }

    // ─── RENDER: Editor ───────────────────────────────────────────────
    function renderEditor() {
        _closeViewer(); // fecha viewer ao trocar de nota
        const panel = document.getElementById('aprendEditorPanel');
        if (!panel) return;

        if (!nav.noteId || !nav.category || !nav.itemId) {
            panel.innerHTML = `
                <div class="aprend-editor-empty">
                    <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.2">
                        <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
                    </svg>
                    <span>Selecione ou crie uma nota</span>
                </div>`;
            return;
        }

        const note = getNote(nav.category, nav.itemId, nav.noteId);
        if (!note) { nav.noteId = null; renderEditor(); return; }

        panel.innerHTML = `
        <div class="aprend-editor-wrap">
            <div class="aprend-editor-header">
                <button class="aprend-editor-back" id="aprendEditorBack">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>
                </button>
                <input type="text" class="aprend-editor-title-input" id="aprendNoteTitle"
                    value="${escHtml(note.title || '')}"
                    placeholder="Sem título" spellcheck="true" maxlength="120" />
            </div>

            <div class="aprend-editor-meta">
                Criado ${escHtml(formatDate(note.createdAt))} · Editado ${escHtml(formatRelative(note.updatedAt))}
            </div>

            <div class="aprend-editor-toolbar">
                <button class="aprend-toolbar-btn" id="aprendBtnAttach" title="Anexar arquivo">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
                    </svg>
                </button>
                <button class="aprend-toolbar-btn aprend-btn-camera" id="aprendBtnCamera" title="Câmera" style="${('ontouchstart' in window || navigator.maxTouchPoints > 0) ? '' : 'display:none'}">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>
                    </svg>
                </button>
                <div class="aprend-toolbar-sep"></div>
                <button class="aprend-toolbar-btn" id="aprendBtnImportToday" title="Importar tudo para hoje">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/>
                    </svg>
                </button>
                <button class="aprend-toolbar-btn aprend-btn-mode-toggle${_editorMode === 'text' ? ' active' : ''}" id="aprendBtnToggleMode" title="${_editorMode === 'text' ? 'Modo linhas (com marcação)' : 'Modo texto livre'}">
                    ${_editorMode === 'text'
                        ? `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="12" r="1.5"/><line x1="14" y1="12" x2="20" y2="12"/><circle cx="9" cy="6" r="1.5"/><line x1="14" y1="6" x2="20" y2="6"/><circle cx="9" cy="18" r="1.5"/><line x1="14" y1="18" x2="20" y2="18"/></svg>`
                        : `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="14" y2="18"/></svg>`
                    }
                </button>
                <button class="aprend-toolbar-btn" id="aprendBtnCopyAll" title="Copiar tudo">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                    </svg>
                </button>
                <button class="aprend-toolbar-btn aprend-toolbar-btn-danger" id="aprendBtnDeleteNote" title="Apagar nota">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="3 6 5 6 21 6"/>
                        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                        <path d="M10 11v6M14 11v6"/>
                    </svg>
                </button>
            </div>

            <div class="aprend-editor-body" id="aprendEditorBody">
                <div class="aprend-drop-overlay hidden" id="aprendDropOverlay">
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#95d3ee" stroke-width="1.5">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                        <polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
                    </svg>
                    <span>Solte aqui para inserir</span>
                </div>
                <div id="aprendLineRows" class="aprend-line-rows"></div>
                <div id="aprendAttachments"></div>
            </div>

            <input type="file" id="aprendFileInput" accept="*/*" multiple style="display:none" />
            <input type="file" id="aprendCameraInput" accept="image/*" capture="environment" style="display:none" />
        </div>`;

        _buildLineRows(note);
        _renderAttachments(note);
        _bindEditorEvents(note);
        _applyEditorMode(); // aplica modo atual (lines ou text)
    }

    // ─── Toggle modo editor: linhas com checkbox ↔ texto livre ───────
    function _applyEditorMode() {
        const container = document.getElementById('aprendLineRows');
        const btn = document.getElementById('aprendBtnToggleMode');
        if (!container) return;

        if (_editorMode === 'text') {
            container.classList.add('aprend-mode-text');
            // ocultar todos os botões de check
            container.querySelectorAll('.aprend-line-check-btn').forEach(b => b.style.display = 'none');
            if (btn) {
                btn.classList.add('active');
                btn.title = 'Modo linhas (com marcação)';
                btn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="12" r="1.5"/><line x1="14" y1="12" x2="20" y2="12"/><circle cx="9" cy="6" r="1.5"/><line x1="14" y1="6" x2="20" y2="6"/><circle cx="9" cy="18" r="1.5"/><line x1="14" y1="18" x2="20" y2="18"/></svg>`;
            }
        } else {
            container.classList.remove('aprend-mode-text');
            // mostrar todos os botões de check
            container.querySelectorAll('.aprend-line-check-btn').forEach(b => b.style.display = '');
            if (btn) {
                btn.classList.remove('active');
                btn.title = 'Modo texto livre';
                btn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="14" y2="18"/></svg>`;
            }
        }
    }

    function _toggleEditorMode() {
        _syncLinesAndSave();
        _editorMode = _editorMode === 'lines' ? 'text' : 'lines';
        _applyEditorMode();
    }

    // ─── Constrói linhas clicáveis do editor ──────────────────────────
    function _buildLineRows(note) {
        const container = document.getElementById('aprendLineRows');
        if (!container) return;
        container.innerHTML = '';

        // Filtrar linhas em branco — cada linha visível ocupa uma row
        const rawLines = (note.content || '').split('\n');
        const lines = rawLines.filter(l => l.trim() !== '');
        // garante ao menos 1 linha vazia
        if (lines.length === 0) {
            lines.push('');
        }

        lines.forEach((lineText, idx) => {
            container.appendChild(_createLineRow(note, lineText, idx));
        });
    }

    function _createLineRow(note, lineText, idx) {
        const checked = !!(note.checkedLines && note.checkedLines[idx]);
        const row = document.createElement('div');
        row.className = 'aprend-line-row' + (checked ? ' checked' : '');
        row.dataset.idx = idx;

        // Botão check ○ / ✓
        const checkBtn = document.createElement('button');
        checkBtn.className = 'aprend-line-check-btn';
        checkBtn.title = checked ? 'Marcado — clique para desmarcar' : 'Marcar e enviar para Hoje';
        checkBtn.innerHTML = checked
            ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8"><polyline points="20 6 9 17 4 12"/></svg>`
            : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/></svg>`;

        checkBtn.addEventListener('mousedown', (e) => e.preventDefault()); // não tira foco do texto
        checkBtn.addEventListener('click', () => _toggleLineCheck(note, row, idx));

        // Texto editável
        const textEl = document.createElement('div');
        textEl.className = 'aprend-line-text';
        textEl.contentEditable = 'true';
        textEl.spellcheck = true;
        setPlainText(textEl, lineText);

        textEl.addEventListener('input', () => {
            _syncLinesAndSave();
        });

        textEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                // inserir nova linha após esta
                _syncLinesAndSave();
                const allRows = Array.from(document.querySelectorAll('.aprend-line-row'));
                const thisRow = textEl.closest('.aprend-line-row');
                const newRow = _createLineRow(note, '', -1);
                thisRow.after(newRow);
                newRow.querySelector('.aprend-line-text')?.focus();
                _syncLinesAndSave();
            }
            if (e.key === 'Backspace') {
                const text = getPlainText(textEl).replace(/\n/g, '');
                if (text === '') {
                    e.preventDefault();
                    const thisRow = textEl.closest('.aprend-line-row');
                    const prev = thisRow.previousElementSibling;
                    if (prev) {
                        const prevText = prev.querySelector('.aprend-line-text');
                        thisRow.remove();
                        prevText?.focus();
                        // mover cursor para o fim
                        const range = document.createRange();
                        const sel = window.getSelection();
                        range.selectNodeContents(prevText);
                        range.collapse(false);
                        sel.removeAllRanges();
                        sel.addRange(range);
                    }
                    _syncLinesAndSave();
                }
            }
        });

        textEl.addEventListener('paste', (e) => {
            e.preventDefault();
            const text = e.clipboardData.getData('text/plain');
            // Filtrar linhas em branco do texto colado
            const pasteLines = text.split('\n').filter(l => l.trim() !== '');
            if (pasteLines.length === 0) return;
            if (pasteLines.length === 1) {
                document.execCommand('insertText', false, pasteLines[0]);
                return;
            }
            // Multiplas linhas: inserir cada uma como linha nova
            const thisRow = textEl.closest('.aprend-line-row');
            // Primeiro, atualizar o texto da linha atual
            const before = getPlainText(textEl);
            setPlainText(textEl, before + pasteLines[0]);
            let anchor = thisRow;
            for (let i = 1; i < pasteLines.length; i++) {
                const nr = _createLineRow(note, pasteLines[i], -1);
                anchor.after(nr);
                anchor = nr;
            }
            anchor.querySelector('.aprend-line-text')?.focus();
            _syncLinesAndSave();
        });

        row.appendChild(checkBtn);
        row.appendChild(textEl);

        // Botão deletar linha ✕
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'aprend-line-delete-btn';
        deleteBtn.title = 'Apagar esta linha';
        deleteBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
        deleteBtn.addEventListener('mousedown', (e) => e.preventDefault());
        deleteBtn.addEventListener('click', () => {
            const allRows = Array.from(document.querySelectorAll('#aprendLineRows .aprend-line-row'));
            // Não apagar se for a única linha — apenas limpar o conteúdo
            if (allRows.length <= 1) {
                setPlainText(textEl, '');
                textEl.focus();
                _syncLinesAndSave();
                return;
            }
            // Foco vai para a linha anterior, ou próxima se for a primeira
            const prevRow = row.previousElementSibling;
            const nextRow = row.nextElementSibling;
            const focusTarget = prevRow || nextRow;
            row.remove();
            focusTarget?.querySelector('.aprend-line-text')?.focus();
            _syncLinesAndSave();
        });
        row.appendChild(deleteBtn);

        return row;
    }

    // Lê todas as linhas do DOM e salva
    function _syncLinesAndSave() {
        if (!nav.noteId || !nav.category || !nav.itemId) return;
        const note = getNote(nav.category, nav.itemId, nav.noteId);
        if (!note) return;

        const rows = Array.from(document.querySelectorAll('#aprendLineRows .aprend-line-row'));
        const lines = rows.map(r => getPlainText(r.querySelector('.aprend-line-text') || r).replace(/\n/g, ''));

        // Reindexar checkedLines: mapear row original → índice filtrado (sem linhas em branco)
        const newChecked = {};
        let filteredIdx = 0;
        const filteredLines = [];
        rows.forEach((r, i) => {
            if (lines[i].trim() === '') return; // pula linhas vazias
            filteredLines.push(lines[i]);
            if (r.classList.contains('checked')) newChecked[filteredIdx] = true;
            filteredIdx++;
        });

        note.content = filteredLines.join('\n');
        note.checkedLines = newChecked;
        note.updatedAt = nowISO();
        if (!note.title) note.title = _titleFromContent(note.content);

        const titleEl = document.getElementById('aprendNoteTitle');
        if (titleEl?.value?.trim()) note.title = titleEl.value.trim();

        saveNote(nav.category, nav.itemId, note);

        // Atualizar card
        const card = document.querySelector(`.aprend-note-card[data-note-id="${note.id}"]`);
        if (card) {
            const t = card.querySelector('.aprend-note-title');
            const p = card.querySelector('.aprend-note-preview');
            if (t) t.textContent = note.title || 'Sem título';
            if (p) p.textContent = getPreview(note.content);
        }
        renderFolders();
    }

    // Toggle check de uma linha: marca verde + envia para Hoje
    async function _toggleLineCheck(note, row, idx) {
        const rows = Array.from(document.querySelectorAll('#aprendLineRows .aprend-line-row'));
        const realIdx = rows.indexOf(row);
        const effectiveIdx = realIdx >= 0 ? realIdx : idx;

        const fresh = getNote(nav.category, nav.itemId, nav.noteId);
        if (!fresh) return;

        const wasChecked = !!(fresh.checkedLines && fresh.checkedLines[effectiveIdx]);
        const newChecked = !wasChecked;

        // Atualizar storage
        if (!fresh.checkedLines) fresh.checkedLines = {};
        if (newChecked) fresh.checkedLines[effectiveIdx] = true;
        else delete fresh.checkedLines[effectiveIdx];
        fresh.updatedAt = nowISO();
        saveNote(nav.category, nav.itemId, fresh);

        // Atualizar visual da linha
        const checkBtn = row.querySelector('.aprend-line-check-btn');
        if (newChecked) {
            row.classList.add('checked');
            checkBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8"><polyline points="20 6 9 17 4 12"/></svg>`;
            checkBtn.title = 'Marcado — clique para desmarcar';
        } else {
            row.classList.remove('checked');
            checkBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/></svg>`;
            checkBtn.title = 'Marcar e enviar para Hoje';
        }

        // Se marcou: enviar linha para a nota do item em Hoje
        if (newChecked) {
            const lineText = getPlainText(row.querySelector('.aprend-line-text')).replace(/\n/g, '').trim();
            if (lineText) await _adicionarLinhaHoje(lineText);
        }
    }

    // Adiciona uma linha à nota do item na aba Hoje
    async function _adicionarLinhaHoje(lineText) {
        if (!nav.category || !nav.itemId || !lineText) return;
        try {
            const dateStr = _todayStr();
            const existing = await StorageManager.getItemStatus(dateStr, nav.category, nav.itemId);
            const currentNote = existing.note || '';
            const alreadyIn = currentNote.split('\n').some(l => l.trim() === lineText.trim());
            const newNote = alreadyIn ? currentNote : (currentNote ? currentNote + '\n' + lineText : lineText);
            await StorageManager.saveItemStatus(dateStr, nav.category, nav.itemId, existing.status || 'none', newNote);
            _showToast(`✓ "${lineText.slice(0, 32)}${lineText.length > 32 ? '…' : ''}" → Hoje`, true, 2000);
        } catch(e) {
            console.error(e);
            _showToast('Erro ao enviar para hoje.', false);
        }
    }

    function _todayStr() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    }

    // ─── Eventos do editor ────────────────────────────────────────────
    function _bindEditorEvents(note) {
        const body = document.getElementById('aprendEditorBody');

        // Voltar
        document.getElementById('aprendEditorBack')?.addEventListener('click', () => {
            _syncLinesAndSave();
            renderNotesList();
            navigateTo('notes');
        });

        // Título
        document.getElementById('aprendNoteTitle')?.addEventListener('input', () => _syncLinesAndSave());
        document.getElementById('aprendNoteTitle')?.addEventListener('blur',  () => _syncLinesAndSave());

        // Drag & drop de arquivos
        body?.addEventListener('dragover', (e) => {
            e.preventDefault();
            document.getElementById('aprendDropOverlay')?.classList.remove('hidden');
        });
        body?.addEventListener('dragleave', () => {
            document.getElementById('aprendDropOverlay')?.classList.add('hidden');
        });
        body?.addEventListener('drop', (e) => {
            e.preventDefault();
            document.getElementById('aprendDropOverlay')?.classList.add('hidden');
            for (const file of e.dataTransfer.files) _insertFile(file);
        });

        // Toolbar — anexo e câmera
        document.getElementById('aprendBtnAttach')?.addEventListener('click', () =>
            document.getElementById('aprendFileInput')?.click());
        document.getElementById('aprendFileInput')?.addEventListener('change', (e) => {
            for (const file of e.target.files) _insertFile(file);
            e.target.value = '';
        });
        document.getElementById('aprendBtnCamera')?.addEventListener('click', () =>
            document.getElementById('aprendCameraInput')?.click());
        document.getElementById('aprendCameraInput')?.addEventListener('change', (e) => {
            for (const file of e.target.files) _insertFile(file);
            e.target.value = '';
        });

        // Importar todas as linhas para hoje
        document.getElementById('aprendBtnImportToday')?.addEventListener('click', () => {
            _syncLinesAndSave();
            _importarParaHoje();
        });

        // Toggle modo linhas ↔ texto
        document.getElementById('aprendBtnToggleMode')?.addEventListener('click', () => {
            _toggleEditorMode();
        });

        // Copiar todo o texto da nota
        document.getElementById('aprendBtnCopyAll')?.addEventListener('click', () => {
            _copyAllNoteText();
        });

        // Apagar nota (com confirmação inline no botão)
        document.getElementById('aprendBtnDeleteNote')?.addEventListener('click', () => {
            _confirmDeleteNote();
        });
    }

    // ─── Save — compatibilidade com código que chama _flushNote ──────
    function _scheduleNoteSave() { _syncLinesAndSave(); }
    function _flushNote()        { _syncLinesAndSave(); }

    // ─── Copiar todo o texto da nota ─────────────────────────────────
    function _copyAllNoteText() {
        _syncLinesAndSave();
        const note = getNote(nav.category, nav.itemId, nav.noteId);
        if (!note || !note.content || !note.content.trim()) {
            _showToast('Nota vazia — nada para copiar.', false);
            return;
        }

        const textToCopy = note.content;

        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            navigator.clipboard.writeText(textToCopy).then(() => {
                _showToast('✓ Texto copiado!', true, 2000);
            }).catch(() => {
                _copyFallback(textToCopy);
            });
        } else {
            _copyFallback(textToCopy);
        }
    }

    function _copyFallback(text) {
        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.setAttribute('readonly', '');
            ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            _showToast('✓ Texto copiado!', true, 2000);
        } catch (e) {
            _showToast('Não foi possível copiar.', false);
        }
    }

    // ─── Attachments ─────────────────────────────────────────────────
    async function _insertFile(file) {
        const attachType = file.type.startsWith('image/') ? 'image'
            : file.type.startsWith('video/') ? 'video'
            : file.type === 'application/pdf' ? 'pdf' : 'file';

        const attachId = uuid();
        const attach = {
            id:        attachId,
            type:      attachType,
            name:      file.name,
            size:      file.size,
            status:    'uploading',
            createdAt: nowISO(),
        };

        // Inserir imediatamente com skeleton de loading
        const fresh = getNote(nav.category, nav.itemId, nav.noteId);
        if (!fresh) return;
        if (!fresh.attachments) fresh.attachments = [];
        fresh.attachments.push(attach);
        fresh.updatedAt = nowISO();
        saveNote(nav.category, nav.itemId, fresh);
        _renderAttachments(fresh);

        // Upload para Supabase Storage
        let publicUrl = null;
        if (typeof StorageManager !== 'undefined') {
            publicUrl = await StorageManager.uploadNoteFile(file, nav.noteId, attachId);
        }

        // Re-ler nota após await (pode ter sido editada)
        const note = getNote(nav.category, nav.itemId, nav.noteId);
        if (!note) return;
        const idx = (note.attachments || []).findIndex(a => a.id === attachId);
        if (idx === -1) return; // deletado durante upload

        if (publicUrl) {
            note.attachments[idx] = { ...note.attachments[idx], url: publicUrl };
            delete note.attachments[idx].status;
        } else {
            // Fallback: base64 (offline ou erro)
            await new Promise((resolve) => {
                const reader = new FileReader();
                reader.onload = (ev) => {
                    const n2 = getNote(nav.category, nav.itemId, nav.noteId);
                    if (!n2) { resolve(); return; }
                    const i2 = (n2.attachments || []).findIndex(a => a.id === attachId);
                    if (i2 === -1) { resolve(); return; }
                    n2.attachments[i2] = { ...n2.attachments[i2], data: ev.target.result };
                    delete n2.attachments[i2].status;
                    n2.updatedAt = nowISO();
                    saveNote(nav.category, nav.itemId, n2);
                    _renderAttachments(n2);
                    resolve();
                };
                reader.onerror = () => resolve();
                reader.readAsDataURL(file);
            });
            return; // saveNote + render já chamados
        }

        note.updatedAt = nowISO();
        saveNote(nav.category, nav.itemId, note);
        _renderAttachments(note);
    }

    // ─── Viewer State ────────────────────────────────────────────────
    const _viewer = {
        open: false,
        attachments: [],
        index: 0,
        noteCtx: null,   // { category, itemId, noteId }
        notesDirty: false
    };

    function _openViewer(attachments, index, noteCtx) {
        _viewer.open = true;
        _viewer.attachments = attachments;
        _viewer.index = index;
        _viewer.noteCtx = noteCtx;
        _viewer.notesDirty = false;

        const el = document.getElementById('aprendViewer');
        if (!el) return;
        el.classList.remove('hidden');
        document.addEventListener('keydown', _viewerKeyHandler);
        _renderViewerSlide(_viewer.index);
    }

    function _closeViewer() {
        if (!_viewer.open) return;
        // Pause any playing video
        const stage = document.getElementById('aprendViewerStage');
        if (stage) {
            const vid = stage.querySelector('video');
            if (vid) { vid.pause(); vid.src = ''; }
        }
        // Save dirty note
        if (_viewer.notesDirty) _saveViewerNote();

        _viewer.open = false;
        _viewer.attachments = [];
        _viewer.noteCtx = null;
        _viewer.notesDirty = false;

        const el = document.getElementById('aprendViewer');
        if (el) el.classList.add('hidden');
        document.removeEventListener('keydown', _viewerKeyHandler);
    }

    function _renderViewerSlide(index) {
        const a = _viewer.attachments[index];
        if (!a) return;
        _viewer.index = index;

        const src = a.url || a.data || '';
        const sizeStr = a.size > 1024 * 1024
            ? `${(a.size / 1024 / 1024).toFixed(1)} MB`
            : `${Math.round(a.size / 1024)} KB`;
        const dateStr = a.createdAt
            ? new Date(a.createdAt).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' })
            : '';

        // Header
        const nameEl = document.getElementById('aprendViewerName');
        const infoEl = document.getElementById('aprendViewerInfo');
        if (nameEl) nameEl.textContent = a.name || 'Arquivo';
        if (infoEl) infoEl.textContent = [sizeStr, dateStr].filter(Boolean).join(' · ');

        // Download link
        const dlEl = document.getElementById('aprendViewerDl');
        if (dlEl) {
            dlEl.href = src;
            dlEl.download = a.name || 'arquivo';
        }

        // Navigation arrows
        const prevBtn = document.getElementById('aprendViewerPrev');
        const nextBtn = document.getElementById('aprendViewerNext');
        if (prevBtn) prevBtn.classList.toggle('hidden', index === 0);
        if (nextBtn) nextBtn.classList.toggle('hidden', index >= _viewer.attachments.length - 1);

        // Stage content
        const stage = document.getElementById('aprendViewerStage');
        if (!stage) return;
        // Pause previous video if any
        const prevVid = stage.querySelector('video');
        if (prevVid) { prevVid.pause(); prevVid.src = ''; }

        if (a.type === 'image') {
            stage.innerHTML = `<img src="${escAttr(src)}" alt="${escAttr(a.name)}" />`;
            const img = stage.querySelector('img');
            if (img) {
                img.addEventListener('dblclick', () => img.classList.toggle('aprend-viewer-zoomed'));
                img.addEventListener('click', (e) => {
                    if (img.classList.contains('aprend-viewer-zoomed')) {
                        e.stopPropagation();
                        img.classList.remove('aprend-viewer-zoomed');
                    }
                });
            }
        } else if (a.type === 'video') {
            stage.innerHTML = `<video src="${escAttr(src)}" controls autoplay></video>`;
        } else if (a.type === 'pdf') {
            stage.innerHTML = `<iframe src="${escAttr(src)}"></iframe>`;
        } else {
            const icon = '📎';
            stage.innerHTML = `
                <div class="aprend-viewer-stage-generic">
                    <span class="aprend-viewer-stage-generic-icon">${icon}</span>
                    <span class="aprend-viewer-stage-generic-name">${escHtml(a.name)}</span>
                    <a href="${escAttr(src)}" download="${escAttr(a.name)}">⬇ Baixar arquivo</a>
                </div>`;
        }

        // Notes textarea
        const notesEl = document.getElementById('aprendViewerNotes');
        if (notesEl) {
            notesEl.value = a.notes || '';
            _viewer.notesDirty = false;
        }
    }

    function _viewerNavigate(dir) {
        // Save current note if dirty before navigating
        if (_viewer.notesDirty) _saveViewerNote();

        const newIdx = _viewer.index + dir;
        if (newIdx < 0 || newIdx >= _viewer.attachments.length) return;
        _renderViewerSlide(newIdx);
    }

    function _saveViewerNote() {
        const notesEl = document.getElementById('aprendViewerNotes');
        if (!notesEl || !_viewer.noteCtx) return;

        const a = _viewer.attachments[_viewer.index];
        if (!a) return;

        const newNotes = notesEl.value;
        a.notes = newNotes;
        _viewer.notesDirty = false;

        // Persist to storage
        const { category, itemId, noteId } = _viewer.noteCtx;
        const note = getNote(category, itemId, noteId);
        if (!note) return;
        const idx = (note.attachments || []).findIndex(att => att.id === a.id);
        if (idx === -1) return;
        note.attachments[idx].notes = newNotes;
        note.updatedAt = nowISO();
        saveNote(category, itemId, note);
    }

    function _viewerKeyHandler(e) {
        if (!_viewer.open) return;
        // Don't capture keys when typing in textarea
        if (e.target.tagName === 'TEXTAREA') {
            if (e.key === 'Escape') {
                e.preventDefault();
                _closeViewer();
            }
            return;
        }
        if (e.key === 'Escape') { e.preventDefault(); _closeViewer(); }
        else if (e.key === 'ArrowLeft')  { e.preventDefault(); _viewerNavigate(-1); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); _viewerNavigate(+1); }
    }

    // ─── Attachments — Gallery Strip ─────────────────────────────────
    function _renderAttachments(note) {
        const el = document.getElementById('aprendAttachments');
        if (!el) return;
        const attachments = note.attachments || [];
        if (attachments.length === 0) { el.innerHTML = ''; return; }

        // Count visible (non-uploading) files
        const visibleCount = attachments.filter(a => a.status !== 'uploading').length;
        const totalCount = attachments.length;
        const badgeText = totalCount === 1 ? '1 arquivo' : `${totalCount} arquivos`;

        let html = `<div class="aprend-gallery-badge">${badgeText}</div>`;
        html += '<div class="aprend-gallery-strip">';

        html += attachments.map((a, idx) => {
            const isUploading = a.status === 'uploading';
            const uploadingCls = isUploading ? ' aprend-gallery-uploading' : '';
            const src = escAttr(a.url || a.data || '');
            const safeName = escAttr(a.name || '');

            if (isUploading) {
                const icon = a.type === 'image' ? '🖼️'
                    : a.type === 'video' ? '🎬'
                    : a.type === 'pdf' ? '📄' : '📎';
                return `
                <div class="aprend-gallery-tile${uploadingCls}">
                    <div class="aprend-gallery-tile-file">
                        <span class="aprend-gallery-tile-file-icon">${icon}</span>
                        <span class="aprend-gallery-tile-file-name">enviando…</span>
                    </div>
                </div>`;
            }

            if (a.type === 'image') return `
                <div class="aprend-gallery-tile" data-idx="${idx}">
                    <img src="${src}" alt="${safeName}" loading="lazy" />
                    <button class="aprend-gallery-del" data-attach-id="${a.id}" data-attach-url="${escAttr(a.url || '')}" title="Remover">✕</button>
                </div>`;

            if (a.type === 'video') return `
                <div class="aprend-gallery-tile" data-idx="${idx}">
                    <video src="${src}" preload="metadata" muted></video>
                    <div class="aprend-gallery-tile-play">▶</div>
                    <button class="aprend-gallery-del" data-attach-id="${a.id}" data-attach-url="${escAttr(a.url || '')}" title="Remover">✕</button>
                </div>`;

            const icon = a.type === 'pdf' ? '📄' : '📎';
            return `
            <div class="aprend-gallery-tile" data-idx="${idx}">
                <div class="aprend-gallery-tile-file">
                    <span class="aprend-gallery-tile-file-icon">${icon}</span>
                    <span class="aprend-gallery-tile-file-name">${escHtml(a.name)}</span>
                </div>
                <button class="aprend-gallery-del" data-attach-id="${a.id}" data-attach-url="${escAttr(a.url || '')}" title="Remover">✕</button>
            </div>`;
        }).join('');

        html += '</div>';
        el.innerHTML = html;

        // Open viewer on tile click
        el.querySelectorAll('.aprend-gallery-tile[data-idx]').forEach(tile => {
            tile.addEventListener('click', (e) => {
                if (e.target.closest('.aprend-gallery-del')) return;
                const idx = parseInt(tile.dataset.idx, 10);
                // Only open viewer for non-uploading attachments
                const visibleAttachments = attachments.filter(a => a.status !== 'uploading');
                // Map idx to the correct position in filtered list
                const a = attachments[idx];
                if (!a || a.status === 'uploading') return;
                const visIdx = visibleAttachments.indexOf(a);
                _openViewer(visibleAttachments, visIdx >= 0 ? visIdx : 0, {
                    category: nav.category,
                    itemId: nav.itemId,
                    noteId: nav.noteId
                });
            });
        });

        // Delete buttons
        el.querySelectorAll('.aprend-gallery-del').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const attachUrl = btn.dataset.attachUrl;
                if (attachUrl && typeof StorageManager !== 'undefined') {
                    await StorageManager.deleteNoteFile(attachUrl);
                }
                const fresh = getNote(nav.category, nav.itemId, nav.noteId);
                if (!fresh) return;
                fresh.attachments = (fresh.attachments || []).filter(a => a.id !== btn.dataset.attachId);
                fresh.updatedAt = nowISO();
                saveNote(nav.category, nav.itemId, fresh);
                _renderAttachments(fresh);
            });
        });
    }

    // ─── Importar para Hoje ──────────────────────────────────────────
    async function _importarParaHoje() {
        if (!nav.category || !nav.itemId || !nav.noteId) return;
        const note = getNote(nav.category, nav.itemId, nav.noteId);
        if (!note) return;
        const content = note.content?.trim();
        if (!content) { _showToast('Nota vazia — nada para importar.', false); return; }
        try {
            const dateStr = getLocalDateString();
            const existing = await StorageManager.getItemStatus(dateStr, nav.category, nav.itemId);
            const hora = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
            const sep = `\n— de Aprendizados ${hora} —\n`;
            const newNote = existing.note ? existing.note + sep + content : content;
            await StorageManager.saveItemStatus(dateStr, nav.category, nav.itemId, existing.status || 'none', newNote);
            if (typeof app !== 'undefined' && app.currentView === 'today') app.renderTodayView();
            _showToast('✓ Importado para hoje!', true);
        } catch(err) {
            console.error(err);
            _showToast('Erro ao importar.', false);
        }
    }

    // ─── Deletar nota (com confirmação) ──────────────────────────────
    function _confirmDeleteNote() {
        const btn = document.getElementById('aprendBtnDeleteNote');
        if (!btn) return;
        const origHTML = btn.innerHTML;
        const origTitle = btn.title;

        btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`;
        btn.style.color = '#ef4444';
        btn.title = 'Clique para confirmar exclusão';

        const cat = nav.category, itemId = nav.itemId, noteId = nav.noteId;

        const doDelete = () => {
            deleteNote(cat, itemId, noteId);
            nav.noteId = null;
            renderNotesList();
            renderEditor();
            renderFolders();
            navigateTo('notes');
            cleanup();
        };
        const cleanup = () => {
            btn.innerHTML = origHTML;
            btn.style.color = '';
            btn.title = origTitle;
            btn.removeEventListener('click', doDelete);
            clearTimeout(t);
        };
        const t = setTimeout(cleanup, 4000);
        btn.addEventListener('click', doDelete, { once: true });
    }

    // ─── Info da nota ─────────────────────────────────────────────────
    function _showNoteInfo() {
        if (!nav.noteId) return;
        const note = getNote(nav.category, nav.itemId, nav.noteId);
        if (!note) return;
        const lines = (note.content || '').split('\n').filter(l => l.trim()).length;
        const words = (note.content || '').trim().split(/\s+/).filter(Boolean).length;
        const attachCount = (note.attachments || []).length;
        _showToast(`${lines} linha(s) · ${words} palavra(s) · ${attachCount} anexo(s)\nCriado: ${formatDate(note.createdAt)}`, true, 4000);
    }

    // ─── Toast ────────────────────────────────────────────────────────
    function _showToast(msg, success, duration = 2500) {
        let el = document.getElementById('aprendToast');
        if (!el) {
            el = document.createElement('div');
            el.id = 'aprendToast';
            document.body.appendChild(el);
        }
        el.textContent = msg;
        el.className = 'aprend-toast ' + (success ? 'success' : 'error');
        clearTimeout(el._t);
        el._t = setTimeout(() => { el.className = 'aprend-toast hidden'; }, duration);
    }

    // ─── Busca global ─────────────────────────────────────────────────
    function renderSearch(term) {
        const resultsEl = document.getElementById('aprendSearchResults');
        const folderEl  = document.getElementById('aprendFolderList');
        if (!resultsEl) return;

        if (!term || !term.trim()) {
            resultsEl.classList.add('hidden');
            folderEl?.classList.remove('hidden');
            return;
        }

        folderEl?.classList.add('hidden');
        resultsEl.classList.remove('hidden');

        const termLow = term.toLowerCase();
        const hits = [];
        const all = loadAll();

        // ── Seção 1: Itens da aba Hoje que batem com a busca ──────────
        const catIcons = { clientes: '👥', categorias: '🏢', atividades: '👤' };
        const todayItems = [];
        Object.keys(getCategoryLabels()).forEach(cat => {
            (APP_DATA[cat] || []).forEach(item => {
                const cleanName = item.name.replace(/^✅\s*/, '');
                if (cleanName.toLowerCase().includes(termLow)) {
                    todayItems.push({ cat, item, cleanName });
                }
            });
        });

        // ── Seção 2: Notas que batem com a busca ───────────────────────
        Object.keys(getCategoryLabels()).forEach(cat => {
            (APP_DATA[cat] || []).forEach(item => {
                normalizeToNotes(all[cat]?.[item.id]).filter(n => !n.deleted).forEach(note => {
                    const inTitle   = (note.title || '').toLowerCase().includes(termLow);
                    const inContent = (note.content || '').toLowerCase().includes(termLow);
                    if (!inTitle && !inContent) return;
                    let snippet = '';
                    if (inContent) {
                        const idx = note.content.toLowerCase().indexOf(termLow);
                        const start = Math.max(0, idx - 30);
                        snippet = (start > 0 ? '…' : '') + note.content.slice(start, idx + 80).replace(/\n/g, ' ') + '…';
                    }
                    hits.push({ cat, item, note, snippet });
                });
            });
        });

        if (todayItems.length === 0 && hits.length === 0) {
            resultsEl.innerHTML = `<div class="aprend-search-empty">Nenhum resultado para "<b>${escHtml(term)}</b>"</div>`;
            return;
        }

        let html = '';

        // Renderiza seção de categorias (itens da aba Hoje)
        if (todayItems.length > 0) {
            html += `<div class="aprend-search-section-title">📅 Ir para categoria</div>`;
            html += todayItems.map((t, i) => {
                const catLabel = getCategoryLabels()[t.cat].replace(/^\S+\s/, '');
                const icon = catIcons[t.cat] || '📁';
                return `
                <div class="aprend-search-cat-row" data-today-idx="${i}">
                    <span class="aprend-search-cat-icon">${icon}</span>
                    <div class="aprend-search-cat-info">
                        <div class="aprend-search-cat-name">${highlight(t.cleanName, term)}</div>
                        <div class="aprend-search-cat-sub">${escHtml(catLabel)}</div>
                    </div>
                    <svg class="aprend-search-cat-arrow" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
                </div>`;
            }).join('');
        }

        // Separador entre seções
        if (todayItems.length > 0 && hits.length > 0) {
            html += `<div class="aprend-search-divider"></div>`;
            html += `<div class="aprend-search-section-title">📝 Notas encontradas</div>`;
        } else if (hits.length > 0) {
            html += `<div class="aprend-search-section-title">📝 Notas encontradas</div>`;
        }

        // Renderiza notas encontradas
        html += hits.map((h, i) => {
            const cleanName = h.item.name.replace(/^✅\s*/, '');
            const catLabel  = getCategoryLabels()[h.cat].replace(/^\S+\s/, '');
            return `
            <div class="aprend-search-result" data-idx="${i}">
                <div class="aprend-search-result-path">${escHtml(catLabel)} › ${escHtml(cleanName)}</div>
                <div class="aprend-search-result-title">${highlight(h.note.title || 'Sem título', term)}</div>
                ${h.snippet ? `<div class="aprend-search-result-snippet">${highlight(h.snippet, term)}</div>` : ''}
            </div>`;
        }).join('');

        resultsEl.innerHTML = html;

        // Clique nos itens da aba Hoje → navega para a subpasta do item
        resultsEl.querySelectorAll('.aprend-search-cat-row').forEach(row => {
            row.addEventListener('click', () => {
                const t = todayItems[parseInt(row.dataset.todayIdx)];
                nav.category = t.cat;
                nav.itemId   = t.item.id;
                nav.noteId   = null;
                document.getElementById('aprendSearch').value = '';
                renderSearch('');
                renderFolders();
                renderSubfolders();
                renderNotesList();
                navigateTo('notes');
            });
        });

        // Clique nas notas → abre o editor
        resultsEl.querySelectorAll('.aprend-search-result').forEach(row => {
            row.addEventListener('click', () => {
                const h = hits[parseInt(row.dataset.idx)];
                nav.category = h.cat;
                nav.itemId   = h.item.id;
                nav.noteId   = h.note.id;
                document.getElementById('aprendSearch').value = '';
                renderSearch('');
                renderFolders();
                renderSubfolders();
                renderNotesList();
                renderEditor();
                navigateTo('editor');
            });
        });
    }

    // ─── Navegação mobile ─────────────────────────────────────────────
    function navigateTo(level) {
        nav.level = level;
        if (window.innerWidth > 768) return;

        const colFolders = document.getElementById('aprendColFolders');
        const colNotes   = document.getElementById('aprendColNotes');
        const colEditor  = document.getElementById('aprendColEditor');
        const all = [colFolders, colNotes, colEditor];

        all.forEach(c => c?.classList.remove('mobile-active', 'mobile-slide-in', 'mobile-slide-out'));

        if (level === 'folders') {
            colFolders?.classList.add('mobile-active');
            colNotes?.classList.remove('mobile-active');
            colEditor?.classList.remove('mobile-active');
        } else if (level === 'notes') {
            colFolders?.classList.remove('mobile-active');
            colNotes?.classList.add('mobile-active');
            colEditor?.classList.remove('mobile-active');
        } else {
            colFolders?.classList.remove('mobile-active');
            colNotes?.classList.remove('mobile-active');
            colEditor?.classList.add('mobile-active');
        }
    }

    function _applyLayout() {
        const colFolders = document.getElementById('aprendColFolders');
        const colNotes   = document.getElementById('aprendColNotes');
        const colEditor  = document.getElementById('aprendColEditor');
        if (!colFolders) return;

        if (window.innerWidth > 768) {
            [colFolders, colNotes, colEditor].forEach(c => {
                c?.classList.remove('mobile-active');
                c?.style && (c.style.display = '');
            });
        } else {
            navigateTo(nav.level || 'folders');
        }
    }

    // ─── Init ─────────────────────────────────────────────────────────
    function init() {
        // Registrar event listeners (apenas uma vez)
        document.getElementById('aprendSearch')?.addEventListener('input', (e) => renderSearch(e.target.value));

        // ── Viewer events (bound once) ──
        document.getElementById('aprendViewerClose')?.addEventListener('click', () => _closeViewer());
        document.getElementById('aprendViewerPrev')?.addEventListener('click', () => _viewerNavigate(-1));
        document.getElementById('aprendViewerNext')?.addEventListener('click', () => _viewerNavigate(+1));
        document.getElementById('aprendViewerNotesSave')?.addEventListener('click', () => {
            _saveViewerNote();
            const saveBtn = document.getElementById('aprendViewerNotesSave');
            if (saveBtn) { saveBtn.textContent = '✓ Salvo'; setTimeout(() => { saveBtn.textContent = 'Salvar'; }, 1200); }
        });
        document.getElementById('aprendViewerNotes')?.addEventListener('input', () => { _viewer.notesDirty = true; });
        // Close viewer on backdrop click (stage area)
        document.getElementById('aprendViewerStage')?.addEventListener('click', (e) => {
            if (e.target === e.currentTarget) _closeViewer();
        });

        document.getElementById('aprendBtnNewNote')?.addEventListener('click', () => {
            if (!nav.category || !nav.itemId) return;
            _flushNote();
            const note = createNewNote(nav.category, nav.itemId);
            nav.noteId = note.id;
            renderNotesList();
            renderEditor();
            renderFolders();
            navigateTo('editor');
            setTimeout(() => document.getElementById('aprendNoteTitle')?.focus(), 80);
        });

        document.getElementById('aprendBackToFolders')?.addEventListener('click', () => {
            _flushNote();
            if (nav.itemId) {
                nav.itemId = null;
                nav.noteId = null;
                const btnNew = document.getElementById('aprendBtnNewNote');
                if (btnNew) btnNew.classList.add('hidden');
                renderSubfolders();
            } else {
                nav.category = null;
                renderFolders();
                navigateTo('folders');
            }
            if (nav.category && !nav.itemId) navigateTo('notes');
        });

        window.addEventListener('resize', _applyLayout);

        // Se há navegação pendente vinda de openItem, navegar direto para o item
        if (_pendingOpenNav) {
            _applyPendingNav();
            _applyLayout();
            syncFromSupabase().then(() => {
                renderFolders();
                renderNotesList();
            }).catch(() => {});
            return;
        }

        restoreNav();
        renderFolders();
        if (nav.category === '__recent__') {
            renderRecentNotes();
            navigateTo('notes');
        }
        _applyLayout();

        syncFromSupabase().then(() => {
            renderFolders();
            if (nav.category === '__recent__') {
                renderRecentNotes();
            } else if (nav.itemId) {
                renderNotesList();
            }
        }).catch(() => {});
    }

    function onShow() {
        // Se há navegação pendente vinda de openItem, usa ela em vez de restaurar do storage
        if (_pendingOpenNav) {
            _applyPendingNav();
        } else {
            restoreNav();
            renderFolders();
            if (nav.category === '__recent__') {
                renderRecentNotes();
                navigateTo('notes');
            } else {
                if (nav.category) renderSubfolders();
                if (nav.itemId)   renderNotesList();
                if (nav.noteId)   renderEditor();
            }
            _applyLayout();
        }

        // ── Iniciar Realtime dedicado para Aprendizados ──────────────────
        // Enquanto a aba estiver aberta, ouvir mudanças em tempo real.
        // Se o Supabase Realtime não estiver disponível, usa polling a 5s.
        if (typeof StorageManager !== 'undefined') {
            const userId = StorageManager.getUserId?.();
            if (userId) {
                StorageManager.startAprendizadosRealtime(userId);
            }
        }
    }

    function onHide() {
        _flushNote();
        // Encerrar o canal Realtime ao sair da aba — economiza recursos e evita listeners órfãos
        if (typeof StorageManager !== 'undefined') {
            StorageManager.stopAprendizadosRealtime?.();
        }
    }

    // refreshFromRemote — chamado pelo StorageManager quando dados chegam de outro dispositivo
    // Re-renderiza apenas o que está visível, preservando a posição do cursor no editor
    function refreshFromRemote() {
        try {
            // Se o editor estiver aberto com uma nota em edição, não interromper a digitação
            // — o editor faz flush ao perder foco; apenas atualizar listas em background
            renderFolders();
            if (nav.category === '__recent__') {
                renderRecentNotes();
            } else if (nav.category && nav.itemId) {
                renderNotesList();
                // Só re-renderizar o editor se a nota não estiver sendo editada
                if (nav.noteId && !_noteSaveTimer) {
                    renderEditor();
                }
            } else if (nav.category) {
                renderSubfolders();
            }
        } catch(e) {
            console.warn('Aprendizados.refreshFromRemote: erro ao re-renderizar —', e);
        }
    }

    // openItem — API pública: navega direto para o item na aba aprendizados
    function openItem(category, itemId) {
        _pendingOpenNav = { category, itemId };
        // Se a view já estiver visível (onShow não será chamado), aplica imediatamente
        const view = document.getElementById('aprendizadosView');
        if (view && !view.classList.contains('hidden')) {
            _applyPendingNav();
        }
    }

    function _applyPendingNav() {
        if (!_pendingOpenNav) return;
        const { category, itemId } = _pendingOpenNav;
        _pendingOpenNav = null;
        _flushNote();
        nav.category = category;
        nav.itemId   = itemId;
        nav.noteId   = null;
        renderFolders();
        renderSubfolders();
        renderNotesList();
        renderEditor();   // limpa o painel do editor (noteId=null → estado vazio)
        navigateTo('notes');
    }

    // addQuickEntry — API pública: salva um aprendizado rápido vindo do popup de conclusão
    // Cria uma nova nota no item com o texto como conteúdo
    function addQuickEntry(category, itemId, itemName, text) {
        if (!text || !text.trim()) return;
        const note = {
            id: uuid(),
            title: '🧠 ' + (itemName || itemId),
            content: text.trim(),
            type: 'aprendizado',
            checkedLines: {},
            attachments: [],
            createdAt: nowISO(),
            updatedAt: nowISO(),
        };
        saveNote(category, itemId, note);
    }

    // addToFixedNote — API pública: appenda texto em uma nota fixa por tipo
    // Cria a nota na primeira vez; adiciona ao final nas chamadas seguintes
    function addToFixedNote(category, itemId, type, text) {
        if (!text || !text.trim()) return;
        // Remover linhas em branco — sempre uma linha abaixo da outra
        text = _stripBlankLines(text);

        const TITLES = {
            concluido:    '✅ Concluídos',
            bloqueado:    '🚫 Bloqueados',
            parcialmente: '⏳ Parcialmente',
        };
        const TYPES = {
            concluido:    'concluido',
            bloqueado:    'bloqueado',
            parcialmente: 'parcialmente',
        };

        const title = TITLES[type] || ('📝 ' + type);
        const notes = getItemNotes(category, itemId);
        const existing = notes.find(n => n.title === title);

        if (existing) {
            // Appenda separado por divisor
            existing.content = existing.content
                ? existing.content.trim() + '\n—\n' + text.trim()
                : text.trim();
            existing.updatedAt = nowISO();
            saveNote(category, itemId, existing);
        } else {
            // Cria nota fixa pela primeira vez
            const note = {
                id: uuid(),
                title,
                content: text.trim(),
                type: TYPES[type] || type,
                checkedLines: {},
                attachments: [],
                createdAt: nowISO(),
                updatedAt: nowISO(),
            };
            saveNote(category, itemId, note);
        }
    }

    // createNoteFromText — API pública: cria uma nota nova avulsa a partir do texto do modal
    // Primeira linha não vazia = título (strip # / ## prefix); restante = conteúdo
    function createNoteFromText(category, itemId, text) {
        if (!text || !text.trim()) return null;
        // Remover linhas em branco — sempre uma linha abaixo da outra
        const lines = _stripBlankLines(text).split('\n');
        let title = '';
        let contentStart = 0;
        for (let i = 0; i < lines.length; i++) {
            const l = lines[i].trim();
            if (l) {
                title = l.replace(/^#{1,2}\s*/, '');
                contentStart = i + 1;
                break;
            }
        }
        const content = lines.slice(contentStart).join('\n').trim();
        const note = {
            id: uuid(),
            title: title || '🧠 Aprendizado',
            content: content || _stripBlankLines(text),
            type: 'aprendizado',
            checkedLines: {},
            attachments: [],
            createdAt: nowISO(),
            updatedAt: nowISO(),
        };
        saveNote(category, itemId, note);
        // Navegar para o item (a aba já será mostrada pelo caller)
        openItem(category, itemId);
        return note;
    }

    return { init, onShow, onHide, setLineChecked, addQuickEntry, addToFixedNote, createNoteFromText, openItem, refreshFromRemote };
})();

