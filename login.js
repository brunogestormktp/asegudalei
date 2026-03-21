// ============================================
// LOGIN.JS - Autenticação separada do app
// ============================================

// Obter cliente Supabase
let supabaseClient = null;

// Aguardar carregamento completo
window.addEventListener('load', async () => {
    // Inicializar Supabase
    supabaseClient = window.getSupabaseClient();
    
    if (!supabaseClient) {
        console.error('Erro ao inicializar Supabase');
        showMessage('error', 'Erro ao carregar. Recarregue a página.');
        return;
    }
    
    // Verificar sessão existente
    try {
        const { data: { session } } = await supabaseClient.auth.getSession();
        
        if (session) {
            // Já está logado, redirecionar para o app
            window.location.href = 'app.html';
        }
    } catch (error) {
        console.error('Erro ao verificar sessão:', error);
    }
    
    // Listener para mudanças de autenticação
    supabaseClient.auth.onAuthStateChange((event, session) => {
        if (event === 'SIGNED_IN' && session) {
            window.location.href = 'app.html';
        }
    });
});

// Alternar entre login e cadastro
const showSignUpBtn = document.getElementById('showSignUp');
const showSignInBtn = document.getElementById('showSignIn');
const signInForm = document.getElementById('signInForm');
const signUpForm = document.getElementById('signUpForm');

showSignUpBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    signInForm.classList.add('hidden');
    signUpForm.classList.remove('hidden');
    clearMessages();
});

showSignInBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    signUpForm.classList.add('hidden');
    signInForm.classList.remove('hidden');
    clearMessages();
});

// Form de Login
document.getElementById('loginForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    if (!supabaseClient) {
        showMessage('error', 'Sistema não inicializado. Recarregue a página.');
        return;
    }
    
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    const submitBtn = e.target.querySelector('button[type="submit"]');
    const originalText = submitBtn.textContent;

    // Validações
    if (!email || !password) {
        showMessage('error', 'Preencha todos os campos!');
        return;
    }

    submitBtn.disabled = true;
    submitBtn.classList.add('loading');
    submitBtn.textContent = '';

    try {
        const { data, error } = await supabaseClient.auth.signInWithPassword({
            email: email,
            password: password
        });

        if (error) throw error;

        // Login bem-sucedido
        showMessage('success', 'Login realizado! Redirecionando...');
        
        // Aguardar um momento e redirecionar
        setTimeout(() => {
            window.location.href = 'app.html';
        }, 1000);

    } catch (error) {
        console.error('Erro no login:', error);
        let errorMessage = 'Erro ao fazer login. Tente novamente.';
        
        if (error.message.includes('Invalid login credentials')) {
            errorMessage = 'Email ou senha incorretos.';
        } else if (error.message.includes('Email not confirmed')) {
            errorMessage = 'Por favor, confirme seu email antes de fazer login.';
        }
        
        showMessage('error', errorMessage);
        submitBtn.disabled = false;
        submitBtn.classList.remove('loading');
        submitBtn.textContent = originalText;
    }
});

// Form de Cadastro
document.getElementById('registerForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    if (!supabaseClient) {
        showMessage('error', 'Sistema não inicializado. Recarregue a página.');
        return;
    }
    
    const name = document.getElementById('registerName').value.trim();
    const email = document.getElementById('registerEmail').value.trim();
    const password = document.getElementById('registerPassword').value;
    const confirmPassword = document.getElementById('registerConfirmPassword').value;
    const submitBtn = e.target.querySelector('button[type="submit"]');
    const originalText = submitBtn.textContent;

    // Validações
    if (!name || !email || !password || !confirmPassword) {
        showMessage('error', 'Preencha todos os campos!');
        return;
    }

    if (password !== confirmPassword) {
        showMessage('error', 'As senhas não coincidem!');
        return;
    }

    if (password.length < 6) {
        showMessage('error', 'A senha deve ter no mínimo 6 caracteres!');
        return;
    }

    if (!isValidEmail(email)) {
        showMessage('error', 'Digite um email válido!');
        return;
    }

    submitBtn.disabled = true;
    submitBtn.classList.add('loading');
    submitBtn.textContent = '';

    try {
        const { data, error } = await supabaseClient.auth.signUp({
            email: email,
            password: password,
            options: {
                data: {
                    full_name: name
                },
                emailRedirectTo: window.location.origin + '/app.html'
            }
        });

        if (error) throw error;

        // Cadastro bem-sucedido
        showMessage('success', 'Cadastro realizado! Verifique seu email para confirmar sua conta.');
        
        // Limpar formulário
        e.target.reset();
        
        // Voltar para tela de login após 3 segundos
        setTimeout(() => {
            signUpForm.classList.add('hidden');
            signInForm.classList.remove('hidden');
            clearMessages();
        }, 3000);

    } catch (error) {
        console.error('Erro no cadastro:', error);
        let errorMessage = 'Erro ao criar conta. Tente novamente.';
        
        if (error.message.includes('User already registered')) {
            errorMessage = 'Este email já está cadastrado.';
        }
        
        showMessage('error', errorMessage);
    }
    
    submitBtn.disabled = false;
    submitBtn.classList.remove('loading');
    submitBtn.textContent = originalText;
});

// Link de recuperação de senha
document.getElementById('forgotPassword')?.addEventListener('click', async (e) => {
    e.preventDefault();
    
    if (!supabaseClient) {
        alert('Sistema não inicializado. Recarregue a página.');
        return;
    }
    
    const email = prompt('Digite seu email para recuperação de senha:');
    
    if (!email) return;
    
    if (!isValidEmail(email)) {
        alert('Digite um email válido!');
        return;
    }

    try {
        const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
            redirectTo: window.location.origin + '/app.html'
        });

        if (error) throw error;

        showMessage('success', 'Email de recuperação enviado! Verifique sua caixa de entrada.');

    } catch (error) {
        console.error('Erro ao recuperar senha:', error);
        showMessage('error', 'Erro ao enviar email de recuperação. Tente novamente.');
    }
});

// Função para mostrar mensagens
function showMessage(type, message) {
    const activeForm = document.querySelector('.auth-form:not(.hidden)');
    if (!activeForm) return;
    
    // Remover mensagens antigas
    clearMessages();
    
    // Criar nova mensagem
    const messageDiv = document.createElement('div');
    messageDiv.className = `auth-message ${type}`;
    messageDiv.textContent = message;
    
    // Adicionar no topo do formulário
    activeForm.insertBefore(messageDiv, activeForm.firstChild);
    
    // Remover após 5 segundos
    setTimeout(() => {
        messageDiv.remove();
    }, 5000);
}

// Limpar todas as mensagens
function clearMessages() {
    document.querySelectorAll('.auth-message').forEach(msg => msg.remove());
}

// Validar email
function isValidEmail(email) {
    const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return regex.test(email);
}
