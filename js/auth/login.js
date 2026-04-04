// ============================================
// LOGIN.JS - Autenticação separada do app
// ============================================

// --- Mapeamento de erros Supabase → PT-BR ---
const SUPABASE_ERROR_MAP = {
    'Invalid login credentials':   'Email ou senha incorretos.',
    'Email not confirmed':         'Email não confirmado. Verifique sua caixa de entrada.',
    'User already registered':     'Este email já está cadastrado.',
    'Password should be at least': 'A senha deve ter no mínimo 8 caracteres.',
    'Unable to validate email':    'Email inválido. Verifique se digitou corretamente.',
    'is invalid':                  'Email inválido. Verifique se digitou corretamente.',
    'signup is disabled':          'Novos cadastros estão temporariamente desativados.',
    'signups are disabled':        'Novos cadastros estão temporariamente desativados.',
    'logins are disabled':         'Login por email está temporariamente desativado.',
    'Email rate limit exceeded':   'Muitas tentativas. Aguarde alguns minutos e tente novamente.',
    'email rate limit exceeded':   'Muitas tentativas. Aguarde alguns minutos e tente novamente.',
    'over_email_send_rate_limit':  'Muitas tentativas. Aguarde alguns minutos e tente novamente.',
    'Too many requests':           'Muitas tentativas. Aguarde alguns minutos e tente novamente.',
    'Token has expired':           'O link expirou. Solicite um novo.',
    'Auth session missing':        'Sessão expirada. Faça login novamente.',
};

function mapSupabaseError(msg) {
    if (!msg) return 'Ocorreu um erro. Tente novamente.';
    for (const [k, v] of Object.entries(SUPABASE_ERROR_MAP)) {
        if (msg.includes(k)) return v;
    }
    return 'Ocorreu um erro. Tente novamente.';
}

// --- Validação de força de senha ---
function validatePasswordStrength(password) {
    return password.length >= 8 && (/[0-9]/.test(password) || /[^a-zA-Z0-9]/.test(password));
}

// --- Esperar biblioteca Supabase carregar ---
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
            setTimeout(() => {
                clearInterval(checkInterval);
                resolve(false);
            }, 5000);
        }
    });
}

// --- Referências DOM (module-level) ---
const showSignUpBtn = document.getElementById('showSignUp');
const showSignInBtn = document.getElementById('showSignIn');
const signInForm = document.getElementById('signInForm');
const signUpForm = document.getElementById('signUpForm');
const resetPasswordForm = document.getElementById('resetPasswordForm');

// --- Alternar entre login e cadastro ---
showSignUpBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    signInForm.classList.add('hidden');
    signUpForm.classList.remove('hidden');
    resetPasswordForm.classList.add('hidden');
    clearMessages();
});

showSignInBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    signUpForm.classList.add('hidden');
    signInForm.classList.remove('hidden');
    resetPasswordForm.classList.add('hidden');
    clearMessages();
});

// --- Show/Hide password toggle ---
document.querySelectorAll('.btn-toggle-password').forEach(btn => {
    btn.addEventListener('click', () => {
        const input = document.getElementById(btn.dataset.target);
        if (!input) return;
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        btn.querySelector('.icon-eye')?.classList.toggle('hidden', show);
        btn.querySelector('.icon-eye-off')?.classList.toggle('hidden', !show);
        btn.setAttribute('aria-label', show ? 'Ocultar senha' : 'Mostrar senha');
    });
});

// --- Função para mostrar mensagens ---
function showMessage(type, message) {
    const activeForm = document.querySelector('.auth-form:not(.hidden)');
    if (!activeForm) return;
    clearMessages();
    const messageDiv = document.createElement('div');
    messageDiv.className = `auth-message ${type}`;
    messageDiv.textContent = message;
    activeForm.insertBefore(messageDiv, activeForm.firstChild);
    setTimeout(() => { messageDiv.remove(); }, 5000);
}

// --- Limpar todas as mensagens ---
function clearMessages() {
    document.querySelectorAll('.auth-message').forEach(msg => msg.remove());
}

// --- Validar email ---
function isValidEmail(email) {
    const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return regex.test(email);
}

