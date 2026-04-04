// app-speech.js — Mixin: Web Speech API (voice recognition)
// Extends HabitTrackerApp.prototype

Object.assign(HabitTrackerApp.prototype, {

    // Initialize Web Speech API (fallback safe)
    initSpeech() {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition || null;
        if (!SpeechRecognition) {
            this.recognitionSupported = false;
            return;
        }

        this.recognition = new SpeechRecognition();
        this.recognition.lang = 'pt-BR';
        this.recognition.interimResults = false;
        this.recognition.continuous = false;
        this.recognitionSupported = true;

        this.recognition.addEventListener('result', async (e) => {
            const transcript = Array.from(e.results)
                .map(r => r[0].transcript)
                .join('')
                .trim();

            if (!transcript) return;

            // Append transcript to existing note for the current recording target
            if (this.currentRecording) {
                const dateStr = this.getDateString();
                const { category, itemId } = this.currentRecording;
                const existing = await StorageManager.getItemStatus(dateStr, category, itemId);
                const prevNote = existing.note || '';
                const timestamp = new Date().toLocaleTimeString();
                const appended = (prevNote ? prevNote + '\n' : '') + `[voz ${timestamp}] ` + transcript;

                await StorageManager.saveItemStatus(dateStr, category, itemId, existing.status || 'none', appended);
                // update view
                this._todayScrollTop = window.scrollY;
                this._pendingScrollRestore = true;
                this.renderTodayView();
            }
        });

        this.recognition.addEventListener('end', () => {
            // clear recording state
            if (this.currentRecording && this.currentRecording.element) {
                this.currentRecording.element.classList.remove('recording');
            }
            this.isRecording = false;
            this.currentRecording = null;
        });

        this.recognition.addEventListener('error', (e) => {
            console.error('Speech recognition error', e);
            if (this.currentRecording && this.currentRecording.element) {
                this.currentRecording.element.classList.remove('recording');
            }
            this.isRecording = false;
            this.currentRecording = null;
        });
    },

    startRecordingFor(element, category, itemId) {
        if (!this.recognitionSupported) return;
        try {
            // If another recording is active, stop it first
            if (this.isRecording && this.currentRecording) {
                this.stopRecording();
            }

            this.currentRecording = { category, itemId, element };
            this.isRecording = true;

            // Visual indicator
            element.classList.add('recording');
            const btn = element.querySelector('.btn-mic');
            if (btn) btn.textContent = '⏹️';

            this.recognition.start();
        } catch (e) {
            console.error('Erro iniciando reconhecimento', e);
            alert('Não foi possível iniciar a gravação de voz. Verifique permissões de microfone.');
            this.isRecording = false;
            if (this.currentRecording && this.currentRecording.element) {
                this.currentRecording.element.classList.remove('recording');
            }
            this.currentRecording = null;
        }
    },

    stopRecording() {
        if (!this.recognitionSupported || !this.isRecording) return;
        try {
            if (this.recognition) {
                this.recognition.stop();
            }
        } catch (e) {
            console.error('Erro parando reconhecimento', e);
        }

        if (this.currentRecording && this.currentRecording.element) {
            const el = this.currentRecording.element;
            el.classList.remove('recording');
            const btn = el.querySelector('.btn-mic');
            if (btn) btn.textContent = '🎙️';
        }

        this.isRecording = false;
        this.currentRecording = null;
    },

});
