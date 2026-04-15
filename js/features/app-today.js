// app-today.js — Mixin: Today view, filters, category items, note HTML builders, utilities
// Extends HabitTrackerApp.prototype

Object.assign(HabitTrackerApp.prototype, {

    renderTodayView() {
        // Clear any existing edit mode when re-rendering
        this.exitCurrentEditMode(true);
        this._closeAllItemAprendDropdowns();
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

        Promise.all([
            this.renderCategoryItems('clientes', 'clientesList', APP_DATA.clientes, dateStr),
            this.renderCategoryItems('categorias', 'categoriasList', APP_DATA.categorias, dateStr),
            this.renderCategoryItems('atividades', 'atividadesList', APP_DATA.atividades, dateStr)
        ]).then(() => {
            this._applyTodayFilter();
            requestAnimationFrame(() => {
                this._syncHeaderHeight();
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
                    return;
                }
                if (this._pendingScrollRestore) {
                    this._pendingScrollRestore = false;
                    window.scrollTo({ top: this._todayScrollTop || 0, behavior: 'instant' });
                }
            });
        });
    },

    _applyTodayFilter() {
        const filter = this._activeTodayFilter || 'all';
        const query  = (this._todaySearchQuery || '').toLowerCase().trim();

        document.querySelectorAll('#todayView .item').forEach(itemEl => {
            let statusOk;
            if (filter === 'all') {
                statusOk = true;
            } else if (filter === 'sem-nota') {
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
                if (nameEl && !nameEl.dataset.originalName) {
                    nameEl.dataset.originalName = nameEl.textContent;
                }
                const originalName = nameEl?.dataset.originalName || nameEl?.textContent || '';
                searchOk = originalName.toLowerCase().includes(query);

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
                const nameEl = itemEl.querySelector('.item-name');
                if (nameEl?.querySelector('.tsf-highlight')) {
                    nameEl.textContent = nameEl.textContent;
                }
            }

            itemEl.style.display = (statusOk && searchOk) ? '' : 'none';
        });

        const filtering = filter !== 'all' || query;
        document.querySelectorAll('#todayView .category').forEach(cat => {
            const visible = [...cat.querySelectorAll('.item')].filter(el => el.style.display !== 'none');
            cat.style.display = (visible.length === 0 && filtering) ? 'none' : '';
        });
    },

    async renderCategoryItems(category, containerId, items, dateStr) {
        const container = document.getElementById(containerId);
        container.innerHTML = '';

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
                const itemObj = (APP_DATA[cat] || []).find(i => i.id === iid);
                this._showWeekDayPicker(dayEl, block || dayEl, dstr, cat, iid, itemObj);
            }, true);
        }

        for (const item of items) {
            const itemData = await StorageManager.getItemStatus(dateStr, category, item.id);
            const statusConfig = STATUS_CONFIG[itemData.status];
            
            const itemEl = document.createElement('div');
            itemEl.className = 'item';
            itemEl.dataset.category = category;
            itemEl.dataset.itemId   = item.id;
            const initialStatus = itemData.status || 'none';
            itemEl.classList.add(`status-${initialStatus}`);
            if (itemData.attention) {
                itemEl.classList.add('item-attention');
                itemEl.dataset.attention = '1';
            }
            
            let noteHtml = '';
            if (itemData.note && itemData.note.trim()) {
                const noteWithLinks = this._buildNoteHtml(itemData.note);
                noteHtml = `<div class="item-note" data-item-id="${item.id}" data-category="${category}">${noteWithLinks}<button class="btn-note-delete" data-item-id="${item.id}" data-category="${category}" title="Apagar nota">✖</button></div>`;
            }

            let linkTagsHtml = '';
            if (itemData.links && itemData.links.length > 0) {
                const tagItems = itemData.links.map(lnk => {
                    const linkedItem = (APP_DATA[lnk.category] || []).find(i => i.id === lnk.itemId);
                    const name = linkedItem ? linkedItem.name : lnk.itemId;
                    return `<span class="item-link-tag" data-link-cat="${lnk.category}" data-link-id="${lnk.itemId}" title="Vinculado a ${this._escapeHtml(name)}">🔗 ${this._escapeHtml(name)}<button class="item-link-tag-remove" data-link-cat="${lnk.category}" data-link-id="${lnk.itemId}">✕</button></span>`;
                }).join('');
                linkTagsHtml = `<div class="item-link-tags" data-item-id="${item.id}" data-category="${category}">${tagItems}</div>`;
            }

            const hasNoteInitially = !!(itemData.note && itemData.note.trim());
            const hasLinksInitially = !!(itemData.links && itemData.links.length > 0);

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
                        <button class="btn-attention${itemData.attention ? ' is-active' : ''}" title="${itemData.attention ? 'Remover atenção' : 'Marcar como atenção'}" aria-label="Marcar como atenção" data-category="${category}" data-item-id="${item.id}">⚠️</button>
                        <button class="btn-google-search" title="Pesquisar nota no Google" aria-label="Pesquisar no Google" style="display:${hasNoteInitially ? 'inline-flex' : 'none'};align-items:center;justify-content:center;padding:2px 4px;background:none;border:none;cursor:pointer;border-radius:4px;opacity:0.75;" tabindex="-1"><img src="https://www.google.com/favicon.ico" alt="Google" width="14" height="14" style="display:block;pointer-events:none;"></button>
                        <button class="btn-week-summary" title="Resumo semanal" aria-label="Resumo semanal">📋</button>
                        <button class="btn-link-item${hasLinksInitially ? ' has-links' : ''}" title="Vincular a outro item" aria-label="Vincular item">🔗</button>
                        <button class="btn-next-day" title="Passar para próximo dia" aria-label="Próximo dia">⏭</button>
                        <button class="btn-aprend-item${hasAprendNotes ? ' has-notes' : ''}" title="Inserir nota de Aprendizados" aria-label="Aprendizados">📚</button>
                    </div>
                </div>
            `;

            itemEl.innerHTML = headerHtml + `${linkTagsHtml}${noteHtml}`;

            const noteText = itemData.note || '';
            const noteEditable = document.createElement('div');
            noteEditable.className = 'item-note-editable';
            noteEditable.contentEditable = true;
            noteEditable.spellcheck = true;
            this._textToEditable(noteEditable, noteText);
            const headerEl = itemEl.querySelector('.item-header');
            headerEl.insertAdjacentElement('afterend', noteEditable);

            if (noteText && noteText.trim()) {
                noteEditable.style.display = 'none';
            } else {
                noteEditable.style.display = 'block';
            }

            const nameEl = itemEl.querySelector('.item-name');
            const handleEditMode = () => {
                this.forceEditMode(itemEl, noteEditable, category, item.id);
            };

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

            const handleItemClick = (ev) => {
                const clickedElement = ev.target;

                if (clickedElement.closest('.btn-mic') || 
                    clickedElement.closest('.custom-status') ||
                    clickedElement.closest('.btn-note-delete') ||
                    clickedElement.closest('.btn-aprend-item') ||
                    clickedElement.closest('.btn-next-day') ||
                    clickedElement.closest('.btn-google-search') ||
                    clickedElement.closest('.btn-attention') ||
                    clickedElement.closest('.btn-link-item') ||
                    clickedElement.closest('.btn-week-summary') ||
                    clickedElement.closest('.week-summary-overlay') ||
                    clickedElement.closest('.item-aprend-dropdown') ||
                    clickedElement.closest('.item-week-bar') ||
                    clickedElement.closest('.note-img-remove') ||
                    clickedElement.closest('.note-img-thumb') ||
                    clickedElement.closest('.note-img-wrap')) {
                    return;
                }

                if (clickedElement.closest('a') && clickedElement.closest('.item-note')) {
                    return;
                }

                if (_hasDragged) {
                    _hasDragged = false;
                    return;
                }

                if (clickedElement.closest('.item-note-editable') &&
                    noteEditable.style.display !== 'none') {
                    return;
                }

                ev.preventDefault();
                ev.stopPropagation();
                handleEditMode();
            };

            if (initialStatus === 'none') {
                itemEl.addEventListener('click', handleItemClick, true);
            } else {
                nameEl.addEventListener('click', handleItemClick, true);
                
                const displayedNote = itemEl.querySelector('.item-note');
                if (displayedNote) {
                    displayedNote.addEventListener('click', handleItemClick, true);
                }
            }

            nameEl.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter' || ev.key === ' ') {
                    ev.preventDefault();
                    handleEditMode();
                }
            });

            noteEditable.addEventListener('blur', () => {
                const text = this._getEditableText(noteEditable);
                this.saveInlineNote(itemEl, category, item.id, text);
            });
            
            noteEditable.addEventListener('keydown', (ev) => {
                if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
                    ev.preventDefault();
                    this.exitCurrentEditMode(true);
                }
                if ((ev.ctrlKey || ev.metaKey) && ev.key === 'a') {
                    ev.stopPropagation();
                }
            });

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

            // Custom status dropdown
            const statusContainer = document.createElement('div');
            statusContainer.className = 'custom-status';

            const statusBtn = document.createElement('button');
            statusBtn.type = 'button';
            statusBtn.className = 'custom-status-btn';
            statusBtn.setAttribute('aria-haspopup', 'listbox');

            const statusList = document.createElement('ul');
            statusList.className = 'custom-status-list hidden';
            statusList.setAttribute('role', 'listbox');

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
            const headerRight = itemEl.querySelector('.item-header > div');
            if (headerRight) headerRight.appendChild(statusContainer);

            statusBtn.style.display = 'none';

            const setStatusUI = (statusKey) => {
                const cfg = STATUS_CONFIG[statusKey] || STATUS_CONFIG['none'];
                statusBtn.innerText = cfg.label || '—';
                statusBtn.dataset.status = statusKey;
                statusContainer.dataset.status = statusKey;
                Array.from(itemEl.classList).filter(c => c.startsWith('status-')).forEach(c => itemEl.classList.remove(c));
                itemEl.classList.add(`status-${statusKey}`);
                
                statusList.querySelectorAll('.custom-status-option').forEach(opt => {
                    opt.classList.toggle('selected', opt.dataset.value === statusKey);
                });
            };

            const initialStatusKey = itemData.status || 'none';
            setStatusUI(initialStatusKey);

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
                    if (parent === document.body) {
                        const lid = l.dataset.listId;
                        const container = lid ? document.querySelector(`.custom-status[data-list-id="${lid}"]`) : null;
                        if (container) {
                            container.appendChild(l);
                            container.classList.remove('is-open');
                        } else {
                            l.remove();
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

            const listId = `sl-${category}-${item.id}`.replace(/[^a-z0-9-_]/gi, '_');
            statusList.dataset.listId = listId;
            statusContainer.dataset.listId = listId;

            statusBtn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                const isHidden = statusList.classList.contains('hidden');
                closeAllStatusLists();
                
                if (isHidden) {
                    document.body.appendChild(statusList);
                    statusList.style.position = 'fixed';
                    statusList.style.top = '-9999px';
                    statusList.style.left = '-9999px';
                    statusList.classList.remove('hidden');
                    statusContainer.classList.add('is-open');
                    
                    requestAnimationFrame(() => {
                        const btnRect = statusBtn.getBoundingClientRect();
                        const listRect = statusList.getBoundingClientRect();
                        const listWidth = Math.max(listRect.width, 220);
                        const listHeight = listRect.height;

                        const spaceBelow = window.innerHeight - btnRect.bottom;
                        const spaceAbove = btnRect.top;

                        if (spaceBelow < listHeight + 8 && spaceAbove > listHeight) {
                            statusList.classList.add('open-upward');
                            statusList.style.top = `${btnRect.top - listHeight - 6}px`;
                        } else {
                            statusList.classList.remove('open-upward');
                            statusList.style.top = `${btnRect.bottom + 6}px`;
                        }

                        const leftPos = btnRect.right - listWidth;
                        statusList.style.left = `${Math.max(4, leftPos)}px`;
                        statusList.style.right = '';
                    });
                } else {
                    detachStatusList();
                }
            });

            statusList.addEventListener('click', async (ev) => {
                const li = ev.target.closest('.custom-status-option');
                if (!li) return;
                const newStatus = li.dataset.value || 'none';
                setStatusUI(newStatus);

                const dateStr = this.getDateString();
                const existing = await StorageManager.getItemStatus(dateStr, category, item.id);
                await StorageManager.saveItemStatus(dateStr, category, item.id, newStatus, existing.note || '');

                await this._propagateStatusToLinks(dateStr, category, item.id, newStatus);

                // Trigger debounced ranking refresh so ranking updates in near-realtime
                if (typeof this._debouncedRankingRefresh === 'function') {
                    this._debouncedRankingRefresh();
                }

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

                if (newStatus === 'concluido') {
                    this.showAprendizadoPopup(category, item.id, item.name || item.id)
                        .then(() => {
                            this._todayScrollTop = window.scrollY;
                            this._pendingScrollRestore = true;
                            this.renderTodayView();
                        });
                }

                if (newStatus === 'bloqueado') {
                    this.showBloqueadoPopup(category, item.id)
                        .then(() => {
                            this._todayScrollTop = window.scrollY;
                            this._pendingScrollRestore = true;
                            this.renderTodayView();
                        });
                }

                if (newStatus === 'parcialmente') {
                    this.showParcialmentePopup(category, item.id)
                        .then(() => {
                            this._todayScrollTop = window.scrollY;
                            this._pendingScrollRestore = true;
                            this.renderTodayView();
                        });
                }
            });

            const closeOnOutsideClick = (ev) => {
                if (!statusContainer.contains(ev.target) && !statusList.contains(ev.target)) {
                    detachStatusList();
                }
            };
            
            const closeOnScroll = () => {
                if (!statusList.classList.contains('hidden')) {
                    detachStatusList();
                }
            };

            if (!this._statusClickHandlers) this._statusClickHandlers = [];
            this._statusClickHandlers.push(closeOnOutsideClick);
            document.addEventListener('click', closeOnOutsideClick);

            if (!this._statusScrollHandlers) this._statusScrollHandlers = [];
            this._statusScrollHandlers.push(closeOnScroll);
            window.addEventListener('scroll', closeOnScroll, true);

            const closeOnEscape = (ev) => {
                if (ev.key === 'Escape' && !statusList.classList.contains('hidden')) {
                    detachStatusList();
                }
            };
            
            if (!this._statusEscapeHandlers) this._statusEscapeHandlers = [];
            this._statusEscapeHandlers.push(closeOnEscape);
            document.addEventListener('keydown', closeOnEscape);

            // Mic button logic (preserved as fallback)
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

            // ── Botão de Atenção (prioridade do dia) ─────────────────
            const attentionBtn = itemEl.querySelector('.btn-attention');
            if (attentionBtn) {
                attentionBtn.addEventListener('click', async (ev) => {
                    ev.stopPropagation();
                    ev.preventDefault();
                    const dateStr = this.getDateString();
                    await StorageManager.toggleAttention(dateStr, category, item.id);
                    this._todayScrollTop = window.scrollY;
                    this._pendingScrollRestore = true;
                    this.renderTodayView();
                });
            }

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
                    const nextDate = new Date(
                        this.currentDate.getFullYear(),
                        this.currentDate.getMonth(),
                        this.currentDate.getDate() + 1
                    );
                    const nextDateStr = this.getDateString(nextDate);

                    const currentData = await StorageManager.getItemStatus(currentDateStr, category, item.id);
                    const currentStatus = currentData.status || 'none';
                    const currentNote = currentData.note || '';

                    const nextData = await StorageManager.getItemStatus(nextDateStr, category, item.id);
                    const nextNote = (nextData.note || '').trim();
                    const nextStatus = nextData.status || 'none';

                    const mergedNote = nextNote ? nextNote : currentNote;
                    const mergedStatus = nextStatus !== 'none' ? nextStatus : currentStatus;
                    await StorageManager.saveItemStatus(nextDateStr, category, item.id, mergedStatus, mergedNote);

                    await StorageManager.saveItemStatus(currentDateStr, category, item.id, 'nao-feito', currentNote);

                    nextDayBtn.textContent = '✅';
                    nextDayBtn.disabled = true;
                    setTimeout(() => {
                        this._todayScrollTop = window.scrollY;
                        this._pendingScrollRestore = true;
                        this.renderTodayView();
                    }, 700);
                });
            }

            // ── Resumo semanal (notas da semana) ─────────────────────────
            const weekSummaryBtn = itemEl.querySelector('.btn-week-summary');
            if (weekSummaryBtn) {
                weekSummaryBtn.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    ev.preventDefault();
                    this._showWeekSummaryPopup(category, item.id, item.name);
                });
            }

            container.appendChild(itemEl);

            this.renderItemWeekBar(category, item.id, this.currentDate).then(bar => {
                itemEl.appendChild(bar);
            });
        }

        // ── Mover itens com atenção para o topo da categoria ─────────
        const attentionItems = [...container.querySelectorAll('.item.item-attention')];
        attentionItems.reverse().forEach(el => {
            container.insertBefore(el, container.firstChild);
        });
    },

    // Convert URLs in text to clickable links
    linkifyText(text) {
        const urlRegex = /(https?:\/\/[^\s]+)/g;
        return text
            .split('\n')
            .map(line => {
                const parts = line.split(urlRegex);
                return parts.map((part, i) => {
                    if (i % 2 === 1) {
                        return `<a href="${this._escapeHtml(part)}" target="_blank" rel="noopener noreferrer" class="note-link">${this._escapeHtml(part)}</a>`;
                    }
                    return this._escapeHtml(part);
                }).join('');
            })
            .join('<br>');
    },

    _buildNoteHtml(text) {
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
        const tagsHtml  = tagParts.join('');
        const textHtml  = textParts.join('<br>');
        return tagsHtml + textHtml;
    },

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
    },

    _escapeHtml(str) {
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    },

    _escapeHtmlAttr(str) {
        if (!str) return '';
        return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },

    // ── Resumo Semanal — Popup ────────────────────────────────────────────

    _closeWeekSummaryPopup() {
        const el = document.querySelector('.week-summary-overlay');
        if (el) el.remove();
    },

    async _showWeekSummaryPopup(category, itemId, itemName) {
        this._closeWeekSummaryPopup();

        const overlay = document.createElement('div');
        overlay.className = 'week-summary-overlay';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-label', 'Resumo semanal');

        const popup = document.createElement('div');
        popup.className = 'week-summary-popup';

        // ── Header fixo (título + fechar) ─────────────────────
        const header = document.createElement('div');
        header.className = 'ws-header';
        const title = document.createElement('span');
        title.className = 'ws-title';
        title.textContent = itemName;
        const closeBtn = document.createElement('button');
        closeBtn.className = 'ws-close';
        closeBtn.textContent = '✕';
        closeBtn.title = 'Fechar';
        closeBtn.setAttribute('aria-label', 'Fechar');
        header.appendChild(title);
        header.appendChild(closeBtn);
        popup.appendChild(header);

        // ── Navegação de semanas ───────────────────────────────
        const navBar = document.createElement('div');
        navBar.className = 'ws-nav';

        const prevBtn = document.createElement('button');
        prevBtn.className = 'ws-nav-btn';
        prevBtn.textContent = '‹';
        prevBtn.title = 'Semana anterior';
        prevBtn.setAttribute('aria-label', 'Semana anterior');

        const weekLabel = document.createElement('span');
        weekLabel.className = 'ws-nav-label';

        const nextBtn = document.createElement('button');
        nextBtn.className = 'ws-nav-btn';
        nextBtn.textContent = '›';
        nextBtn.title = 'Próxima semana';
        nextBtn.setAttribute('aria-label', 'Próxima semana');

        navBar.appendChild(prevBtn);
        navBar.appendChild(weekLabel);
        navBar.appendChild(nextBtn);
        popup.appendChild(navBar);

        // ── Área de conteúdo dinâmico ─────────────────────────
        const contentArea = document.createElement('div');
        contentArea.className = 'ws-content';
        popup.appendChild(contentArea);

        overlay.appendChild(popup);
        document.body.appendChild(overlay);

        // ── Estado de navegação ───────────────────────────────
        let weekOffset = 0; // 0 = semana actual, -1 = semana passada, etc.
        const baseMonday = this.getWeekMonday(this.currentDate);

        const fmtD = (d) => `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}`;

        const renderWeek = async (offset) => {
            const DAYS = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];
            const todayStr = this.getDateString(new Date());

            const monday = new Date(baseMonday);
            monday.setDate(baseMonday.getDate() + offset * 7);

            const dates = Array.from({ length: 7 }, (_, i) => {
                const d = new Date(monday);
                d.setDate(monday.getDate() + i);
                return d;
            });

            // Actualiza label de navegação
            const isCurrent = offset === 0;
            const isPast = offset < 0;
            const relLabel = isCurrent ? 'Esta semana' : isPast
                ? (offset === -1 ? 'Semana passada' : `${Math.abs(offset)} semanas atrás`)
                : (offset === 1 ? 'Próxima semana' : `${offset} semanas à frente`);
            weekLabel.innerHTML = `<span class="ws-nav-period">${fmtD(dates[0])} – ${fmtD(dates[6])}</span><span class="ws-nav-rel">${relLabel}</span>`;

            // Desabilita "próxima" se já estamos na semana corrente
            nextBtn.disabled = offset >= 0;
            nextBtn.style.opacity = offset >= 0 ? '0.3' : '1';
            nextBtn.style.cursor = offset >= 0 ? 'default' : 'pointer';

            // Mostra loading
            contentArea.innerHTML = '<div class="ws-loading">Carregando…</div>';

            const weekData = await Promise.all(
                dates.map(d => StorageManager.getItemStatus(this.getDateString(d), category, itemId))
            );

            // Limpa e reconstrói lista
            contentArea.innerHTML = '';

            const list = document.createElement('div');
            list.className = 'ws-list';

            dates.forEach((d, i) => {
                const dateStr = this.getDateString(d);
                const info    = weekData[i];
                const status  = info.status || 'none';
                const note    = info.note   || '';
                const cfg     = STATUS_CONFIG[status] || STATUS_CONFIG['none'];
                const isToday = dateStr === todayStr;

                const row = document.createElement('div');
                row.className = 'ws-row' + (isToday ? ' ws-today' : '');

                const top = document.createElement('div');
                top.className = 'ws-row-top';

                const dot = document.createElement('span');
                dot.className = 'ws-dot';
                dot.dataset.status = status;

                const day = document.createElement('span');
                day.className = 'ws-day';
                day.textContent = DAYS[i];

                const statusLabel = document.createElement('span');
                statusLabel.className = 'ws-status';
                statusLabel.textContent = cfg.label || '—';
                statusLabel.dataset.status = status;

                const copyBtn = document.createElement('button');
                copyBtn.className = 'ws-copy';
                copyBtn.textContent = '📄';
                copyBtn.title = 'Copiar nota';
                copyBtn.setAttribute('aria-label', 'Copiar nota de ' + DAYS[i]);
                if (!note.trim()) copyBtn.style.visibility = 'hidden';

                copyBtn.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    ev.preventDefault();
                    const plain = note.replace(/\[img:[^\]]*\]/g, '').trim();
                    this._wsCopyText(plain, copyBtn, '📄');
                });

                top.appendChild(dot);
                top.appendChild(day);
                top.appendChild(statusLabel);
                top.appendChild(copyBtn);

                const noteEl = document.createElement('div');
                noteEl.className = 'ws-note' + (note.trim() ? '' : ' ws-empty');
                noteEl.textContent = note.trim()
                    ? note.replace(/\[img:[^\]]*\]/g, '[imagem]')
                    : '—';

                row.appendChild(top);
                row.appendChild(noteEl);
                list.appendChild(row);
            });

            contentArea.appendChild(list);

            const copyAll = document.createElement('button');
            copyAll.className = 'ws-copy-all';
            copyAll.textContent = '📋 Copiar tudo';
            copyAll.setAttribute('aria-label', 'Copiar todas as notas');
            copyAll.addEventListener('click', (ev) => {
                ev.stopPropagation();
                ev.preventDefault();
                const allNotes = dates
                    .map((_, i) => (weekData[i].note || '').replace(/\[img:[^\]]*\]/g, '').trim())
                    .filter(n => n.length > 0);
                this._wsCopyText(allNotes.join('\n'), copyAll, '📋 Copiar tudo');
            });
            contentArea.appendChild(copyAll);
        };

        // ── Event listeners de navegação ──────────────────────
        prevBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            weekOffset--;
            renderWeek(weekOffset);
        });
        nextBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            if (weekOffset < 0) {
                weekOffset++;
                renderWeek(weekOffset);
            }
        });

        // ── Fechar ────────────────────────────────────────────
        overlay.addEventListener('click', (ev) => {
            if (ev.target === overlay) this._closeWeekSummaryPopup();
        });
        closeBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            this._closeWeekSummaryPopup();
        });
        const onEsc = (ev) => {
            if (ev.key === 'Escape') {
                this._closeWeekSummaryPopup();
                document.removeEventListener('keydown', onEsc);
            }
        };
        document.addEventListener('keydown', onEsc);

        // ── Renderização inicial ──────────────────────────────
        await renderWeek(0);
        requestAnimationFrame(() => closeBtn.focus());
    },

    _wsCopyText(text, btnEl, originalLabel) {
        const ok = () => {
            btnEl.textContent = '✅';
            setTimeout(() => { btnEl.textContent = originalLabel; }, 1200);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(ok).catch(() => this._wsCopyFallback(text, btnEl, originalLabel));
        } else {
            this._wsCopyFallback(text, btnEl, originalLabel);
        }
    },

    _wsCopyFallback(text, btnEl, originalLabel) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch {}
        document.body.removeChild(ta);
        btnEl.textContent = '✅';
        setTimeout(() => { btnEl.textContent = originalLabel; }, 1200);
    },

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
                el.appendChild(document.createTextNode(line));
            }
            if (idx < lines.length - 1) {
                el.appendChild(document.createElement('br'));
            }
        });
    },

    _getEditableText(el) {
        let text = '';
        const walk = (node) => {
            if (node.nodeType === Node.TEXT_NODE) {
                text += node.nodeValue;
            } else if (node.nodeType === Node.ELEMENT_NODE) {
                const tag = node.nodeName.toUpperCase();
                if (tag === 'IMG' && node.dataset.imgMarker) {
                    if (text.length > 0 && !text.endsWith('\n')) text += '\n';
                    text += `[img:${node.dataset.imgMarker}]`;
                } else if (tag === 'BR') {
                    text += '\n';
                } else if (tag === 'DIV' || tag === 'P') {
                    if (text.length > 0 && !text.endsWith('\n')) {
                        text += '\n';
                    }
                    node.childNodes.forEach(walk);
                } else {
                    node.childNodes.forEach(walk);
                }
            }
        };
        el.childNodes.forEach(walk);
        return text.replace(/\n+$/, '');
    },

});