// ============================================
// MAIN — Aguardar carregamento completo
// ============================================
window.addEventListener('load', async () => {
    console.log('=== LOGIN.JS CARREGADO ===');

    // Esperar Supabase carregar
    const supabaseLoaded = await waitForSupabase();
    if (!supabaseLoaded) {
        console.error('Timeout: Biblioteca Supabase não carregou');
        showMessage('error', 'Erro ao carregar. Por favor, recarregue a página.');
        return;
    }

    // Inicializar Supabase
    const supabaseClient = window.getSupabaseClient();
    if (!supabaseClient) {
        console.error('Erro ao inicializar Supabase');
        showMessage('error', 'Erro ao carregar. Recarregue a página.');
        return;
    }
    console.log('Cliente Supabase inicializado com sucesso');

    // --- Referências DOM internas ---
    const loginFields = document.getElementById('loginFields');
    const forgotPasswordSection = document.getElementById('forgotPasswordSection');
    const loginSubmitBtn = document.getElementById('loginSubmitBtn');

    // --- Rate limiting frontend ---
    let loginAttempts = 0;
    let loginBlockedUntil = 0;
    let loginCooldownTimer = null;

    function isLoginBlocked() { return Date.now() < loginBlockedUntil; }
    function getBlockRemaining() { return Math.ceil((loginBlockedUntil - Date.now()) / 1000); }

    function applyRateLimit() {
        loginAttempts++;
        if (loginAttempts >= 5) {
            loginBlockedUntil = Date.now() + 2 * 60 * 1000;
        } else if (loginAttempts >= 3) {
            loginBlockedUntil = Date.now() + 30 * 1000;
        }
    }

    function startCooldownDisplay(btn, originalText) {
        if (loginCooldownTimer) clearInterval(loginCooldownTimer);
        btn.disabled = true;
        loginCooldownTimer = setInterval(() => {
            const remaining = getBlockRemaining();
            if (remaining <= 0) {
                clearInterval(loginCooldownTimer);
                loginCooldownTimer = null;
                btn.disabled = false;
                btn.classList.remove('loading');
                btn.textContent = originalText;
            } else {
                btn.textContent = `Aguarde ${remaining}s`;
            }
        }, 500);
    }

    // --- Verificar sessão existente ---
    try {
        const { data: { session } } = await supabaseClient.auth.getSession();
        if (session) {
            console.log('Sessão encontrada, redirecionando...');
            window.location.href = 'app.html';
            return;
        } else {
            console.log('Nenhuma sessão ativa');
        }
    } catch (error) {
        console.error('Erro ao verificar sessão:', error);
    }

    // --- Listener para mudanças de autenticação ---
    supabaseClient.auth.onAuthStateChange((event, session) => {
        console.log('Auth State Changed:', event);
        if (event === 'PASSWORD_RECOVERY') {
            signInForm.classList.add('hidden');
            signUpForm.classList.add('hidden');
            resetPasswordForm.classList.remove('hidden');
            clearMessages();
            return;
        }
        if (event === 'SIGNED_IN' && session) {
            // Só redirecionar se NÃO estamos no fluxo de reset de senha
            if (resetPasswordForm.classList.contains('hidden')) {
                console.log('Login detectado, redirecionando...');
                window.location.href = 'app.html';
            }
        }
    });

    // ============================================
    // FORM: LOGIN
    // ============================================
    document.getElementById('loginForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        console.log('=== TENTANDO LOGIN ===');

        const email = document.getElementById('loginEmail').value.trim();
        const password = document.getElementById('loginPassword').value;
        const submitBtn = loginSubmitBtn;
        const originalText = 'Entrar';

        // Rate limit check
        if (isLoginBlocked()) {
            const remaining = getBlockRemaining();
            showMessage('error', `Muitas tentativas. Aguarde ${remaining} segundos.`);
            startCooldownDisplay(submitBtn, originalText);
            return;
        }

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

            console.log('Login bem-sucedido:', data);
            loginAttempts = 0; // Reset on success
            showMessage('success', 'Login realizado! Redirecionando...');

            setTimeout(() => {
                window.location.href = 'app.html';
            }, 1000);

        } catch (error) {
            console.error('Erro no login:', error);
            applyRateLimit();
            showMessage('error', mapSupabaseError(error.message));

            if (isLoginBlocked()) {
                startCooldownDisplay(submitBtn, originalText);
            } else {
                submitBtn.disabled = false;
                submitBtn.classList.remove('loading');
                submitBtn.textContent = originalText;
            }
        }
    });

    // ============================================
    // FORM: CADASTRO
    // ============================================
    document.getElementById('registerForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        console.log('=== TENTANDO CADASTRO ===');

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

        if (!validatePasswordStrength(password)) {
            showMessage('error', 'A senha deve ter no mínimo 8 caracteres e conter pelo menos um número ou caractere especial (!@#$%...).');
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
                    emailRedirectTo: window.location.origin + '/index.html'
                }
            });

            if (error) throw error;

            console.log('Cadastro bem-sucedido:', data);

            // Limpar formulário
            e.target.reset();
            document.getElementById('passwordStrength').className = 'password-strength';
            document.getElementById('passwordStrength').textContent = '';

            // Confirm email desativado → sessão vem direto, redirecionar
            if (data.session) {
                showMessage('success', 'Conta criada com sucesso! Redirecionando...');
                setTimeout(() => {
                    window.location.href = 'app.html';
                }, 1500);
            } else {
                // Fallback: tentar login automático
                const { data: loginData, error: loginError } = await supabaseClient.auth.signInWithPassword({
                    email: email,
                    password: password
                });

                if (loginError) {
                    showMessage('success', 'Conta criada! Faça login para continuar.');
                    setTimeout(() => {
                        signUpForm.classList.add('hidden');
                        signInForm.classList.remove('hidden');
                        clearMessages();
                    }, 2000);
                } else {
                    showMessage('success', 'Conta criada com sucesso! Redirecionando...');
                    setTimeout(() => {
                        window.location.href = 'app.html';
                    }, 1500);
                }
            }

        } catch (error) {
            console.error('Erro no cadastro:', error);
            showMessage('error', mapSupabaseError(error.message));
        }

        submitBtn.disabled = false;
        submitBtn.classList.remove('loading');
        submitBtn.textContent = originalText;
    });

    // ============================================
    // ESQUECI A SENHA — UI INLINE
    // ============================================
    document.getElementById('forgotPassword')?.addEventListener('click', (e) => {
        e.preventDefault();
        // Copiar email do campo de login, se existir
        const loginEmail = document.getElementById('loginEmail').value.trim();
        if (loginEmail) {
            document.getElementById('forgotEmail').value = loginEmail;
        }
        loginFields.classList.add('hidden');
        forgotPasswordSection.classList.remove('hidden');
        clearMessages();
    });

    document.getElementById('backToLogin')?.addEventListener('click', (e) => {
        e.preventDefault();
        forgotPasswordSection.classList.add('hidden');
        loginFields.classList.remove('hidden');
        clearMessages();
    });

    document.getElementById('btnSendReset')?.addEventListener('click', async () => {
        const email = document.getElementById('forgotEmail').value.trim();
        const btn = document.getElementById('btnSendReset');
        const originalText = btn.textContent;

        if (!email) {
            showMessage('error', 'Digite seu email.');
            return;
        }

        if (!isValidEmail(email)) {
            showMessage('error', 'Digite um email válido!');
            return;
        }

        btn.disabled = true;
        btn.classList.add('loading');
        btn.textContent = '';

        try {
            const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
                redirectTo: window.location.origin + '/index.html'
            });

            if (error) throw error;

            showMessage('success', 'Email de recuperação enviado! Verifique sua caixa de entrada.');

            // Voltar para login após 3 segundos
            setTimeout(() => {
                forgotPasswordSection.classList.add('hidden');
                loginFields.classList.remove('hidden');
                clearMessages();
            }, 4000);

        } catch (error) {
            console.error('Erro ao recuperar senha:', error);
            showMessage('error', mapSupabaseError(error.message));
        }

        btn.disabled = false;
        btn.classList.remove('loading');
        btn.textContent = originalText;
    });

    // ============================================
    // FORM: NOVA SENHA (reset password)
    // ============================================
    document.getElementById('newPasswordForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();

        const newPwd = document.getElementById('newPassword').value;
        const confirmPwd = document.getElementById('confirmNewPassword').value;
        const submitBtn = e.target.querySelector('button[type="submit"]');
        const originalText = submitBtn.textContent;

        if (!newPwd || !confirmPwd) {
            showMessage('error', 'Preencha todos os campos!');
            return;
        }

        if (newPwd !== confirmPwd) {
            showMessage('error', 'As senhas não coincidem!');
            return;
        }

        if (!validatePasswordStrength(newPwd)) {
            showMessage('error', 'A senha deve ter no mínimo 8 caracteres e conter pelo menos um número ou caractere especial (!@#$%...).');
            return;
        }

        submitBtn.disabled = true;
        submitBtn.classList.add('loading');
        submitBtn.textContent = '';

        try {
            const { error } = await supabaseClient.auth.updateUser({ password: newPwd });

            if (error) throw error;

            showMessage('success', 'Senha alterada com sucesso! Faça login com sua nova senha.');

            // Sign out e voltar para login
            await supabaseClient.auth.signOut();

            setTimeout(() => {
                resetPasswordForm.classList.add('hidden');
                signInForm.classList.remove('hidden');
                clearMessages();
                showMessage('success', 'Senha alterada! Faça login com sua nova senha.');
            }, 2000);

        } catch (error) {
            console.error('Erro ao alterar senha:', error);
            showMessage('error', mapSupabaseError(error.message));
        }

        submitBtn.disabled = false;
        submitBtn.classList.remove('loading');
        submitBtn.textContent = originalText;
    });

    // ============================================
    // INDICADOR DE FORÇA DE SENHA (cadastro)
    // ============================================
    document.getElementById('registerPassword')?.addEventListener('input', (e) => {
        const el = document.getElementById('passwordStrength');
        if (!el) return;
        const v = e.target.value;
        if (!v) { el.className = 'password-strength'; el.textContent = ''; return; }
        if (v.length < 8) { el.className = 'password-strength weak'; el.textContent = 'Fraca'; }
        else if (validatePasswordStrength(v)) { el.className = 'password-strength strong'; el.textContent = 'Forte ✓'; }
        else { el.className = 'password-strength medium'; el.textContent = 'Média — adicione um número ou símbolo'; }
    });
});

// --- Registrar Service Worker para habilitar instalação PWA ---
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
}
