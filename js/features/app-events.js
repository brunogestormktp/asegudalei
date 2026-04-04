// app-events.js — Mixin: Event listeners setup + Aprendizados Picker
// Extends HabitTrackerApp.prototype

Object.assign(HabitTrackerApp.prototype, {

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
                this._reportsScrollTop = 0;
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
                this._historyDateRange = null;
                this._updateHistoryDateLabel();
                this._reRenderHistory();
            }
        });

        hSearchInput.addEventListener('input', () => {
            this._historySearchQuery = hSearchInput.value.trim().toLowerCase();
            hSearchClear.style.display = this._historySearchQuery ? 'flex' : 'none';
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
                
                const isActive = e.currentTarget.classList.contains('active-filter');
                
                document.querySelectorAll('.btn-quick-nav').forEach(b => b.classList.remove('active-filter'));
                
                if (isActive) {
                    allCategories.forEach(cat => {
                        cat.classList.remove('fade-out');
                    });
                } else {
                    allCategories.forEach(cat => {
                        if (cat !== targetElement) {
                            cat.classList.add('fade-out');
                        }
                    });
                    
                    if (targetElement) {
                        targetElement.classList.remove('fade-out');
                        e.currentTarget.classList.add('active-filter');
                        
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
        
        // Quick navigation for History view
        document.querySelectorAll('.btn-quick-nav-history').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const category = e.currentTarget.dataset.category;
                const categoryLabels = {
                    'clientes': 'CLIENTES',
                    'categorias': 'EMPRESA',
                    'atividades': 'PESSOAL'
                };
                
                const labelText = categoryLabels[category];
                
                const isActive = e.currentTarget.classList.contains('active-filter');
                
                document.querySelectorAll('.btn-quick-nav-history').forEach(b => b.classList.remove('active-filter'));
                
                if (isActive) {
                    document.querySelectorAll('.category-separator').forEach(sep => {
                        sep.classList.remove('fade-out');
                    });
                    document.querySelectorAll('.history-item-wrapper').forEach(item => {
                        item.classList.remove('fade-out');
                    });
                } else {
                    const allSeparators = Array.from(document.querySelectorAll('.category-separator'));
                    const allItems = Array.from(document.querySelectorAll('.history-item-wrapper'));
                    
                    allSeparators.forEach(sep => {
                        if (sep.textContent !== labelText) {
                            sep.classList.add('fade-out');
                        }
                    });
                    
                    const targetSeparator = allSeparators.find(sep => sep.textContent === labelText);
                    
                    if (targetSeparator) {
                        targetSeparator.classList.remove('fade-out');
                        e.currentTarget.classList.add('active-filter');
                        
                        const parentList = targetSeparator.parentElement;
                        
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
            if (!e.target.closest('.item')) {
                this.exitCurrentEditMode(true);
            }
        });

        // Global handler for item clicks to ensure immediate switching between edit modes
        document.addEventListener('click', (e) => {
            const clickedItem = e.target.closest('.item');
            if (clickedItem && this.currentlyEditingItem) {
                if (this.currentlyEditingItem.element !== clickedItem) {
                    this.exitCurrentEditMode(true);
                }
            }
        }, true);

        // Global handler for delete buttons using event delegation
        document.addEventListener('click', async (e) => {
            const deleteBtn = e.target.closest('.btn-note-delete');
            if (!deleteBtn) return;
            
            e.stopPropagation();
            e.preventDefault();
            
            const itemId = deleteBtn.dataset.itemId;
            const category = deleteBtn.dataset.category;
            
            if (!itemId || !category) {
                console.error('Missing item ID or category data attributes');
                return;
            }
            
            const confirmed = await this.showConfirmModal(
                'Apagar Nota',
                'Tem certeza que deseja apagar esta nota? Esta ação não pode ser desfeita.'
            );
            
            if (!confirmed) return;
            
            const dateStr = this.getDateString();
            const existing = await StorageManager.getItemStatus(dateStr, category, itemId);
            await StorageManager.saveItemStatus(dateStr, category, itemId, existing.status || 'none', '');
            this._todayScrollTop = window.scrollY;
            this._pendingScrollRestore = true;
            this.renderTodayView();
        }, true);

        // Handler para remover imagem individual da nota
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
            const newNote = (existing.note || '')
                .split('\n')
                .filter(line => !line.trim().startsWith(`[img:${srcToRemove}]`) &&
                                !line.trim().startsWith(`[img:${srcToRemove} ]`) &&
                                !(line.trim() === `[img:${srcToRemove}]`))
                .filter(line => {
                    const m = line.trim().match(/\[img:(.+?)\]$/);
                    return !(m && m[1].trim() === srcToRemove);
                })
                .join('\n')
                .trim();

            await StorageManager.saveItemStatus(dateStr, category, itemId, existing.status || 'none', newNote, existing.links || null);

            const itemEl = itemNote.closest('.item');
            if (itemEl) this._updateNoteDisplay(itemEl, category, itemId, newNote);
        }, true);
        this.initAprendizadosPicker();
    },

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

                if (spaceBelow < dropRect.height + 8 && spaceAbove > dropRect.height) {
                    dropdown.style.top = `${btnRect.top - dropRect.height - 6}px`;
                } else {
                    dropdown.style.top = `${btnRect.bottom + 6}px`;
                }

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

        document.addEventListener('click', (e) => {
            if (!dropdown.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
                closeDropdown();
            }
        });

        window.addEventListener('scroll', () => {
            if (!dropdown.classList.contains('hidden')) closeDropdown();
        }, true);

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !dropdown.classList.contains('hidden')) closeDropdown();
        });

        searchInput?.addEventListener('input', (e) => {
            this._buildAprendPickerList(e.target.value.trim().toLowerCase());
        });
        searchInput?.addEventListener('keydown', (e) => e.stopPropagation());

        document.body.appendChild(dropdown);
    },

    _buildAprendPickerList(filter) {
        const listEl = document.getElementById('aprendPickerList');
        if (!listEl) return;
        listEl.innerHTML = '';

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

                const matchedLines = filter
                    ? lines.filter(l => l.toLowerCase().includes(filter) || cleanName.toLowerCase().includes(filter))
                    : lines;

                if (matchedLines.length === 0) return;

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

                const itemHeader = document.createElement('div');
                itemHeader.className = 'aprendPicker-item-header';
                itemHeader.textContent = cleanName;
                listEl.appendChild(itemHeader);

                matchedLines.forEach((lineText, lineIdx) => {
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
    },

    async _addAprendLineToHoje(category, itemId, lineText) {
        try {
            const dateStr = this.getDateString();
            const existing = await StorageManager.getItemStatus(dateStr, category, itemId);
            const existingNote = existing.note || '';
            const newNote = existingNote
                ? (existingNote.includes(lineText) ? existingNote : existingNote + '\n' + lineText)
                : lineText;
            await StorageManager.saveItemStatus(dateStr, category, itemId, existing.status || 'none', newNote);
            this._todayScrollTop = window.scrollY;
            this._pendingScrollRestore = true;
            this.renderTodayView();

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
    },

    // ─── Dropdown de aprendizados por item ──────────────────────────────
    _closeAllItemAprendDropdowns() {
        document.querySelectorAll('.item-aprend-dropdown').forEach(d => {
            if (d.parentElement === document.body) {
                d.remove();
            }
        });
        document.querySelectorAll('.btn-aprend-item.active').forEach(b => b.classList.remove('active'));
    },

    _navigateToAprend(category, itemId) {
        if (typeof Aprendizados !== 'undefined') {
            Aprendizados.openItem(category, itemId);
        }
        this.showView('aprendizados');
    },

    async _toggleItemAprendDropdown(btn, category, itemId, noteEditable) {
        const existing = document.querySelector(`.item-aprend-dropdown[data-item-id="${itemId}"][data-category="${category}"]`);
        if (existing) {
            this._closeAllItemAprendDropdowns();
            return;
        }

        this._closeAllItemAprendDropdowns();

        const dropdown = document.createElement('div');
        dropdown.className = 'item-aprend-dropdown';
        dropdown.dataset.itemId = itemId;
        dropdown.dataset.category = category;
        dropdown._noteEditable = noteEditable;
        dropdown._anchorBtn = btn;

        await this._fillAprendDropdown(dropdown, category, itemId, noteEditable);

        dropdown.style.position = 'fixed';
        dropdown.style.top = '-9999px';
        dropdown.style.left = '-9999px';
        document.body.appendChild(dropdown);
        btn.classList.add('active');

        requestAnimationFrame(() => this._positionAprendDropdown(dropdown, btn));

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
    },

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
    },

    async _fillAprendDropdown(dropdown, category, itemId, noteEditable) {
        const openGroups = new Set();
        dropdown.querySelectorAll('.item-aprend-note-group.open').forEach(g => {
            const label = g.querySelector('.aprend-note-label')?.textContent;
            if (label) openGroups.add(label);
        });

        dropdown.innerHTML = '';

        let aprendData = {};
        try { aprendData = JSON.parse(localStorage.getItem('aprendizadosData') || '{}'); } catch {}

        const rawItem = aprendData[category]?.[itemId];
        let notes = [];
        if (rawItem) {
            if (Array.isArray(rawItem.notes) && rawItem.notes.length > 0) {
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
    },

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
    },

});
