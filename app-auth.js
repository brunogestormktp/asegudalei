// ============================================
// APP-AUTH.JS - Proteção de autenticação
// ============================================

let currentUser = null;
let supabaseClient = null;

// Esperar biblioteca Supabase carregar
function waitForSupabase() {
    return new Promise((resolve) => {
        if (typeof supabase !== 'undefined') {
            resolve(true);
        } else {
            const checkInterval = setInterval(() => {
                if (typeof supabase !== 'undefined') {
                    clearInterval(checkInterval);
                    resolve(true);
                }
            }, 100);
            
            // Timeout após 5 segundos
            setTimeout(() => {
                clearInterval(checkInterval);
                resolve(false);
            }, 5000);
        }
    });
}

// Verificar autenticação imediatamente
window.addEventListener('load', async function checkAuth() {
    console.log('=== APP-AUTH.JS CARREGADO ===');
    
    // Esperar Supabase carregar
    const supabaseLoaded = await waitForSupabase();
    
    if (!supabaseLoaded) {
        console.error('Timeout: Biblioteca Supabase não carregou');
        window.location.href = 'index.html';
        return;
    }
    
    // Inicializar Supabase
    supabaseClient = window.getSupabaseClient();
    
    if (!supabaseClient) {
        console.error('Erro ao inicializar Supabase');
        window.location.href = 'index.html';
        return;
    }
    
    console.log('Cliente Supabase inicializado no app');
    
    try {
        const { data: { session } } = await supabaseClient.auth.getSession();
        
        if (!session) {
            // Não está autenticado, redirecionar para login
            console.log('Sem sessão, redirecionando para login');
            window.location.href = 'index.html';
            return;
        }
        
        // Usuário autenticado
        currentUser = session.user;
        updateUserInfo();
        
        // Carregar dados do Supabase ao fazer login
        if (typeof StorageManager !== 'undefined' && StorageManager.forceSyncFromSupabase) {
            console.log('Sincronizando dados do Supabase...');
            const synced = await StorageManager.forceSyncFromSupabase();
            // Neste ponto: StorageManager.syncReady === true (garantido pelo finally)

            if (synced) {
                // Re-renderizar o app com os dados atualizados do Supabase
                if (typeof app !== 'undefined' && app.renderCurrentView) {
                    // Aplicar configurações do Supabase antes do primeiro render
                    if (app.applySettings) app.applySettings();
                    app.renderCurrentView();
                } else {
                    // app ainda não foi inicializado, agendar re-render após carregamento
                    window._pendingRerender = true;
                }
            }

            // Rollover SEMPRE após sync (sucesso ou falha) — syncReady já é true
            if (typeof app !== 'undefined' && app._checkMissedRollover) {
                await app._checkMissedRollover();
            } else {
                window._pendingRollover = true;  // app ainda não existe, init() vai pegar
            }

            // Iniciar Realtime após sync inicial — sincronização instantânea entre dispositivos
            StorageManager.startRealtime(currentUser.id);
            StorageManager.startPolling(currentUser.id);
        } else if (typeof StorageManager !== 'undefined') {
            StorageManager.syncReady = true;  // Sem Supabase configurado = desbloquear rollover
        }

        // Registrar botão de logout AQUI, depois que supabaseClient está pronto
        document.getElementById('btnLogout')?.addEventListener('click', async () => {
            const confirmed = await new Promise(resolve => {
                if (typeof app !== 'undefined' && app.showConfirmModal) {
                    app.showConfirmModal('Sair', 'Deseja realmente sair?').then(resolve);
                } else {
                    resolve(confirm('Deseja realmente sair?'));
                }
            });

            if (!confirmed) return;

            try {
                // ⚠️ PROTEÇÃO: flush de dados para o Supabase ANTES de limpar localStorage
                if (typeof StorageManager !== 'undefined' && StorageManager.flushToSupabase) {
                    console.log('Fazendo flush dos dados antes do logout...');
                    await StorageManager.flushToSupabase();
                }

                const { error } = await supabaseClient.auth.signOut();
                if (error) throw error;

                // 🔒 SEGURANÇA: salvar backups TAGGEADOS com o user ID do usuário que está saindo.
                // Os backups só serão usados se o MESMO usuário fizer login novamente no mesmo dispositivo.
                // Se outro usuário entrar, os backups são descartados automaticamente pelo StorageManager.
                const loggedOutUserId = currentUser?.id;
                const dataBackup = localStorage.getItem('habit-tracker-data-backup');
                const aprendizadosBackup = localStorage.getItem('aprendizadosData');
                const settingsBackup = localStorage.getItem('_settings');

                localStorage.clear();

                if (loggedOutUserId) {
                    // Restaurar backups com tag de proprietário — só válidos para este user ID
                    if (dataBackup) {
                        localStorage.setItem('habit-tracker-data-backup', dataBackup);
                        localStorage.setItem('_data_backup_uid', loggedOutUserId);
                    }
                    if (aprendizadosBackup) {
                        localStorage.setItem('aprendizadosData', aprendizadosBackup);
                        localStorage.setItem('_aprendizados_backup_uid', loggedOutUserId);
                    }
                    if (settingsBackup) {
                        localStorage.setItem('_settings', settingsBackup);
                        localStorage.setItem('_settings_backup_uid', loggedOutUserId);
                    }
                }
                // Se por algum motivo não temos o userId, NÃO preservar nada (segurança)

                window.location.href = 'index.html';
            } catch (error) {
                console.error('Erro ao fazer logout:', error);
                alert('Erro ao sair. Tente novamente.');
            }
        });
        
        // Listener para mudanças de autenticação
        supabaseClient.auth.onAuthStateChange(async (event, session) => {
            console.log('Auth State Changed:', event);
            if (event === 'SIGNED_OUT' || !session) {
                // Parar Realtime e polling ao sair
                if (typeof StorageManager !== 'undefined' && StorageManager.stopRealtime) {
                    StorageManager.stopRealtime();
                }
                window.location.href = 'index.html';
            } else if (event === 'SIGNED_IN') {
                // SIGNED_IN pode disparar múltiplas vezes (refresh de token, etc.)
                // Só processar se o userId mudou (troca de conta) ou polling ainda não iniciou
                const newUserId = session.user.id;
                currentUser = session.user;
                updateUserInfo();

                const pollingJaAtivo = typeof StorageManager !== 'undefined'
                    && StorageManager._pollUserId === newUserId
                    && StorageManager._pollTimer;

                if (!pollingJaAtivo && typeof StorageManager !== 'undefined' && StorageManager.forceSyncFromSupabase) {
                    console.log('Sincronizando dados do Supabase após login...');
                    const synced = await StorageManager.forceSyncFromSupabase();
                    if (synced && typeof app !== 'undefined' && app.renderCurrentView) {
                        // Aplicar configurações do Supabase antes do render
                        if (app.applySettings) app.applySettings();
                        app.renderCurrentView();
                    }
                    // Rollover após re-login — syncReady já é true
                    if (typeof app !== 'undefined' && app._checkMissedRollover) {
                        await app._checkMissedRollover();
                    }
                    StorageManager.startPolling(newUserId);
                }
            } else if (event === 'TOKEN_REFRESHED') {
                currentUser = session.user;
                updateUserInfo();
                // Garantir que polling continua após refresh de token
                if (typeof StorageManager !== 'undefined') {
                    StorageManager.startPolling(session.user.id);
                }
            }
        });
    } catch (error) {
        console.error('Erro ao verificar autenticação:', error);
        window.location.href = 'index.html';
    }
});

// Atualizar informações do usuário na UI
function updateUserInfo() {
    if (currentUser) {
        const userEmailElement = document.getElementById('userEmail');
        if (userEmailElement) {
            const displayName = currentUser.user_metadata?.full_name || currentUser.email;
            userEmailElement.textContent = displayName;
        }
    }
}

// Obter ID do usuário atual
function getCurrentUserId() {
    return currentUser?.id;
}

// Obter email do usuário atual
function getCurrentUserEmail() {
    return currentUser?.email;
}

// Exportar funções para uso no app
window.getCurrentUserId = getCurrentUserId;
window.getCurrentUserEmail = getCurrentUserEmail;

// Registrar Service Worker para habilitar instalação PWA
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
}
