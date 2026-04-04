// app-week-bar.js — Mixin: Week bar, day picker, tooltips, image paste, links
// Extends HabitTrackerApp.prototype

Object.assign(HabitTrackerApp.prototype, {

    getWeekMonday(date) {
        const d = new Date(date);
        const dow = d.getDay(); // 0=Dom, 1=Seg, ..., 6=Sab
        const diff = (dow === 0) ? -6 : 1 - dow;
        d.setDate(d.getDate() + diff);
        d.setHours(0, 0, 0, 0);
        return d;
    },

    async renderItemWeekBar(category, itemId, refDate) {
        const labels      = ['S', 'T', 'Q', 'Q', 'S', 'S', 'D'];
        const monday      = this.getWeekMonday(refDate);
        const todayStr    = this.getDateString(new Date());
        const viewingStr  = this.getDateString(refDate);

        const bar = document.createElement('div');
        bar.className = 'item-week-bar';
        bar.dataset.category = category;
        bar.dataset.itemId   = itemId;

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

            if (isViewing || isToday) {
                const arrow = document.createElement('div');
                arrow.className = 'week-bar-arrow' + (isViewing ? ' week-bar-arrow--viewing' : '');
                arrow.textContent = '▲';
                dayEl.appendChild(arrow);
            }

            bar.appendChild(dayEl);
        });

        return bar;
    },

    _showWeekDayPicker(dayEl, blockEl, dateStr, category, itemId, item) {
        this._hideWeekBarTooltip(true);
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

                await this._propagateStatusToLinks(dateStr, category, itemId, opt.key);

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

        const rect = blockEl.getBoundingClientRect();
        const pickerW = 162;
        let left = rect.left + rect.width / 2 - pickerW / 2;
        let top  = rect.bottom + 6;

        if (left < 6) left = 6;
        if (left + pickerW > window.innerWidth - 6) left = window.innerWidth - pickerW - 6;
        if (top + 280 > window.innerHeight - 6) top = rect.top - 280 - 4;

        picker.style.left  = `${left}px`;
        picker.style.top   = `${top}px`;
        picker.style.width = `${pickerW}px`;
        picker.style.transformOrigin = `${rect.left + rect.width/2 - left}px top`;

        const close = (e) => {
            if (!picker.contains(e.target)) {
                picker.classList.add('wday-picker-out');
                picker.addEventListener('animationend', () => picker.remove(), { once: true });
                document.removeEventListener('click', close, true);
            }
        };
        setTimeout(() => document.addEventListener('click', close, true), 10);
    },

    // ── Note Image Paste (Ctrl/Cmd+V com imagem) ──────────────────────────
    _initNoteImagePaste() {
        if (this._noteImagePasteInited) return;
        this._noteImagePasteInited = true;

        document.addEventListener('paste', async (ev) => {
            const target = ev.target.closest ? ev.target : ev.target.parentElement;
            if (!target || !target.closest('.item-note-editable')) return;

            const items = ev.clipboardData?.items;
            if (!items) return;

            let imageFile = null;
            for (const item of items) {
                if (item.type.startsWith('image/')) {
                    imageFile = item.getAsFile();
                    break;
                }
            }
            if (!imageFile) return;

            ev.preventDefault();
            ev.stopPropagation();

            const noteEditable = target.closest('.item-note-editable');
            const itemEl       = noteEditable.closest('.item');
            if (!itemEl) return;
            const category = itemEl.dataset.category;
            const itemId   = itemEl.dataset.itemId;
            if (!category || !itemId) return;

            const uploadIndicator = document.createElement('div');
            uploadIndicator.className = 'note-img-upload-indicator';
            uploadIndicator.textContent = '📷 Enviando imagem…';
            noteEditable.insertAdjacentElement('afterend', uploadIndicator);

            try {
                const url = await StorageManager.uploadNoteImage(imageFile);
                uploadIndicator.remove();

                if (!url) {
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
            const t = ev.target.closest ? ev.target : ev.target.parentElement;
            if (!t) return;
            const wrap = t.closest('.note-img-wrap');
            if (!wrap) return;
            const thumb = wrap.querySelector('.note-img-thumb');
            if (!thumb) return;
            clearTimeout(this._imgPreviewTimer);
            this._imgPreviewTimer = setTimeout(() => {
                this._showNoteImgPreview(thumb);
            }, 500);
        }, true);

        document.addEventListener('mouseleave', (ev) => {
            const t = ev.target.closest ? ev.target : ev.target.parentElement;
            if (!t) return;
            const wrap = t.closest('.note-img-wrap');
            if (!wrap) return;
            clearTimeout(this._imgPreviewTimer);
        }, true);

        document.addEventListener('mouseenter', (ev) => {
            const t = ev.target.closest ? ev.target : ev.target.parentElement;
            if (t && t.closest('.note-img-preview')) {
                clearTimeout(this._imgPreviewTimer);
            }
        }, true);

        document.addEventListener('mouseleave', (ev) => {
            const t = ev.target.closest ? ev.target : ev.target.parentElement;
            if (t && t.closest('.note-img-preview')) {
                this._hideNoteImgPreview();
            }
        }, true);
    },

    _insertImageInNote(noteEditable, itemEl, category, itemId, url) {
        const currentText = this._getEditableText(noteEditable);
        const imgMarker   = `[img:${url}]`;
        const newText     = currentText ? `${currentText}\n${imgMarker}` : imgMarker;

        this._textToEditable(noteEditable, newText);

        this.saveInlineNote(itemEl, category, itemId, newText).then(() => {
            setTimeout(() => {
                this.exitCurrentEditMode(false);
            }, 50);
        });
    },

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

        const rect   = thumb.getBoundingClientRect();
        const margin = 8;
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
    },

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
    },

    // ── Weekbar Note Tooltip ──────────────────────────────────────────────
    _initWeekBarTooltips() {
        if (this._weekbarTooltipInited) return;
        this._weekbarTooltipInited = true;

        this._activeTooltip = null;
        this._tooltipHideTimer = null;
        this._tooltipHoverTimer = null;
        this._longPressTimer = null;
        this._tooltipSaveTimer = null;

        const isMobile = () => window.matchMedia('(max-width: 768px)').matches || ('ontouchstart' in window);

        const getBlock = (el) => {
            if (!el || !el.closest) el = el && el.parentElement;
            if (!el) return null;
            const block = el.closest('.week-bar-block');
            if (!block || block.dataset.isToday === '1') return null;
            return block;
        };

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
            if (this._activeTooltipBlock && this._activeTooltipBlock !== block && shouldKeepOpen()) return;
            clearTimeout(this._tooltipHoverTimer);
            this._tooltipHoverTimer = setTimeout(() => {
                this._showWeekBarTooltip(block);
            }, 500);
        }, true);

        document.addEventListener('mouseleave', (ev) => {
            if (isMobile()) return;
            const block = getBlock(ev.target);
            if (!block) return;
            clearTimeout(this._tooltipHoverTimer);
            if (shouldKeepOpen()) return;
            this._tooltipHideTimer = setTimeout(() => {
                if (!shouldKeepOpen()) this._hideWeekBarTooltip();
            }, 300);
        }, true);

        document.addEventListener('mouseenter', (ev) => {
            if (isMobile()) return;
            const t = ev.target.closest ? ev.target : ev.target.parentElement;
            if (t && t.closest('.weekbar-tooltip')) {
                clearTimeout(this._tooltipHideTimer);
            }
        }, true);

        document.addEventListener('mouseleave', (ev) => {
            if (isMobile()) return;
            const t = ev.target.closest ? ev.target : ev.target.parentElement;
            if (t && t.closest('.weekbar-tooltip')) {
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
                _longPressBlock = null;
            }, 400);
        }, { passive: true });

        document.addEventListener('touchend', (ev) => {
            clearTimeout(this._longPressTimer);
            if (this._activeTooltip && !_longPressBlock) {
                // tooltip was just shown by long-press
            }
            _longPressBlock = null;
        }, true);

        document.addEventListener('touchmove', () => {
            clearTimeout(this._longPressTimer);
            _longPressBlock = null;
        }, true);
    },

    _showWeekBarTooltip(block, isMobile = false) {
        this._hideWeekBarTooltip(true);

        const note      = (block.dataset.note || '').trim();
        const dateStr   = block.dataset.date;
        const category  = block.dataset.category;
        const itemId    = block.dataset.itemId;
        if (!dateStr || !category || !itemId) return;

        const todayStr  = this.getDateString(new Date());
        const isFuture  = dateStr > todayStr;
        const isPast    = dateStr < todayStr;

        const tooltip = document.createElement('div');
        tooltip.className = 'weekbar-tooltip weekbar-tooltip--editable';

        const d = new Date(dateStr + 'T12:00:00');
        const weekdays = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
        const months = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
        const dateLabel = `${weekdays[d.getDay()]} ${d.getDate()} ${months[d.getMonth()]}`;

        const headerEl = document.createElement('div');
        headerEl.className = 'weekbar-tooltip-header';
        headerEl.textContent = dateLabel;
        tooltip.appendChild(headerEl);

        const closeBtn = document.createElement('button');
        closeBtn.className = 'weekbar-tooltip-close';
        closeBtn.textContent = '✕';
        closeBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            this._hideWeekBarTooltip();
        });
        tooltip.appendChild(closeBtn);

        const textarea = document.createElement('textarea');
        textarea.className = 'weekbar-tooltip-textarea';
        textarea.value = note;
        textarea.placeholder = isFuture
            ? 'Escreva demanda futura…'
            : 'Adicionar anotação…';
        textarea.rows = 3;
        tooltip.appendChild(textarea);

        const saveIndicator = document.createElement('div');
        saveIndicator.className = 'weekbar-tooltip-save-indicator';
        tooltip.appendChild(saveIndicator);

        let saveTimer = null;
        const nextDayBtn = document.createElement('button');
        nextDayBtn.className = 'weekbar-tooltip-next-day';
        nextDayBtn.title = 'Passar para próximo dia';
        nextDayBtn.textContent = '⏭';
        nextDayBtn.addEventListener('click', async (ev) => {
            ev.stopPropagation();

            const [y, m, dd] = dateStr.split('-').map(Number);
            const nextDate    = new Date(y, m - 1, dd + 1);
            const nextDateStr = this.getDateString(nextDate);

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

            const nextData   = await StorageManager.getItemStatus(nextDateStr, category, itemId);
            const nextNote   = (nextData.note || '').trim();
            const nextStatus = nextData.status || 'none';

            const mergedNote = nextNote ? nextNote : currentNote;

            await StorageManager.saveItemStatus(nextDateStr, category, itemId, nextStatus, mergedNote);

            nextDayBtn.textContent = '✅ Copiado!';
            nextDayBtn.disabled = true;

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

            if (newNote) {
                block.dataset.note = newNote;
            } else {
                delete block.dataset.note;
            }

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

        textarea.addEventListener('blur', () => {
            clearTimeout(saveTimer);
            const newNote = textarea.value.trim();
            const oldNote = (block.dataset.note || '').trim();
            if (newNote !== oldNote || (newNote && !block.dataset.note)) {
                autoSave();
            }
        });

        textarea.addEventListener('click', (ev) => ev.stopPropagation());
        textarea.addEventListener('mousedown', (ev) => ev.stopPropagation());

        document.body.appendChild(tooltip);
        this._activeTooltip = tooltip;
        this._activeTooltipBlock = block;

        const blockRect = block.getBoundingClientRect();
        const tipRect   = tooltip.getBoundingClientRect();

        let left = blockRect.left + blockRect.width / 2 - tipRect.width / 2;
        let top  = blockRect.top - tipRect.height - 8;

        const margin = 8;
        if (left < margin) left = margin;
        if (left + tipRect.width > window.innerWidth - margin) {
            left = window.innerWidth - margin - tipRect.width;
        }
        if (top < margin) {
            top = blockRect.bottom + 8;
            tooltip.classList.add('weekbar-tooltip--below');
        }

        tooltip.style.left = `${left}px`;
        tooltip.style.top  = `${top}px`;

        const arrowLeft = blockRect.left + blockRect.width / 2 - left;
        tooltip.style.setProperty('--arrow-left', `${arrowLeft}px`);

        if (!isMobile) {
            setTimeout(() => {
                textarea.focus();
                textarea.setSelectionRange(textarea.value.length, textarea.value.length);
            }, 80);

            const closeDesktop = (e) => {
                if (!tooltip.contains(e.target) && !block.contains(e.target)) {
                    const newNote = textarea.value.trim();
                    if (newNote !== note) autoSave();
                    this._hideWeekBarTooltip();
                    document.removeEventListener('mousedown', closeDesktop, true);
                }
            };
            setTimeout(() => document.addEventListener('mousedown', closeDesktop, true), 100);
            tooltip._desktopCloseHandler = closeDesktop;
        }

        if (isMobile) {
            const closeMobile = (e) => {
                if (!tooltip.contains(e.target)) {
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
    },

    _hideWeekBarTooltip(immediate = false) {
        const tip = this._activeTooltip;
        if (!tip) return;
        this._activeTooltip = null;
        this._activeTooltipBlock = null;
        clearTimeout(this._tooltipSaveTimer);
        clearTimeout(this._tooltipHoverTimer);

        if (tip._desktopCloseHandler) {
            document.removeEventListener('mousedown', tip._desktopCloseHandler, true);
        }

        if (immediate) {
            tip.remove();
            return;
        }
        tip.classList.add('weekbar-tooltip--closing');
        tip.addEventListener('animationend', () => tip.remove(), { once: true });
        setTimeout(() => { if (tip.parentNode) tip.remove(); }, 200);
    },

    // ── Item Link / Vincular ──────────────────────────────────────────────
    async _showLinkPicker(btn, category, itemId, itemEl) {
        document.querySelectorAll('.link-picker-overlay').forEach(p => p.remove());

        const dateStr = this.getDateString();
        const currentData = await StorageManager.getItemStatus(dateStr, category, itemId);
        const currentLinks = currentData.links || [];

        const groups = [
            { key: 'clientes',   label: '👥 Clientes',  items: APP_DATA.clientes },
            { key: 'categorias', label: '🏢 Empresa',   items: APP_DATA.categorias },
            { key: 'atividades', label: '👤 Pessoal',   items: APP_DATA.atividades }
        ];

        const overlay = document.createElement('div');
        overlay.className = 'link-picker-overlay';

        const popup = document.createElement('div');
        popup.className = 'link-picker-popup';

        const header = document.createElement('div');
        header.className = 'link-picker-header';
        header.innerHTML = `<span>🔗 Vincular item</span><button class="link-picker-close">✕</button>`;
        popup.appendChild(header);

        const sourceItem = (APP_DATA[category] || []).find(i => i.id === itemId);
        const sourceName = sourceItem ? sourceItem.name : itemId;
        const sourceNote = (currentData.note || '').trim();
        const sourceBlock = document.createElement('div');
        sourceBlock.className = 'link-picker-source';
        sourceBlock.innerHTML = `<div class="link-picker-source-name">${this._escapeHtml(sourceName)}</div>`
            + (sourceNote ? `<div class="link-picker-source-note">${this._escapeHtml(sourceNote)}</div>` : '');
        popup.appendChild(sourceBlock);

        const listWrap = document.createElement('div');
        listWrap.className = 'link-picker-list';

        for (const group of groups) {
            const groupEl = document.createElement('div');
            groupEl.className = 'link-picker-group-label';
            groupEl.textContent = group.label;
            listWrap.appendChild(groupEl);

            for (const it of group.items) {
                if (group.key === category && it.id === itemId) continue;

                const isLinked = currentLinks.some(l => l.category === group.key && l.itemId === it.id);

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

        requestAnimationFrame(() => popup.focus());

        const close = () => {
            overlay.classList.add('link-picker-closing');
            overlay.addEventListener('animationend', () => overlay.remove(), { once: true });
            setTimeout(() => { if (overlay.parentNode) overlay.remove(); }, 300);
        };

        header.querySelector('.link-picker-close').addEventListener('click', close);
        btnCancel.addEventListener('click', close);
        overlay.addEventListener('click', (ev) => {
            if (ev.target === overlay) close();
        });

        btnOk.addEventListener('click', async () => {
            const checkboxes = listWrap.querySelectorAll('.link-picker-cb');
            const newLinks = [];
            checkboxes.forEach(cb => {
                if (cb.checked) {
                    newLinks.push({ category: cb.dataset.cat, itemId: cb.dataset.itemId });
                }
            });

            await StorageManager.saveItemStatus(dateStr, category, itemId, currentData.status || 'none', currentData.note || '', newLinks);

            for (const lnk of newLinks) {
                const targetData = await StorageManager.getItemStatus(dateStr, lnk.category, lnk.itemId);
                const targetLinks = targetData.links || [];
                const alreadyLinked = targetLinks.some(l => l.category === category && l.itemId === itemId);
                if (!alreadyLinked) {
                    targetLinks.push({ category, itemId });
                    await StorageManager.saveItemStatus(dateStr, lnk.category, lnk.itemId, targetData.status || 'none', targetData.note || '', targetLinks);
                }
            }

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
    },

    async _removeLink(sourceCat, sourceId, targetCat, targetId) {
        const dateStr = this.getDateString();

        const sourceData = await StorageManager.getItemStatus(dateStr, sourceCat, sourceId);
        const sourceLinks = (sourceData.links || []).filter(l => !(l.category === targetCat && l.itemId === targetId));
        await StorageManager.saveItemStatus(dateStr, sourceCat, sourceId, sourceData.status || 'none', sourceData.note || '', sourceLinks);

        const targetData = await StorageManager.getItemStatus(dateStr, targetCat, targetId);
        const targetLinks = (targetData.links || []).filter(l => !(l.category === sourceCat && l.itemId === sourceId));
        await StorageManager.saveItemStatus(dateStr, targetCat, targetId, targetData.status || 'none', targetData.note || '', targetLinks);

        this._todayScrollTop = window.scrollY;
        this._pendingScrollRestore = true;
        this.renderTodayView();
    },

    async _propagateStatusToLinks(dateStr, category, itemId, newStatus) {
        const data = await StorageManager.getItemStatus(dateStr, category, itemId);
        const links = data.links || [];
        if (links.length === 0) return;

        for (const lnk of links) {
            const targetData = await StorageManager.getItemStatus(dateStr, lnk.category, lnk.itemId);
            if (targetData.status !== newStatus) {
                await StorageManager.saveItemStatus(dateStr, lnk.category, lnk.itemId, newStatus, targetData.note || '');
            }
        }
    },

});
