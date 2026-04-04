// app-onboarding.js — Mixin: Onboarding flow for new/existing users
// Extends HabitTrackerApp.prototype
//
// - New users (no date keys in data blob): full onboarding + zero default clients
// - Existing users (has date keys, no user_rankings row): light onboarding (name only)
// - Already onboarded (user_rankings row exists): skip

Object.assign(HabitTrackerApp.prototype, {

    /**
     * Checks if onboarding is needed. Called after forceSyncFromSupabase().
     * If user_rankings row exists → skip (already onboarded).
     * Otherwise, checks if user has existing data to distinguish new vs existing.
     */
    async _checkOnboarding() {
        const supabase = StorageManager.getSupabase();
        const userId = StorageManager.getUserId();
        if (!supabase || !userId) return;

        try {
            // Check if user already has a row in user_rankings (= already onboarded)
            const { data } = await supabase
                .from('user_rankings')
                .select('id')
                .eq('user_id', userId)
                .maybeSingle();

            if (data) return; // already onboarded

            // Check if this is a new user or existing user without ranking row
            const blob = await StorageManager.getData() || {};
            const hasDateKeys = Object.keys(blob).some(k => /^\d{4}-\d{2}-\d{2}$/.test(k));

            this._showOnboardingModal(!hasDateKeys); // isNewUser = !hasDateKeys
        } catch (err) {
            console.error('Onboarding check error:', err);
        }
    },

    /**
     * Shows the onboarding overlay.
     * @param {boolean} isNewUser - true if user has no existing data
     */
    _showOnboardingModal(isNewUser) {
        const overlay = document.getElementById('onboardingOverlay');
        if (!overlay) return;

        overlay.classList.remove('hidden');
        this._onboardingIsNewUser = isNewUser;

        // Pre-fill name from auth metadata if available
        const user = window.getCurrentUser?.();
        const metaName = user?.user_metadata?.full_name || '';
        const nameInput = document.getElementById('onboardingName');
        if (nameInput) nameInput.value = metaName;

        // Reset photo preview
        const preview = document.getElementById('onboardingAvatarPreview');
        if (preview) {
            preview.style.backgroundImage = '';
            preview.textContent = '📷';
        }
    },

    /**
     * Completes the onboarding flow:
     * - Sanitizes name
     * - Uploads avatar if provided
     * - Creates user_rankings row
     * - Zeros client list for new users
     * - Triggers ranking calculation
     */
    async _completeOnboarding() {
        const supabase = StorageManager.getSupabase();
        const userId = StorageManager.getUserId();
        if (!supabase || !userId) return;

        const nameInput = document.getElementById('onboardingName');
        const photoInput = document.getElementById('onboardingPhoto');
        const submitBtn = document.getElementById('onboardingSubmit');

        // Disable button to prevent double-click
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.textContent = 'Entrando...';
        }

        try {
            const rawName = nameInput?.value.trim() || 'Anônimo';
            const sanitized = rawName.replace(/[<>"'`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 50) || 'Anônimo';

            // Upload avatar if provided
            let avatarUrl = null;
            const file = photoInput?.files?.[0];
            if (file && file.size <= 2097152) {
                const allowedTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
                if (allowedTypes.includes(file.type)) {
                    const ext = file.name.split('.').pop().toLowerCase();
                    const path = `${userId}/avatar.${ext}`;
                    const { data: uploadData, error: uploadError } = await supabase.storage
                        .from('avatars')
                        .upload(path, file, { upsert: true });

                    if (uploadData && !uploadError) {
                        const { data: urlData } = supabase.storage.from('avatars').getPublicUrl(path);
                        avatarUrl = urlData?.publicUrl || null;
                    } else if (uploadError) {
                        console.warn('Avatar upload error:', uploadError);
                    }
                }
            }

            // Create row in user_rankings
            const upsertPayload = {
                user_id: userId,
                display_name: sanitized,
                show_in_ranking: true,
            };
            if (avatarUrl) {
                upsertPayload.avatar_url = avatarUrl;
            }

            const { error } = await supabase
                .from('user_rankings')
                .upsert(upsertPayload, { onConflict: 'user_id' });

            if (error) {
                console.error('Onboarding upsert error:', error);
            }

            // If new user → hide ALL default items (clientes, categorias, atividades)
            if (this._onboardingIsNewUser) {
                await this._zeroAllDefaultItems();
            }

            // Close overlay
            const overlay = document.getElementById('onboardingOverlay');
            if (overlay) overlay.classList.add('hidden');

            // Trigger ranking calculation
            if (typeof this._callCalculateRanking === 'function') {
                this._callCalculateRanking();
            }
        } catch (err) {
            console.error('Onboarding error:', err);
        } finally {
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Entrar na plataforma →';
            }
        }
    },

    /**
     * Hides ALL pre-defined items (clientes, categorias, atividades) for new users.
     * New users start with a completely empty board — zero items visible.
     * Existing users are never affected.
     */
    async _zeroAllDefaultItems() {
        const ALL_DEFAULT_CLIENTES = [
            'wolf', 'bronx', 'beeyond', 'xenon', 'amcc', 'tiger',
            'gaia', 'marcelo', 'ferny', 'premium', 'lia', 'aa-flooring'
        ];
        const ALL_DEFAULT_CATEGORIAS = [
            'empresa', 'time', 'comercial', 'clientes-cat', 'app', 'vendas',
            'financeiro', 'bsc', 'referencias', 'ia', 'ghl', 'mkt-usa'
        ];
        const ALL_DEFAULT_ATIVIDADES = [
            'oratoria', 'meditacao', 'aleatorios', 'organizar',
            'segunda-lei-conteudo', 'networking', 'ingles', 'programacao',
            'mais-dinheiro', 'oracao', 'investimentos', 'ler', 'dj',
            'conexoes', 'criar-video', 'ads', 'algoritmo',
            'agua', 'sol', 'fruta', 'abdomen', 'academia', 'walk'
        ];

        const settings = StorageManager.getSettings();
        settings.hiddenItems = {
            clientes:   [...ALL_DEFAULT_CLIENTES],
            categorias: [...ALL_DEFAULT_CATEGORIAS],
            atividades: [...ALL_DEFAULT_ATIVIDADES]
        };
        StorageManager.saveSettings(settings);
        this.applySettings();
        this.renderCurrentView();
    },

});
