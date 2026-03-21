// ============================================
// SISTEMA DE AUTENTICAÇÃO - SUPABASE
// ============================================

class AuthManager {
    constructor() {
        this.currentUser = null;
        this.checkAuthState();
    }

    // Verificar estado de autenticação
    async checkAuthState() {
        const { data: { session } } = await supabase.auth.getSession();
        
        if (session) {
            this.currentUser = session.user;
            this.showApp();
        } else {
            this.showAuth();
        }

        // Listener para mudanças de autenticação
        supabase.auth.onAuthStateChange((event, session) => {
            if (event === 'SIGNED_IN') {
                this.currentUser = session.user;
                this.showApp();
            } else if (event === 'SIGNED_OUT') {
                this.currentUser = null;
                this.showAuth();
            }
        });
    }

    // Mostrar tela de autenticação
    showAuth() {
        document.getElementById('authContainer').classList.remove('hidden');
        document.getElementById('appContainer').classList.add('hidden');
    }

    // Mostrar aplicação
    showApp() {
        document.getElementById('authContainer').classList.add('hidden');
        document.getElementById('appContainer').classList.remove('hidden');
        
        // Atualizar informações do usuário
        this.updateUserInfo();
        
        // Inicializar app com dados do usuário
        if (window.app) {
            window.app.loadUserData();
        }
    }

    // Atualizar informações do usuário na UI
    updateUserInfo() {
        if (this.currentUser) {
            const userEmailElement = document.getElementById('userEmail');
            if (userEmailElement) {
                userEmailElement.textContent = this.currentUser.email;
            }
        }
    }

    // Cadastro
    async signUp(email, password, name) {
        try {
            const { data, error } = await supabase.auth.signUp({
                email: email,
                password: password,
                options: {
                    data: {
                        full_name: name
                    }
                }
            });

            if (error) throw error;

            return { success: true, message: 'Cadastro realizado! Verifique seu email para confirmar.' };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    // Login
    async signIn(email, password) {
        try {
            const { data, error } = await supabase.auth.signInWithPassword({
                email: email,
                password: password
            });

            if (error) throw error;

            return { success: true, message: 'Login realizado com sucesso!' };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    // Logout
    async signOut() {
        try {
            const { error } = await supabase.auth.signOut();
            if (error) throw error;
            
            // Limpar dados locais
            localStorage.clear();
            
            return { success: true };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    // Resetar senha
    async resetPassword(email) {
        try {
            const { error } = await supabase.auth.resetPasswordForEmail(email, {
                redirectTo: window.location.origin
            });

            if (error) throw error;

            return { success: true, message: 'Email de recuperação enviado!' };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    // Obter usuário atual
    getCurrentUser() {
        return this.currentUser;
    }

    // Obter ID do usuário
    getUserId() {
        return this.currentUser?.id;
    }
}

// Inicializar gerenciador de autenticação
const authManager = new AuthManager();

// Event Listeners para formulários
document.addEventListener('DOMContentLoaded', () => {
    // Alternar entre login e cadastro
    const showSignUpBtn = document.getElementById('showSignUp');
    const showSignInBtn = document.getElementById('showSignIn');
    const signInForm = document.getElementById('signInForm');
    const signUpForm = document.getElementById('signUpForm');

    showSignUpBtn?.addEventListener('click', (e) => {
        e.preventDefault();
        signInForm.classList.add('hidden');
        signUpForm.classList.remove('hidden');
    });

    showSignInBtn?.addEventListener('click', (e) => {
        e.preventDefault();
        signUpForm.classList.add('hidden');
        signInForm.classList.remove('hidden');
    });

    // Form de Login
    document.getElementById('loginForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const email = document.getElementById('loginEmail').value;
        const password = document.getElementById('loginPassword').value;
        const submitBtn = e.target.querySelector('button[type="submit"]');
        const originalText = submitBtn.textContent;

        submitBtn.disabled = true;
        submitBtn.textContent = 'Entrando...';

        const result = await authManager.signIn(email, password);
        
        if (result.success) {
            showMessage('success', result.message);
        } else {
            showMessage('error', result.message);
            submitBtn.disabled = false;
            submitBtn.textContent = originalText;
        }
    });

    // Form de Cadastro
    document.getElementById('registerForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const name = document.getElementById('registerName').value;
        const email = document.getElementById('registerEmail').value;
        const password = document.getElementById('registerPassword').value;
        const confirmPassword = document.getElementById('registerConfirmPassword').value;
        const submitBtn = e.target.querySelector('button[type="submit"]');
        const originalText = submitBtn.textContent;

        if (password !== confirmPassword) {
            showMessage('error', 'As senhas não coincidem!');
            return;
        }

        if (password.length < 6) {
            showMessage('error', 'A senha deve ter no mínimo 6 caracteres!');
            return;
        }

        submitBtn.disabled = true;
        submitBtn.textContent = 'Cadastrando...';

        const result = await authManager.signUp(email, password, name);
        
        if (result.success) {
            showMessage('success', result.message);
            // Voltar para tela de login após 2 segundos
            setTimeout(() => {
                signUpForm.classList.add('hidden');
                signInForm.classList.remove('hidden');
            }, 2000);
        } else {
            showMessage('error', result.message);
        }
        
        submitBtn.disabled = false;
        submitBtn.textContent = originalText;
    });

    // Botão de Logout
    document.getElementById('btnLogout')?.addEventListener('click', async () => {
        if (confirm('Deseja realmente sair?')) {
            await authManager.signOut();
        }
    });

    // Link de recuperação de senha
    document.getElementById('forgotPassword')?.addEventListener('click', async (e) => {
        e.preventDefault();
        const email = prompt('Digite seu email para recuperação de senha:');
        
        if (email) {
            const result = await authManager.resetPassword(email);
            showMessage(result.success ? 'success' : 'error', result.message);
        }
    });
});

// Função para mostrar mensagens
function showMessage(type, message) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `auth-message ${type}`;
    messageDiv.textContent = message;
    
    const container = document.querySelector('.auth-form.active') || document.querySelector('.auth-form');
    if (container) {
        // Remover mensagens antigas
        container.querySelectorAll('.auth-message').forEach(msg => msg.remove());
        
        // Adicionar nova mensagem
        container.insertBefore(messageDiv, container.firstChild);
        
        // Remover após 5 segundos
        setTimeout(() => messageDiv.remove(), 5000);
    }
}
