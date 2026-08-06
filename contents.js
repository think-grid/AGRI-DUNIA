const API_KEY = ""; 


        
        async function fetchWithBackoff(url, options, maxRetries = 3) {
            for (let i = 0; i < maxRetries; i++) {
                try {
                    const response = await fetch(url, options);
                    if (response.status !== 429 && response.ok) {
                        return response;
                    } else if (response.status === 429 || !response.ok) {
                        // Rate limit or other error, retry with backoff
                        const delay = Math.pow(2, i) * 1000 + Math.random() * 1000;
                        await new Promise(resolve => setTimeout(resolve, delay));
                    } else {
                        throw new Error(`API call failed with status: ${response.status}`);
                    }
                } catch (error) {
                    if (i === maxRetries - 1) throw error;
                    // Wait before retrying
                    const delay = Math.pow(2, i) * 1000 + Math.random() * 1000;
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
            throw new Error("API call failed after maximum retries");
        }

        function base64ToArrayBuffer(base64) {
            const binary_string = window.atob(base64);
            const len = binary_string.length;
            const bytes = new Uint8Array(len);
            for (let i = 0; i < len; i++) {
                bytes[i] = binary_string.charCodeAt(i);
            }
            return bytes.buffer;
        }

        function pcmToWav(pcm16, sampleRate) {
            const buffer = new ArrayBuffer(44 + pcm16.length * 2);
            const view = new DataView(buffer);
            let offset = 0;

            
            view.setUint32(offset, 0x52494646, false); offset += 4; // 'RIFF'
            view.setUint32(offset, 36 + pcm16.length * 2, true); offset += 4; // File size
            view.setUint32(offset, 0x57415645, false); offset += 4; // 'WAVE'

            
            view.setUint32(offset, 0x666d7420, false); offset += 4; // 'fmt '
            view.setUint32(offset, 16, true); offset += 4; // Chunk size (16 for PCM)
            view.setUint16(offset, 1, true); offset += 2; // Format tag (1 for PCM)
            view.setUint16(offset, 1, true); offset += 2; // Channels (1, mono)
            view.setUint32(offset, sampleRate, true); offset += 4; // Sample rate
            view.setUint32(offset, sampleRate * 2, true); offset += 4; // Byte rate (SampleRate * Channels * BitsPerSample/8)
            view.setUint16(offset, 2, true); offset += 2; // Block align (Channels * BitsPerSample/8)
            view.setUint16(offset, 16, true); offset += 2; // Bits per sample (16)

        
            view.setUint32(offset, 0x64617461, false); offset += 4; // 'data'
            view.setUint32(offset, pcm16.length * 2, true); offset += 4; // Data size

            
            for (let i = 0; i < pcm16.length; i++, offset += 2) {
                view.setInt16(offset, pcm16[i], true);
            }

            return new Blob([buffer], { type: 'audio/wav' });
        }
        const AGRI_GEMINI_MODEL = 'gemini-2.5-flash-preview-09-2025';
        const CHAT_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${AGRI_GEMINI_MODEL}:generateContent?key=${API_KEY}`;
        
        let chatHistory = [{
            role: "user", 
            parts: [{ text: "You are Agri-Gemini, an expert agricultural advisor. Your response must be concise, accurate, and actionable for farmers. Always use Google Search for grounding and up-to-date information." }]
        }];
        
        function appendMessage(role, text, sources = []) {
            const chatHistoryEl = document.getElementById("chatHistory");
            const messageDiv = document.createElement("div");
            messageDiv.className = `chat-message ${role}`;

            let content = text;
            if (sources.length > 0) {
                const sourceLinks = sources.map((s, i) => 
                    `<a href="${s.uri}" target="_blank" rel="noopener noreferrer" title="${s.title || 'Source'}"> [${i+1}]</a>`
                ).join('');
                content += `<p style="font-size: 0.75em; margin-top: 5px; opacity: 0.7;">Sources: ${sourceLinks}</p>`;
            }

            messageDiv.innerHTML = `<div class="message-bubble">${content}</div>`;
            chatHistoryEl.appendChild(messageDiv);
            chatHistoryEl.scrollTop = chatHistoryEl.scrollHeight;
        }

        async function appendTypingAnimation() {
            const chatHistoryEl = document.getElementById("chatHistory");
            const typingDiv = document.createElement("div");
            typingDiv.className = "chat-message ai typing-indicator";
            typingDiv.innerHTML = `<div class="message-bubble"><span class="typing-dots"></span></div>`;
            chatHistoryEl.appendChild(typingDiv);
            chatHistoryEl.scrollTop = chatHistoryEl.scrollHeight;
            return typingDiv;
        }

        async function askAgriGemini(userPrompt) {
            const typingDiv = await appendTypingAnimation();
            const prompt = `User's farming query: ${userPrompt}. Respond clearly, concisely, and provide actionable advice.`;

            const payload = {
                contents: [{ role: "user", parts: [{ text: prompt }] }],
                tools: [{ "google_search": {} }],
                systemInstruction: {
                    parts: [{ text: "You are Agri-Gemini, an expert agricultural advisor. Your response must be concise, accurate, and actionable for farmers. Use simple language and always cite sources when providing factual or recommendation-based answers, as if you are a friendly expert." }]
                },
                config: {
                    temperature: 0.2
                }
            };

            try {
                const response = await fetchWithBackoff(CHAT_API_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const result = await response.json();
                
                let text = "Sorry, I couldn't fetch advice. Please try again. If this continues, the API service might be unavailable.";
                let sources = [];

                const candidate = result.candidates?.[0];

                if (candidate && candidate.content?.parts?.[0]?.text) {
                    text = candidate.content.parts[0].text;
                    const groundingMetadata = candidate.groundingMetadata;
                    if (groundingMetadata && groundingMetadata.groundingAttributions) {
                        sources = groundingMetadata.groundingAttributions
                            .map(attribution => ({
                                uri: attribution.web?.uri,
                                title: attribution.web?.title,
                            }))
                            .filter(source => source.uri && source.title);
                    }
                }

                typingDiv.remove();
                appendMessage("ai", text, sources);

            } catch (error) {
                console.error("Gemini Chat Error:", error);
                typingDiv.remove();
                appendMessage("ai", "An error occurred while connecting to the advisor. Please check your network or try again shortly.", []);
            }
        }
        

        // JAVASCRIPT LOGIC should be d
        document.addEventListener("DOMContentLoaded", function () {
            
            
            function varCSS(name) {
                return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
            }
            const toast = document.getElementById('toast-message');

            function showToast(message, isSuccess = true) {
                toast.textContent = message;
                toast.style.backgroundColor = isSuccess ? varCSS('--color-primary') : '#d32f2f';
                toast.classList.add('show');
                
                setTimeout(() => {
                    toast.classList.remove('show');
                }, 3500);
            }

            /* ===================================================== */
            /* AUTH / LOGIN SYSTEM — Farmer vs Buyer                 */
            /* ===================================================== */
            const AUTH_STORAGE_KEY = 'agriUserProfile';

            const authOverlay = document.getElementById('authOverlay');
            const appShell = document.getElementById('appShell');
            const roleSelectionStep = document.getElementById('roleSelection');
            const farmerFormStep = document.getElementById('farmerForm');
            const buyerFormStep = document.getElementById('buyerForm');
            const authSubtitleEl = document.getElementById('authSubtitle');

            const chooseFarmerBtn = document.getElementById('chooseFarmer');
            const chooseBuyerBtn = document.getElementById('chooseBuyer');

            const farmerNameInput = document.getElementById('farmerName');
            const farmerPlaceInput = document.getElementById('farmerPlace');
            const farmerPicInput = document.getElementById('farmerPicInput');
            const farmerPicPreview = document.getElementById('farmerPicPreview');
            const farmerPicPlaceholderIcon = document.getElementById('farmerPicPlaceholderIcon');
            const farmerLoginBtn = document.getElementById('farmerLoginBtn');

            const buyerNameInput = document.getElementById('buyerName');
            const buyerAddressInput = document.getElementById('buyerAddress');
            const buyerLoginBtn = document.getElementById('buyerLoginBtn');

            const userChipAvatarImg = document.getElementById('userChipAvatarImg');
            const userChipAvatarIcon = document.getElementById('userChipAvatarIcon');
            const userChipInfo = document.getElementById('userChipInfo');
            const logoutBtn = document.getElementById('logoutBtn');
            const welcomeBannerEl = document.getElementById('welcome-banner');

            let farmerPicDataUrl = '';

            function showAuthStep(stepEl) {
                [roleSelectionStep, farmerFormStep, buyerFormStep].forEach(s => s.classList.remove('active'));
                stepEl.classList.add('active');
            }

            chooseFarmerBtn.addEventListener('click', () => {
                authSubtitleEl.textContent = "Tell us a little about your farm";
                showAuthStep(farmerFormStep);
            });

            chooseBuyerBtn.addEventListener('click', () => {
                authSubtitleEl.textContent = "Tell us where to deliver your order";
                showAuthStep(buyerFormStep);
            });

            document.querySelectorAll('[data-auth-back]').forEach(btn => {
                btn.addEventListener('click', () => {
                    authSubtitleEl.textContent = "Tell us who you are to get started";
                    showAuthStep(roleSelectionStep);
                });
            });

            farmerPicInput.addEventListener('change', () => {
                const file = farmerPicInput.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = (e) => {
                    farmerPicDataUrl = e.target.result;
                    farmerPicPreview.src = farmerPicDataUrl;
                    farmerPicPreview.style.display = 'block';
                    farmerPicPlaceholderIcon.style.display = 'none';
                };
                reader.readAsDataURL(file);
            });

            function applyRoleVisibility(role) {
                document.body.classList.remove('role-farmer', 'role-buyer');
                document.body.classList.add(role === 'farmer' ? 'role-farmer' : 'role-buyer');
            }

            function updateWelcomeAndChip(user) {
                if (user.role === 'farmer') {
                    welcomeBannerEl.innerHTML = `Welcome, ${user.name} <i class="fa-solid fa-seedling"></i>`;
                    userChipInfo.textContent = `${user.name} · Farmer${user.place ? ', ' + user.place : ''}`;
                } else {
                    welcomeBannerEl.innerHTML = `Welcome, ${user.name} <i class="fa-solid fa-basket-shopping"></i>`;
                    userChipInfo.textContent = `${user.name} · Buyer`;
                }

                if (user.role === 'farmer' && user.profilePic) {
                    userChipAvatarImg.src = user.profilePic;
                    userChipAvatarImg.style.display = 'block';
                    userChipAvatarIcon.style.display = 'none';
                } else {
                    userChipAvatarImg.style.display = 'none';
                    userChipAvatarIcon.style.display = 'block';
                }
            }

            function completeLogin(user) {
                localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(user));
                authOverlay.classList.add('hidden');
                appShell.style.display = 'block';
                document.body.style.overflow = '';
                applyRoleVisibility(user.role);
                updateWelcomeAndChip(user);
                showToast(`Welcome ${user.name}! You're logged in as a ${user.role}.`, true);
            }

            farmerLoginBtn.addEventListener('click', () => {
                const name = farmerNameInput.value.trim();
                const place = farmerPlaceInput.value.trim();
                if (!name || !place) {
                    showToast('Please enter your name and place to continue.', false);
                    return;
                }
                completeLogin({ role: 'farmer', name, place, profilePic: farmerPicDataUrl });
            });

            buyerLoginBtn.addEventListener('click', () => {
                const name = buyerNameInput.value.trim();
                const address = buyerAddressInput.value.trim();
                if (!name || !address) {
                    showToast('Please enter your name and address to continue.', false);
                    return;
                }
                completeLogin({ role: 'buyer', name, address });
            });

            function resetAuthForm() {
                showAuthStep(roleSelectionStep);
                authSubtitleEl.textContent = "Tell us who you are to get started";
                farmerNameInput.value = '';
                farmerPlaceInput.value = '';
                buyerNameInput.value = '';
                buyerAddressInput.value = '';
                farmerPicDataUrl = '';
                farmerPicInput.value = '';
                farmerPicPreview.style.display = 'none';
                farmerPicPlaceholderIcon.style.display = 'block';
            }

            logoutBtn.addEventListener('click', () => {
                localStorage.removeItem(AUTH_STORAGE_KEY);
                appShell.style.display = 'none';
                authOverlay.classList.remove('hidden');
                document.body.style.overflow = 'hidden';
                document.body.classList.remove('role-farmer', 'role-buyer');
                resetAuthForm();
            });

            function initAuth() {
                const saved = localStorage.getItem(AUTH_STORAGE_KEY);
                if (saved) {
                    try {
                        const user = JSON.parse(saved);
                        if (user && user.role && user.name) {
                            authOverlay.classList.add('hidden');
                            appShell.style.display = 'block';
                            applyRoleVisibility(user.role);
                            updateWelcomeAndChip(user);
                            return;
                        }
                    } catch (e) {
                        console.error('Could not parse saved profile', e);
                    }
                }
                // Not logged in yet — keep the auth overlay up and lock background scroll
                document.body.style.overflow = 'hidden';
            }

            initAuth();
            /* ================= END AUTH / LOGIN SYSTEM ================= */

            let cart = []; 

            function displayCart() {
                const cartContainer = document.getElementById("cartItems");
                cartContainer.innerHTML = "";
                if (cart.length === 0) {
                    cartContainer.innerHTML = `<p data-key="cart-empty">${translations[currentLang]['cart-empty']}</p>`;
                    return;
                }

                let total = 0;
                let html = '';
                cart.forEach((item, index) => {
                    const subtotal = item.qty * item.price;
                    total += subtotal;
                    html += `
                        <div style="padding:10px;margin:5px 0;display:flex;justify-content:space-between;align-items:center;">
                            <span>
                                <strong>${item.name}</strong> — ${item.qty} units × ₹${item.price.toFixed(2)} = ₹${subtotal.toFixed(2)}
                            </span>
                            <button onclick="removeItem(${index})" style="background:#d32f2f !important; color:white; border:none; border-radius:4px; padding:5px 10px;"><i class="fas fa-trash-alt"></i></button>
                        </div>
                    `;
                });
                cartContainer.innerHTML = html;
                cartContainer.innerHTML += `
                    <h3 style="margin-top:20px; border-top: 1px solid var(--color-card-border); padding-top: 10px;">Total: ₹${total.toFixed(2)}</h3>
                    <button onclick="makePayment(${total.toFixed(2)})" style="background:var(--color-primary);color:white;padding:10px 15px;border:none;border-radius:6px;cursor:pointer;font-weight:600;">Proceed to Pay</button>
                `;
            }

            function addToCart(name, qty, price) {
                if (!name || isNaN(qty) || qty <= 0 || isNaN(price) || price <= 0) {
                    showToast(translations[currentLang]['toast-error-fields'], false);
                    return;
                }
                cart.push({ name, qty: parseInt(qty), price: parseFloat(price) });
                showToast(translations[currentLang]['alert-cart-add'](name), true);
                displayCart();
            }
            window.removeItem = function (index) {
                cart.splice(index, 1);
                displayCart();
            }

            window.makePayment = function (amount) {
                if (amount <= 0 || cart.length === 0) {
                    showToast(translations[currentLang]['alert-empty-cart'], false);
                    return;
                }

                // Simulate payment processing
                showToast(translations[currentLang]['alert-pay-processing'](amount), true);
                
                setTimeout(() => {
                    showToast(translations[currentLang]['alert-pay-success'](amount), true);
                    cart = [];
                    displayCart();
                }, 1500); 
            }


            const themeToggle = document.getElementById('themeToggle');
            const body = document.body;
            const savedTheme = localStorage.getItem('theme');
            
            if (savedTheme === 'dark') {
                body.classList.add('dark-mode');
                themeToggle.innerHTML = '<i class="fas fa-sun"></i>';
            } else {
                themeToggle.innerHTML = '<i class="fas fa-moon"></i>';
            }

            themeToggle.addEventListener('click', () => {
                body.classList.toggle('dark-mode');
                if (body.classList.contains('dark-mode')) {
                    localStorage.setItem('theme', 'dark');
                    themeToggle.innerHTML = '<i class="fas fa-sun"></i>';
                } else {
                    localStorage.setItem('theme', 'light');
                    themeToggle.innerHTML = '<i class="fas fa-moon"></i>';
                }
            });

            const personalCountKey = "personalVisitCount";
            const personalCountEl = document.getElementById("visitorCount");
            const personalTextEl = document.getElementById("personalVisitorText");
            const globalTextEl = document.getElementById("globalVisitorText");

            function updatePersonalVisitCounter() {
                let currentCount = parseInt(localStorage.getItem(personalCountKey) || 0);
                const newCount = currentCount + 1;
                localStorage.setItem(personalCountKey, newCount);

                let display = currentCount;
                const step = 1; 
                
                const counterAnim = setInterval(() => {
                    if (display < newCount) {
                        display += step;
                        if (display > newCount) display = newCount;
                        personalCountEl.textContent = display.toLocaleString();
                    } else {
                        clearInterval(counterAnim);
                        // Apply and remove glow effect
                        personalCountEl.classList.add('highlight');
                        setTimeout(() => {
                            personalCountEl.classList.remove('highlight');
                        }, 1500);
                    }
                }, 50);
                
                personalTextEl.textContent = `👥 You have visited this site `;
                globalTextEl.textContent = `(Global count: ${localStorage.getItem("visitorCount") || 1})`; 

            }
            updatePersonalVisitCounter();


            
            const container = document.querySelector('.container');
            const sections = document.querySelectorAll('section');
            const navLinks = document.querySelectorAll('.nav-link');
            let activeSectionID = 'marketplace';

            
            sections.forEach((sec, i) => {
                 if (sec.id !== activeSectionID) {
                    sec.classList.remove('active-panel');
                    sec.style.transform = 'translateX(100%)';
                    sec.style.opacity = '0';
                 }
            });

            navLinks.forEach((link) => {
                link.addEventListener('click', (e) => {
                    e.preventDefault();
                    if (window.audioPlayer && !window.audioPlayer.paused) {
                        window.audioPlayer.pause();
                        window.audioPlayer.currentTime = 0;
                        document.querySelectorAll('.tts-button').forEach(btn => {
                            btn.innerHTML = '<i class="fas fa-volume-up"></i>';
                            btn.style.boxShadow = 'none';
                        });
                    }
                    
                    const targetID = link.getAttribute('data-target');
                    if (targetID === activeSectionID) return;

                    const current = document.getElementById(activeSectionID);
                    const next = document.getElementById(targetID);
                    
                    const currentIndex = Array.from(sections).findIndex(s => s.id === activeSectionID);
                    const nextIndex = Array.from(sections).findIndex(s => s.id === targetID);

                    // 1. Hide Current
                    if (nextIndex > currentIndex) {
                        current.style.transform = 'translateX(-100%)'; // Slide left out
                    } else {
                        current.style.transform = 'translateX(100%)'; // Slide right out
                    }
                    current.classList.remove('active-panel');

                
                    if (nextIndex > currentIndex) {
                        next.style.transform = 'translateX(100%)';
                    } else {
                        next.style.transform = 'translateX(-100%)';
                    }
                    next.style.opacity = '1';
                    
                    
                    setTimeout(() => {
                        next.style.transform = 'translateX(0)';
                        next.classList.add('active-panel');
                    }, 50); 
                    
                    activeSectionID = targetID;

                    // Updateting Navbar 
                    navLinks.forEach(l => l.classList.remove('active'));
                    link.classList.add('active');
                });
            });


            // Text-to-Speech            
            const audioEl = document.getElementById('ttsAudio');
            window.audioPlayer = audioEl; 

            function stopPlayback() {
                if (!audioEl.paused) {
                    audioEl.pause();
                    audioEl.currentTime = 0;
                }
                document.querySelectorAll('.tts-button').forEach(btn => {
                    btn.innerHTML = '<i class="fas fa-volume-up"></i>';
                    btn.style.boxShadow = 'none';
                    btn.classList.remove('speaking');
                });
            }

            const ttsButtons = document.querySelectorAll('.tts-button');
            ttsButtons.forEach(button => {
                button.addEventListener('click', async () => {
                    const contentId = button.getAttribute('data-content-id');
                    const sectionElement = document.getElementById(contentId);
                    
                    if (button.classList.contains('speaking')) {
                        
                        stopPlayback();
                        return;
                    } else if (!audioEl.paused) {
                        
                        stopPlayback();
                    }

                    
                    let content = '';
                    sectionElement.querySelectorAll('[data-key], p, h2, h3, h4, li').forEach(el => {
                        // Exclude buttons and chat content
                        if (!el.classList.contains('tts-button') && !el.classList.contains('tooltip-text') && !el.closest('#agriChatContainer')) {
                            content += el.textContent.trim() + '. ';
                        }
                    });

                    if (!content) return;

                    button.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
                    button.style.boxShadow = `0 0 10px var(--color-accent)`;
                    button.classList.add('speaking');

                    try {
                        // --- Language selection for TTS ---
                        const langCode = body.getAttribute('lang') === 'hi' ? 'hi-IN' : 'en-US';
                        // Using different voices for immersion/variety
                        const voiceName = langCode === 'hi-IN' ? 'Kore' : 'Zephyr'; 
                        // --- End Language selection for TTS ---
                        
                        const TTS_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${API_KEY}`;
                        const payload = {
                            contents: [{
                                parts: [{ text: content }]
                            }],
                            generationConfig: {
                                responseModalities: ["AUDIO"],
                                speechConfig: {
                                    voiceConfig: {
                                        prebuiltVoiceConfig: { voiceName: voiceName }
                                    }
                                }
                            }
                        };

                        const response = await fetchWithBackoff(TTS_API_URL, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(payload)
                        });

                        const result = await response.json();
                        const part = result?.candidates?.[0]?.content?.parts?.[0];
                        const audioData = part?.inlineData?.data;
                        const mimeType = part?.inlineData?.mimeType;

                        if (audioData && mimeType && mimeType.startsWith("audio/")) {
                            const sampleRateMatch = mimeType.match(/rate=(\d+)/);
                            const sampleRate = sampleRateMatch ? parseInt(sampleRateMatch[1], 10) : 16000;
                            const pcmData = base64ToArrayBuffer(audioData);
                            const pcm16 = new Int16Array(pcmData);
                            const wavBlob = pcmToWav(pcm16, sampleRate);
                            
                            if (audioEl.src) URL.revokeObjectURL(audioEl.src);
                            
                            const audioUrl = URL.createObjectURL(wavBlob);
                            audioEl.src = audioUrl;
                            audioEl.play();

                            button.innerHTML = '<i class="fas fa-volume-off"></i>';
                            
                            audioEl.onended = () => {
                                stopPlayback();
                            };
                        } else {
                            showToast("TTS failed: Could not generate audio.", false);
                            stopPlayback();
                        }

                    } catch (error) {
                        console.error("TTS API Error:", error);
                        showToast("TTS service unavailable. Please try later.", false);
                        stopPlayback();
                    }
                });
            });
            const langToggle = document.getElementById('langToggle');
            const translations = {
                'en': {
                    'header-title': 'AGRI DUNIYA',
                    'header-tagline': 'Empowering Farmers with Digital Access to Markets, Knowledge & Government Schemes',
                    'nav-market': 'Marketplace',
                    'nav-learning': 'Learning Hub',
                    'nav-videos': 'Videos',
                    'nav-schemes': 'Schemes',
                    'nav-contact': 'Contact',
                    'sec-market-title': 'Digital Marketplace',
                    'sec-market-p': 'Buy and Sell farm products directly. Farmers can list their crops, and buyers can purchase them directly ensuring fair trade.',
                    'sell-title': 'Sell Your Products',
                    'generate-title': 'Generate Product Listing ✨',
                    'generate-button': 'Generate Description ✨',
                    'listing-placeholder': 'Your professional product description will appear here.',
                    'sell-button': 'Post for Sale',
                    'cart-title': 'Your Cart',
                    'cart-empty': 'Your cart is empty.',
                    'sec-learning-title': 'Learning Hub',
                    'sec-learning-p': 'Learn modern farming techniques, productivity improvement, and crop management through our platform.',
                    'course-1-title': 'Modern Irrigation Techniques',
                    'course-1-desc': 'Optimize water usage with drip and sprinkler systems. Learn smart water management.',
                    'course-2-title': 'Organic Farming',
                    'course-2-desc': 'Master the techniques of natural, chemical-free cultivation and soil enrichment.',
                    'course-3-title': 'Crop Insurance Awareness',
                    'course-3-desc': 'Understand policy details and claims process for securing your harvest against risks.',
                    'course-4-title': 'Cloud Integration & e-Learning',
                    'course-4-desc': 'Utilize cloud tools for data management and access to digital agricultural resources.',
                    'ai-chat-title': '✨ Agri-Gemini: Instant Crop Advisor',
                    'ai-desc': 'Ask me anything about farming techniques, market trends, or pest management!',
                    'sec-video-title': 'Videos for Farmers',
                    'sec-video-p': 'Watch these helpful videos on crop cultivation, soil health, and modern farming practices.',
                    'sec-scheme-title': 'Government Schemes for Farmers',
                    'sec-scheme-p': 'Here are some important government schemes designed to support farmers. Click on the links to learn more and apply:',
                    'scheme-1-desc': 'Pradhan Mantri Kisan Samman Nidhi (PM-KISAN) – Direct income support of ₹6,000 annually to farmers.',
                    'scheme-2-desc': 'Pradhan Mantri Fasal Bima Yojana (PMFBY) – Crop insurance for farmers against natural calamities.',
                    'scheme-3-desc': 'Soil Health Card Scheme – Provides farmers with soil health reports and recommendations.',
                    'scheme-4-desc': 'Agriculture Infrastructure Fund (AIF) – Financial support for developing agricultural infrastructure.',
                    'scheme-5-desc': 'National Agriculture Market (eNAM) – Online trading platform for farmers to sell their produce.',
                    'sec-contact-title': 'Contact Us',
                    'contact-info-1': 'Email: support@farmerplatform.in',
                    'contact-info-2': 'Helpline: +91 7393953233',
                    'form-label-name': 'Name',
                    'form-label-email': 'Email',
                    'form-label-message': 'Message',
                    'form-button-send': 'Send Message',
                    'footer-copyright': '© 2025 Digital Marketplace & Learning Platform for Farmers | All Rights Reserved',
                    'footer-visits': 'Total Visits: ',
                    'toast-success': 'Message sent successfully! We will contact you soon.',
                    'toast-error-fields': 'Please fill all marketplace fields correctly.',
                    'toast-error-search': 'Please enter a product name to search.',
                    'toast-error-listing': 'Please enter a product name and some key points for the listing generator.',
                    'alert-cart-add': (name) => `${name} added to cart!`,
                    'alert-pay-success': (amount) => `Payment of ₹${amount} successful! Thank you for your purchase.`,
                    'alert-pay-processing': (amount) => `Processing payment of ₹${amount}...`,
                    'alert-search': (name) => `Searching for "${name}" in marketplace...`,
                    'alert-empty-cart': 'Your cart is empty. Nothing to pay for.'
                },
                'hi': {
                    'header-title': 'एग्री दुनिया',
                    'header-tagline': 'किसानों को बाज़ार, ज्ञान और सरकारी योजनाओं तक डिजिटल पहुँच के साथ सशक्त बनाना',
                    'nav-market': 'बाज़ार',
                    'nav-learning': 'सीखने का केंद्र',
                    'nav-videos': 'वीडियो',
                    'nav-schemes': 'योजनाएँ',
                    'nav-contact': 'संपर्क',
                    'sec-market-title': 'डिजिटल बाज़ार',
                    'sec-market-p': 'कृषि उत्पादों को सीधे खरीदें और बेचें। किसान अपनी फसलें सूचीबद्ध कर सकते हैं, और खरीदार सीधे खरीद सकते हैं, जिससे उचित व्यापार सुनिश्चित होगा।',
                    'sell-title': 'अपने उत्पाद बेचें',
                    'generate-title': 'उत्पाद लिस्टिंग बनाएं ✨',
                    'generate-button': 'विवरण बनाएं ✨',
                    'listing-placeholder': 'आपका पेशेवर उत्पाद विवरण यहां दिखाई देगा।',
                    'sell-button': 'बिक्री के लिए पोस्ट करें',
                    'cart-title': 'आपका कार्ट',
                    'cart-empty': 'आपका कार्ट खाली है।',
                    'sec-learning-title': 'सीखने का केंद्र',
                    'sec-learning-p': 'हमारे मंच के माध्यम से आधुनिक खेती की तकनीकें, उत्पादकता में सुधार और फसल प्रबंधन सीखें।',
                    'course-1-title': 'आधुनिक सिंचाई तकनीकें',
                    'course-1-desc': 'ड्रिप और स्प्रिंकलर सिस्टम के साथ पानी के उपयोग को अनुकूलित करें। स्मार्ट जल प्रबंधन सीखें।',
                    'course-2-title': 'जैविक खेती',
                    'course-2-desc': 'प्राकृतिक, रसायन मुक्त खेती और मिट्टी संवर्धन की तकनीकों में महारत हासिल करें।',
                    'course-3-title': 'फसल बीमा जागरूकता',
                    'course-3-desc': 'जोखिमों के विरुद्ध अपनी फसल को सुरक्षित करने के लिए नीति विवरण और दावा प्रक्रिया को समझें।',
                    'course-4-title': 'क्लाउड एकीकरण और ई-लर्निंग',
                    'course-4-desc': 'डेटा प्रबंधन और डिजिटल कृषि संसाधनों तक पहुँच के लिए क्लाउड उपकरणों का उपयोग करें।',
                    'ai-chat-title': '✨ एग्री-जेमिनी: तत्काल फसल सलाहकार',
                    'ai-desc': 'खेती की तकनीकों, बाज़ार के रुझानों या कीट प्रबंधन के बारे में कुछ भी पूछें!',
                    'sec-video-title': 'किसानों के लिए वीडियो',
                    'sec-video-p': 'फसल की खेती, मिट्टी के स्वास्थ्य और आधुनिक कृषि पद्धतियों पर ये सहायक वीडियो देखें।',
                    'sec-scheme-title': 'किसानों के लिए सरकारी योजनाएँ',
                    'sec-scheme-p': 'यहां किसानों का समर्थन करने के लिए डिज़ाइन की गई कुछ महत्वपूर्ण सरकारी योजनाएँ दी गई हैं। अधिक जानने और आवेदन करने के लिए लिंक पर क्लिक करें:',
                    'scheme-1-desc': 'प्रधान मंत्री किसान सम्मान निधि (पीएम-किसान) – किसानों को सालाना ₹6,000 का सीधा आय समर्थन।',
                    'scheme-2-desc': 'प्रधान मंत्री फसल बीमा योजना (पीएमएफबीवाई) – प्राकृतिक आपदाओं के खिलाफ किसानों के लिए फसल बीमा।',
                    'scheme-3-desc': 'मृदा स्वास्थ्य कार्ड योजना – किसानों को मिट्टी के स्वास्थ्य की रिपोर्ट और सिफारिशें प्रदान करती है।',
                    'scheme-4-desc': 'कृषि अवसंरचना कोष (एआईएफ) – कृषि अवसंरचना के विकास के लिए वित्तीय सहायता।',
                    'scheme-5-desc': 'राष्ट्रीय कृषि बाजार (ई-नाम) – किसानों को अपनी उपज बेचने के लिए ऑनलाइन ट्रेडिंग प्लेटफॉर्म।',
                    'sec-contact-title': 'हमसे संपर्क करें',
                    'contact-info-1': 'ईमेल: support@farmerplatform.in',
                    'contact-info-2': 'हेल्पलाइन: +91 7393953233',
                    'form-label-name': 'नाम',
                    'form-label-email': 'ईमेल',
                    'form-label-message': 'संदेश',
                    'form-button-send': 'संदेश भेजें',
                    'footer-copyright': '© 2025 डिजिटल बाज़ार और सीखने का मंच | सर्वाधिकार सुरक्षित',
                    'footer-visits': 'कुल विज़िट: ',
                    'toast-success': 'संदेश सफलतापूर्वक भेज दिया गया! हम जल्द ही आपसे संपर्क करेंगे।',
                    'toast-error-fields': 'कृपया बाज़ार के सभी फ़ील्ड सही ढंग से भरें।',
                    'toast-error-search': 'कृपया खोज के लिए उत्पाद का नाम दर्ज करें।',
                    'toast-error-listing': 'कृपया लिस्टिंग जनरेटर के लिए उत्पाद का नाम और कुछ मुख्य बिंदु दर्ज करें।',
                    'alert-cart-add': (name) => `${name} कार्ट में जोड़ा गया!`,
                    'alert-pay-success': (amount) => `₹${amount} का भुगतान सफल रहा! आपकी खरीद के लिए धन्यवाद।`,
                    'alert-pay-processing': (amount) => `₹${amount} का भुगतान संसाधित हो रहा है...`,
                    'alert-empty-cart': 'आपका कार्ट खाली है। भुगतान करने के लिए कुछ भी नहीं है।'
                }
            };
            
            let currentLang = 'en';

            function applyTranslation(lang) {
                currentLang = lang;
                body.setAttribute('lang', lang);
                langToggle.textContent = lang.toUpperCase() === 'EN' ? 'EN/HI' : 'HI/EN';

                document.querySelectorAll('[data-key]').forEach(element => {
                    const key = element.getAttribute('data-key');
                    const text = translations[lang][key];
                    if (text && typeof text === 'string') {
                        element.textContent = text;
                    }
                });

                
                        displayCart(); 

                const initialChatText = lang === 'en' ? "Hello! I'm Agri-Gemini, your AI crop expert. Ask me anything about farming techniques, pests, or market advice." : "नमस्ते! मैं एग्री-जेमिनी, आपका एआई फसल विशेषज्ञ हूँ। मुझसे खेती की तकनीकों, कीटों या बाज़ार सलाह के बारे में कुछ भी पूछें।";
                const initialChatBubble = document.querySelector('#chatHistory .chat-message.ai .message-bubble');
                if (initialChatBubble) {
                    initialChatBubble.textContent = initialChatText;
                }

                stopPlayback();
            }

            const savedLang = localStorage.getItem('language') || 'en';
            applyTranslation(savedLang);

            langToggle.addEventListener('click', () => {
                const newLang = currentLang === 'en' ? 'hi' : 'en';
                localStorage.setItem('language', newLang);
                applyTranslation(newLang);
            });

            const contactForm = document.getElementById('contactForm');

            
            contactForm.addEventListener('submit', function (e) {
                e.preventDefault();
                
                console.log('Form Data Submitted:', {
                    name: document.getElementById('contactName').value,
                    email: document.getElementById('contactEmail').value,
                    message: document.getElementById('contactMessage').value
                });

                showToast(translations[currentLang]['toast-success'], true);

                contactForm.reset();
            });
            const sellButton = document.getElementById('postForSaleBtn');
            const generateListingBtn = document.getElementById('generateListingBtn');

            sellButton.addEventListener('click', function () {
                const name = document.getElementById('sellName').value.trim();
                const qty = document.getElementById('sellQty').value;
                const price = document.getElementById('sellPrice').value;
                addToCart(name, qty, price);
                document.getElementById('sellName').value = "";
                document.getElementById('sellQty').value = "";
                document.getElementById('sellPrice').value = "";
            });

            async function generateProductDescription(productName, keyPoints) {
                const outputEl = document.getElementById('listingOutput');
                outputEl.innerHTML = `<p style="color: var(--color-primary);"><i class="fas fa-spinner fa-spin"></i> Generating...</p>`;
                
                const userPrompt = `Generate a compelling and professional online marketplace description for the following product. Keep it concise (max 3 sentences) but highly attractive to buyers.
                Product Name: ${productName}
                Key Selling Points: ${keyPoints}`;

                const payload = {
                    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
                    // No Google Search grounding needed for creative generation
                    systemInstruction: {
                        parts: [{ text: "You are an expert agricultural copywriter for an online farmer's marketplace. You write attractive, trustworthy, and concise product listings in an informative but engaging tone." }]
                    },
                    config: {
                        temperature: 0.7 // Higher temperature for more creative output
                    }
                };

                try {
                    const response = await fetchWithBackoff(CHAT_API_URL, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload)
                    });
                    const result = await response.json();
                    
                    const text = result.candidates?.[0]?.content?.parts?.[0]?.text || "❌ Failed to generate description. Check your network or try again.";
                    
                    outputEl.innerHTML = `<div class="message-bubble ai" style="display: block; border-radius: 6px; background: var(--color-background); color: var(--color-text); border: 1px dashed var(--color-accent);">${text}</div>`;
                    showToast("Description generated successfully!", true);

                } catch (error) {
                    console.error("Gemini Listing Generation Error:", error);
                    outputEl.innerHTML = `<p style="color: #d32f2f;"><i class="fas fa-exclamation-triangle"></i> Generation failed. Service error.</p>`;
                    showToast("Error generating listing. Check console for details.", false);
                }
            }

            generateListingBtn.addEventListener('click', function () {
                const productName = document.getElementById('listingProductName').value.trim();
                const keyPoints = document.getElementById('listingKeyPoints').value.trim();
                
                if (!productName || !keyPoints) {
                    showToast(translations[currentLang]['toast-error-listing'], false);
                    return;
                }
                generateProductDescription(productName, keyPoints);
            });
        
            const chatInput = document.getElementById("chatInput");
            const sendChatBtn = document.getElementById("sendChatBtn");

            const handleChat = () => {
                const prompt = chatInput.value.trim();
                if (prompt) {
                    appendMessage("user", prompt);
                    chatInput.value = "";
                    askAgriGemini(prompt);
                }
            };

            sendChatBtn.addEventListener('click', handleChat);
            chatInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    handleChat();
                }
            });

            const drawerOverlay = document.getElementById('drawerOverlay');
            const drawer = document.getElementById('buySellDrawer');
            const drawerTitle = document.getElementById('drawerTitle');
            const drawerInstruction = document.getElementById('drawerInstruction');
            const drawerPriceInput = document.getElementById('drawerPrice');
            const drawerActionBtn = document.getElementById('drawerActionBtn');

            function openDrawer(type) {
                const isBuy = type === 'buy';
                drawerTitle.textContent = isBuy ? 'Quick Buy Product' : 'Quick Sell Product';
                drawerInstruction.textContent = isBuy 
                    ? 'Enter the product you want to buy and add it to your cart (mock transaction).'
                    : 'Enter the product you want to sell and set a price (mock listing).';
                
                drawerPriceInput.style.display = isBuy ? 'none' : 'block';
                drawerActionBtn.textContent = isBuy ? 'Add Mock Item to Cart' : 'Post & Add to Cart';
                drawerActionBtn.setAttribute('data-action', type);

                drawerOverlay.classList.add('visible');
                drawer.classList.add('visible');
                document.body.style.overflow = 'hidden'; // Prevent background scrolling
            }

            window.closeDrawer = function() {
                drawerOverlay.classList.remove('visible');
                drawer.classList.remove('visible');
                document.body.style.overflow = '';
                document.getElementById('drawerName').value = '';
                document.getElementById('drawerQty').value = '';
                drawerPriceInput.value = '';
            }
            
            
            document.getElementById('openQuickSell').addEventListener('click', () => openDrawer('sell'));
            document.getElementById('openQuickBuy').addEventListener('click', () => openDrawer('buy'));

            
            drawerActionBtn.addEventListener('click', function() {
                const name = document.getElementById('drawerName').value.trim();
                const qty = document.getElementById('drawerQty').value;
                const type = this.getAttribute('data-action');
                
                if (!name || isNaN(qty) || parseInt(qty) <= 0) {
                    showToast("Please enter a valid product name and quantity.", false);
                    return;
                }

                let price = 100; // Default price for mock buy
                if (type === 'sell') {
                    price = document.getElementById('drawerPrice').value;
                    if (isNaN(price) || parseFloat(price) <= 0) {
                        showToast("Please enter a valid price to sell.", false);
                        return;
                    }
                }
                
                
                addToCart(name, qty, price);
                closeDrawer();
            });
        });
