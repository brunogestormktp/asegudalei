// ============================================
// APP-AUTH.JS - Proteção de autenticação
// ============================================

let currentUser = null;
let supabaseClient = null;

// Verificar autenticação imediatamente
window.addEventListener('load', async function checkAuth() {
    // Inicializar Supabase
    supabaseClient = window.getSupabaseClient();
    
    if (!supabaseClient) {
        console.error('Erro ao inicializar Supabase');
        window.location.href = 'index.html';
        return;
    }
    
    try {
        const { data: { session } } = await supabaseClient.auth.getSession();
        
        if (!session) {
            // Não está autenticado, redirecionar para login
            window.location.href = 'index.html';
            return;
        }
        
        // Usuário autenticado
        currentUser = session.user;
        updateUserInfo();
        
        // Listener para mudanças de autenticação
        supabaseClient.auth.onAuthStateChange((event, session) => {
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
