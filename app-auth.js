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
        console.log('Usuário autenticado:', session.user.email);
        currentUser = session.user;
        updateUserInfo();
        
        // Listener para mudanças de autenticação
        supabaseClient.auth.onAuthStateChange((event, session) => {
            console.log('Auth State Changed:', event);
            if (event === 'SIGNED_OUT' || !session) {
                // Logout ou sessão expirada
                window.location.href = 'index.html';
            } else if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
                currentUser = session.user;
                updateUserInfo();
            }
        });
    } catch (error) {
        console.error('Erro ao verificar autenticação:', error);
        window.location.href = 'index.html';
    }
})();

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

// Botão de Logout
document.getElementById('btnLogout')?.addEventListener('click', async () => {
    if (!supabaseClient) return;
    
    if (confirm('Deseja realmente sair?')) {
        try {
            // Limpar dados locais antes de fazer logout
            localStorage.clear();
            
            const { error } = await supabaseClient.auth.signOut();
            if (error) throw error;
            
            // Redirecionar para login
            window.location.href = 'index.html';
        } catch (error) {
            console.error('Erro ao fazer logout:', error);
            alert('Erro ao sair. Tente novamente.');
        }
    }
});

// Exportar funções para uso no app
window.getCurrentUserId = getCurrentUserId;
window.getCurrentUserEmail = getCurrentUserEmail;
