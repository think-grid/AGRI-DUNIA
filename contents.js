// gemini key stays server side (firebase cloud function), this file just hits these urls
const CHAT_PROXY_URL = "https://us-central1-agri-dunia.cloudfunctions.net/geminiChat";
const TTS_PROXY_URL = "https://us-central1-agri-dunia.cloudfunctions.net/geminiTts";

// google sign-in client id, get one from google cloud console if this needs changing
const GOOGLE_CLIENT_ID = "1007423755384-j0q27cdejbiqbv8cjtifmnr9e29jajkv.apps.googleusercontent.com";

        // Cloud Functions occasionally 429 under load; retry with jittered exponential
        // backoff instead of failing the chat/TTS request outright.
        // Also guards against a hung request: plain fetch() has no timeout of its own,
        // so a stalled/cold-starting Cloud Function would otherwise leave callers
        // (e.g. the TTS "speaking" spinner) waiting forever with no error and no retry.
        async function fetchWithBackoff(url, options, maxRetries = 3, timeoutMs = 20000) {
            for (let i = 0; i < maxRetries; i++) {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
                try {
                    const response = await fetch(url, { ...options, signal: controller.signal });
                    clearTimeout(timeoutId);
                    if (response.ok) {
                        return response;
                    }
                    if (i === maxRetries - 1) {
                        throw new Error(`API call failed with status: ${response.status}`);
                    }
                    const delay = Math.pow(2, i) * 1000 + Math.random() * 1000;
                    await new Promise(resolve => setTimeout(resolve, delay));
                } catch (error) {
                    clearTimeout(timeoutId);
                    const timedOut = error.name === 'AbortError';
                    if (i === maxRetries - 1) {
                        throw timedOut ? new Error('Request timed out') : error;
                    }
                    const delay = Math.pow(2, i) * 1000 + Math.random() * 1000;
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
            throw new Error("API call failed after maximum retries");
        }

        // Product names, review comments, chat messages etc. all end up in innerHTML
        // somewhere (Firestore data is just as untrusted as any other user input), so
        // anything that isn't a hardcoded string needs to go through this first.
        function escapeHtml(str) {
            if (str === null || str === undefined) return '';
            return String(str)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
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
        // Chat now goes through the Cloud Function proxy (see CHAT_PROXY_URL above)
        // instead of calling Google directly with a client-side key.
        const CHAT_API_URL = CHAT_PROXY_URL;
        
        let chatHistory = [{
            role: "user", 
            parts: [{ text: "You are Agri-Gemini, an expert agricultural advisor. Your response must be concise, accurate, and actionable for farmers. Always use Google Search for grounding and up-to-date information." }]
        }];
        
        function appendMessage(role, text, sources = []) {
            const chatHistoryEl = document.getElementById("chatHistory");
            const messageDiv = document.createElement("div");
            messageDiv.className = `chat-message ${role}`;

            let content = escapeHtml(text);
            if (sources.length > 0) {
                const sourceLinks = sources.map((s, i) =>
                    `<a href="${escapeHtml(s.uri)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(s.title || 'Source')}"> [${i+1}]</a>`
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

            // auth / login stuff (farmer vs buyer)
            const AUTH_STORAGE_KEY = 'agriUserProfile';
            // notifications moved from localStorage to firestore so they sync across devices now
            let currentLang = 'en';

            // language config
            const SUPPORTED_LANGS = ['en', 'hi', 'ta', 'te', 'bn'];
            const LANG_LABELS = { en: 'English', hi: 'हिन्दी', ta: 'தமிழ்', te: 'తెలుగు', bn: 'বাংলা' };
            const INITIAL_CHAT_TEXT = {
                en: "Hello! I'm Agri-Gemini, your AI crop expert. Ask me anything about farming techniques, pests, or market advice.",
                hi: "नमस्ते! मैं एग्री-जेमिनी, आपका एआई फसल विशेषज्ञ हूँ। मुझसे खेती की तकनीकों, कीटों या बाज़ार सलाह के बारे में कुछ भी पूछें।",
                ta: "வணக்கம்! நான் அக்ரி-ஜெமினி, உங்கள் AI பயிர் நிபுணர். விவசாய நுட்பங்கள், பூச்சிகள் அல்லது சந்தை ஆலோசனை பற்றி என்னிடம் எதுவும் கேளுங்கள்.",
                te: "నమస్కారం! నేను అగ్రి-జెమిని, మీ AI పంట నిపుణుడిని. వ్యవసాయ పద్ధతులు, చీడపీడలు లేదా మార్కెట్ సలహా గురించి నన్ను ఏదైనా అడగండి.",
                bn: "নমস্কার! আমি অ্যাগ্রি-জেমিনি, আপনার AI ফসল বিশেষজ্ঞ। কৃষি পদ্ধতি, পোকামাকড় বা বাজারের পরামর্শ নিয়ে আমাকে যেকোনো কিছু জিজ্ঞাসা করুন।"
            };
            const NOTIF_EMPTY_TEXT = {
                en: 'No notifications yet.',
                hi: 'अभी तक कोई सूचना नहीं।',
                ta: 'இதுவரை அறிவிப்புகள் இல்லை.',
                te: 'ఇంకా నోటిఫికేషన్‌లు లేవు.',
                bn: 'এখনও কোনো বিজ্ঞপ্তি নেই।'
            };
            const TIME_AGO_TEXT = {
                en: { justNow: 'just now', min: (m) => `${m} min ago`, hr: (h) => `${h} hr ago`, day: (d) => `${d} day(s) ago` },
                hi: { justNow: 'अभी', min: (m) => `${m} मिनट पहले`, hr: (h) => `${h} घंटे पहले`, day: (d) => `${d} दिन पहले` },
                ta: { justNow: 'இப்போது', min: (m) => `${m} நிமிடங்களுக்கு முன்`, hr: (h) => `${h} மணி நேரத்திற்கு முன்`, day: (d) => `${d} நாட்களுக்கு முன்` },
                te: { justNow: 'ఇప్పుడే', min: (m) => `${m} నిమిషాల క్రితం`, hr: (h) => `${h} గంటల క్రితం`, day: (d) => `${d} రోజుల క్రితం` },
                bn: { justNow: 'এইমাত্র', min: (m) => `${m} মিনিট আগে`, hr: (h) => `${h} ঘণ্টা আগে`, day: (d) => `${d} দিন আগে` }
            };
            const TTS_LANG_CONFIG = {
                en: { code: 'en-US', voice: 'Zephyr' },
                hi: { code: 'hi-IN', voice: 'Kore' },
                ta: { code: 'ta-IN', voice: 'Puck' },
                te: { code: 'te-IN', voice: 'Charon' },
                bn: { code: 'bn-IN', voice: 'Fenrir' }
            };

            const loginOverlay = document.getElementById('loginOverlay');
            const roleSelectStep = document.getElementById('roleSelectStep');
            const farmerLoginForm = document.getElementById('farmerLoginForm');
            const buyerLoginForm = document.getElementById('buyerLoginForm');

            const chooseFarmerBtn = document.getElementById('chooseFarmerBtn');
            const chooseBuyerBtn = document.getElementById('chooseBuyerBtn');
            const backFromFarmerBtn = document.getElementById('backFromFarmerBtn');
            const backFromBuyerBtn = document.getElementById('backFromBuyerBtn');

            const farmerNameInput = document.getElementById('farmerName');
            const farmerPlaceInput = document.getElementById('farmerPlace');
            const farmerPhotoInput = document.getElementById('farmerPhotoInput');
            const farmerPhotoPreview = document.getElementById('farmerPhotoPreview');

            const buyerNameInput = document.getElementById('buyerName');
            const buyerAddressInput = document.getElementById('buyerAddress');

            const profileAvatar = document.getElementById('profileAvatar');
            const profileNameEl = document.getElementById('profileName');
            const profileRoleEl = document.getElementById('profileRole');
            const logoutBtn = document.getElementById('logoutBtn');
            const welcomeBannerEl = document.getElementById('welcome-banner');
            const profileBar = document.getElementById('profileBar');
            const profileAvatarBtn = document.getElementById('profileAvatarBtn');
            const profileDropdown = document.getElementById('profileDropdown');

            if (profileAvatarBtn) {
                profileAvatarBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    profileDropdown.classList.toggle('open');
                });
                document.addEventListener('click', (e) => {
                    if (!profileBar.contains(e.target)) {
                        profileDropdown.classList.remove('open');
                    }
                });
            }

            let farmerPhotoDataUrl = '';
            let currentUser = null;
            let pendingGoogleRole = null;
            let farmerGoogleEmail = '';
            let buyerGoogleEmail = '';

            function showLoginStep(stepEl) {
                [roleSelectStep, farmerLoginForm, buyerLoginForm].forEach(s => {
                    s.style.display = 'none';
                });
                stepEl.style.display = (stepEl.tagName === 'FORM') ? 'flex' : 'block';
                if (stepEl.tagName === 'FORM') {
                    stepEl.style.flexDirection = 'column';
                }
            }

            chooseFarmerBtn.addEventListener('click', () => { pendingGoogleRole = 'farmer'; showLoginStep(farmerLoginForm); });
            chooseBuyerBtn.addEventListener('click', () => { pendingGoogleRole = 'buyer'; showLoginStep(buyerLoginForm); });
            backFromFarmerBtn.addEventListener('click', () => { pendingGoogleRole = null; showLoginStep(roleSelectStep); });
            backFromBuyerBtn.addEventListener('click', () => { pendingGoogleRole = null; showLoginStep(roleSelectStep); });

            farmerPhotoInput.addEventListener('change', () => {
                const file = farmerPhotoInput.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = (e) => {
                    farmerPhotoDataUrl = e.target.result;
                    farmerPhotoPreview.src = farmerPhotoDataUrl;
                    farmerPhotoPreview.style.display = 'block';
                };
                reader.readAsDataURL(file);
            });

            function applyRoleVisibility(role) {
                document.body.classList.remove('role-farmer', 'role-buyer');
                document.body.classList.add(role === 'farmer' ? 'role-farmer' : 'role-buyer');
                // nav pills visibility changed, re-measure wheel centering (delayed since setupNavWheel might not exist yet)
                setTimeout(() => {
                    if (typeof window.__resizeNavWheel === 'function') window.__resizeNavWheel();
                }, 0);
            }

            function initials(name) {
                return (name || '').trim().split(/\s+/).slice(0, 2).map(w => w[0] ? w[0].toUpperCase() : '').join('');
            }

            function updateWelcomeAndProfile(user) {
                if (user.role === 'farmer') {
                    welcomeBannerEl.innerHTML = `Welcome Farmer ${escapeHtml(user.name)} <i class="fa-solid fa-seedling"></i>`;
                    profileRoleEl.textContent = 'Farmer' + (user.place ? ' · ' + user.place : '');
                } else {
                    welcomeBannerEl.innerHTML = `Welcome ${escapeHtml(user.name)} <i class="fa-solid fa-basket-shopping"></i>`;
                    profileRoleEl.textContent = 'Buyer';
                }
                profileNameEl.textContent = user.name;

                if (user.role === 'farmer' && user.profilePic) {
                    profileAvatar.style.backgroundImage = `url(${user.profilePic})`;
                    profileAvatar.textContent = '';
                } else {
                    profileAvatar.style.backgroundImage = '';
                    profileAvatar.textContent = initials(user.name) || '?';
                }
            }

            function completeLogin(user) {
                currentUser = user;
                localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(user));
                document.body.classList.add('logged-in');
                document.body.style.overflow = '';
                applyRoleVisibility(user.role);
                updateWelcomeAndProfile(user);
                renderProductListings();
                renderNotifications();
                renderPurchases();
                renderFarmerMessages();
                showToast(`Welcome ${user.name}! You're logged in as a ${user.role}.`, true);
            }

            farmerLoginForm.addEventListener('submit', (e) => {
                e.preventDefault();
                const name = farmerNameInput.value.trim();
                const place = farmerPlaceInput.value.trim();
                if (!name || !place) {
                    showToast('Please enter your name and place to continue.', false);
                    return;
                }
                completeLogin({ role: 'farmer', name, place, profilePic: farmerPhotoDataUrl, email: farmerGoogleEmail });
            });

            buyerLoginForm.addEventListener('submit', (e) => {
                e.preventDefault();
                const name = buyerNameInput.value.trim();
                const address = buyerAddressInput.value.trim();
                if (!name || !address) {
                    showToast('Please enter your name and address to continue.', false);
                    return;
                }
                completeLogin({ role: 'buyer', name, address, email: buyerGoogleEmail });
            });

            function resetLoginForm() {
                showLoginStep(roleSelectStep);
                farmerLoginForm.reset();
                buyerLoginForm.reset();
                farmerPhotoDataUrl = '';
                farmerPhotoPreview.style.display = 'none';
                farmerPhotoPreview.src = '';
                farmerGoogleEmail = '';
                buyerGoogleEmail = '';
                pendingGoogleRole = null;
            }

            logoutBtn.addEventListener('click', () => {
                localStorage.removeItem(AUTH_STORAGE_KEY);
                currentUser = null;
                farmerGoogleEmail = '';
                buyerGoogleEmail = '';
                document.body.classList.remove('logged-in', 'role-farmer', 'role-buyer');
                document.body.style.overflow = 'hidden';
                resetLoginForm();
                showToast('You have been logged out.', true);
            });

            function initAuth() {
                const saved = localStorage.getItem(AUTH_STORAGE_KEY);
                if (saved) {
                    try {
                        const user = JSON.parse(saved);
                        if (user && user.role && user.name) {
                            currentUser = user;
                            document.body.classList.add('logged-in');
                            document.body.style.overflow = '';
                            applyRoleVisibility(user.role);
                            updateWelcomeAndProfile(user);
                            renderProductListings();
                            renderNotifications();
                            renderPurchases();
                            renderFarmerMessages();
                            return;
                        }
                    } catch (e) {
                        console.error('Could not parse saved profile', e);
                    }
                }
                // not logged in, keep overlay up and lock scroll
                document.body.style.overflow = 'hidden';
            }

            initAuth();

            // "continue with google" on login forms
            const googleBtnFarmer = document.getElementById('googleBtnFarmer');
            const googleBtnBuyer = document.getElementById('googleBtnBuyer');

            function decodeGoogleCredential(credential) {
                const base64Payload = credential.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
                const jsonPayload = decodeURIComponent(
                    atob(base64Payload).split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join('')
                );
                return JSON.parse(jsonPayload);
            }

            function handleGoogleCredentialResponse(response) {
                let profile;
                try {
                    profile = decodeGoogleCredential(response.credential);
                } catch (err) {
                    console.error('Google sign-in: could not read credential', err);
                    showToast('Could not read your Google profile. Please try again or enter your details manually.', false);
                    return;
                }

                const { name, email, picture } = profile;

                if (pendingGoogleRole === 'farmer') {
                    farmerNameInput.value = name || '';
                    farmerGoogleEmail = email || '';
                    if (picture) {
                        farmerPhotoDataUrl = picture;
                        farmerPhotoPreview.src = picture;
                        farmerPhotoPreview.style.display = 'block';
                    }
                    showToast(`Signed in as ${name} with Google. Add your village to finish.`, true);
                    farmerPlaceInput.focus();
                } else if (pendingGoogleRole === 'buyer') {
                    buyerNameInput.value = name || '';
                    buyerGoogleEmail = email || '';
                    showToast(`Signed in as ${name} with Google. Add your address to finish.`, true);
                    buyerAddressInput.focus();
                }
            }
            window.handleGoogleCredentialResponse = handleGoogleCredentialResponse;

            function initGoogleSignIn(attemptsLeft = 20) {
                if (!GOOGLE_CLIENT_ID || GOOGLE_CLIENT_ID.indexOf('YOUR_GOOGLE_CLIENT_ID') !== -1) {
                    // no client id set, leave slots empty (css hides the divider)
                    return;
                }
                if (typeof google === 'undefined' || !google.accounts || !google.accounts.id) {
                    if (attemptsLeft > 0) {
                        setTimeout(() => initGoogleSignIn(attemptsLeft - 1), 300);
                    } else {
                        console.warn('Google Identity Services script did not load — check network access.');
                    }
                    return;
                }

                google.accounts.id.initialize({
                    client_id: GOOGLE_CLIENT_ID,
                    callback: handleGoogleCredentialResponse
                });

                if (googleBtnFarmer) {
                    google.accounts.id.renderButton(googleBtnFarmer, { theme: 'outline', size: 'large', width: 280, text: 'continue_with' });
                }
                if (googleBtnBuyer) {
                    google.accounts.id.renderButton(googleBtnBuyer, { theme: 'outline', size: 'large', width: 280, text: 'continue_with' });
                }
            }

            initGoogleSignIn();

            // product listings live in firestore now so every device sees the same marketplace
            function loadProductListings() {
                return window.__agriLatestProducts || [];
            }

            window.onProductsUpdated = function () {
                renderProductListings();
            };

            // compress image to fit under firestore's 1mb doc limit, camera photos can be huge
            const MAX_IMAGE_DATA_URL_BYTES = 700 * 1024; // leave headroom for other fields

            function compressImageFile(file, maxDim = 800, quality = 0.7) {
                return new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = (e) => {
                        const img = new Image();
                        img.onload = () => {
                            const attempt = (dim, q) => {
                                let { width, height } = img;
                                if (width > height && width > dim) {
                                    height = Math.round(height * (dim / width));
                                    width = dim;
                                } else if (height > dim) {
                                    width = Math.round(width * (dim / height));
                                    height = dim;
                                }
                                const canvas = document.createElement('canvas');
                                canvas.width = width;
                                canvas.height = height;
                                canvas.getContext('2d').drawImage(img, 0, 0, width, height);
                                return canvas.toDataURL('image/jpeg', q);
                            };

                            let dim = maxDim;
                            let q = quality;
                            let dataUrl = attempt(dim, q);
                            let tries = 0;
                            // keep shrinking until it fits or we give up
                            while (dataUrl.length > MAX_IMAGE_DATA_URL_BYTES && tries < 6) {
                                dim = Math.round(dim * 0.75);
                                q = Math.max(0.4, q - 0.1);
                                dataUrl = attempt(dim, q);
                                tries++;
                            }

                            if (dataUrl.length > MAX_IMAGE_DATA_URL_BYTES) {
                                reject(new Error('Image is too large to store even after compression. Please choose a smaller photo.'));
                                return;
                            }
                            resolve(dataUrl);
                        };
                        img.onerror = reject;
                        img.src = e.target.result;
                    };
                    reader.onerror = reject;
                    reader.readAsDataURL(file);
                });
            }

            // farmers can only pick from these categories
            const ALLOWED_PRODUCT_CATEGORIES = ['Vegetables', 'Fruits', 'Seeds', 'Tools'];
            const CATEGORY_ICONS = {
                'Vegetables': '🥦',
                'Fruits': '🍎',
                'Seeds': '🌱',
                'Tools': '🛠️'
            };

            // turns firestore error codes into something readable instead of generic "check connection"
            function describeFirestoreWriteError(err, fallback) {
                if (err && err.code === 'permission-denied') {
                    return `Could not save: the database is not accepting writes for this yet (permission denied). This means Firestore's security rules need a rule added for this collection — it's a configuration issue, not your connection.`;
                }
                if (err && (err.code === 'invalid-argument' || err.code === 'resource-exhausted')) {
                    return 'Could not save: the data was too large or invalid. Try shortening it.';
                }
                if (err && err.code === 'unavailable') {
                    return 'Could not save: the server is temporarily unreachable. Please check your connection and try again.';
                }
                return fallback;
            }

            async function addProductListing(name, qty, price, imageDataUrl, category, description = '') {
                if (!currentUser || currentUser.role !== 'farmer') return false;
                if (!name || isNaN(qty) || qty <= 0 || isNaN(price) || price <= 0) {
                    showToast(translations[currentLang]['toast-error-fields'], false);
                    return false;
                }
                if (!ALLOWED_PRODUCT_CATEGORIES.includes(category)) {
                    showToast(translations[currentLang]['toast-error-category'], false);
                    return false;
                }
                if (!imageDataUrl) {
                    showToast(translations[currentLang]['toast-error-image'], false);
                    return false;
                }
                if (typeof window.fbAddProduct !== 'function') {
                    showToast('Marketplace sync is unavailable right now — please try again in a moment.', false);
                    return false;
                }
                if (!navigator.onLine) {
                    showToast('You appear to be offline. Reconnect and try again.', false);
                    return false;
                }
                try {
                    await window.fbAddProduct({
                        name,
                        qty: parseInt(qty),
                        price: parseFloat(price),
                        farmerName: currentUser.name,
                        farmerPlace: currentUser.place || '',
                        image: imageDataUrl,
                        category,
                        description: (description || '').trim()
                    });
                    // No need to call renderProductListings() here — the Firestore
                    // onSnapshot listener in firebase.js will fire onProductsUpdated
                    // for this browser (and every other logged-in account) shortly.
                    showToast(`${name} has been listed for sale!`, true);
                    return true;
                } catch (err) {
                    // Surface *why* it failed instead of a one-size-fits-all message —
                    // "permission-denied" (Firestore security rules blocking writes)
                    // and "invalid-argument"/oversized payload are the two real causes
                    // seen in practice; both were previously masked as a generic
                    // "check your connection" toast, which sent debugging in the
                    // wrong direction (looks like a network problem, isn't one).
                    console.error('Failed to add product listing:', err);
                    showToast(describeFirestoreWriteError(err, 'Could not publish your listing. Please try again.'), false);
                    return false;
                }
            };

            window.removeProductListing = async function (id) {
                if (typeof window.fbRemoveProduct !== 'function') return;
                try {
                    await window.fbRemoveProduct(id);
                    showToast('Listing removed.', true);
                } catch (err) {
                    console.error('Failed to remove product listing:', err);
                    showToast('Could not remove the listing. Please try again.', false);
                }
            };

            window.buyProductListing = async function (id) {
                const products = loadProductListings();
                const product = products.find(p => p.id === id);
                if (!product || product.qty <= 0) return;

                const qtyInput = document.getElementById(`buyQty-${id}`);
                let requestedQty = qtyInput ? parseInt(qtyInput.value) : 1;
                if (isNaN(requestedQty) || requestedQty <= 0) requestedQty = 1;

                if (requestedQty > product.qty) {
                    showToast(translations[currentLang]['toast-sold-out'](product.qty, product.name), false);
                    return;
                }

                if (typeof window.fbUpdateProductQty !== 'function') {
                    showToast('Marketplace sync is unavailable right now — please try again in a moment.', false);
                    return;
                }

                const newQty = product.qty - requestedQty;
                try {
                    await window.fbUpdateProductQty(id, newQty);
                } catch (err) {
                    console.error('Failed to update product quantity:', err);
                    showToast('Could not complete the purchase. Please try again.', false);
                    return;
                }

                const buyerName = (currentUser && currentUser.name) ? currentUser.name : 'A buyer';
                const unitWordEn = requestedQty > 1 ? 'units' : 'unit';
                addFarmerNotification(
                    product.farmerName,
                    `${buyerName} bought ${requestedQty} ${unitWordEn} of your ${product.name}.`,
                    `${buyerName} ने आपके ${product.name} की ${requestedQty} इकाइयाँ खरीदीं।`
                );

                addToCart(product.name, requestedQty, product.price, product.id, product.farmerName);
            };

            function renderProductListings() {
                if (!currentUser) return;
                const products = loadProductListings();

                const myListingsItems = document.getElementById('myListingsItems');
                if (myListingsItems) {
                    const mine = products.filter(p => p.farmerName === currentUser.name);
                    if (mine.length === 0) {
                        myListingsItems.innerHTML = `<p>You haven't listed any products yet.</p>`;
                    } else {
                        myListingsItems.innerHTML = mine.map(p => {
                            const rating = getProductRating(p.id);
                            const name = escapeHtml(p.name);
                            return `
                            <div class="listing-item">
                                <div class="listing-item-content">
                                    ${p.image ? `<img src="${p.image}" alt="${name}" class="listing-item-thumb">` : ''}
                                    <span>${p.category ? `<span class="category-badge">${CATEGORY_ICONS[p.category] || ''} ${escapeHtml(p.category)}</span>` : ''}<strong>${name}</strong> — ${p.qty > 0 ? `${p.qty} units left` : `<span style="color:#d32f2f;">Sold Out</span>`} × ₹${p.price.toFixed(2)}
                                    ${rating ? `<br><span class="rating-badge">${starsHtml(rating.avg)} ${rating.avg.toFixed(1)} (${rating.count})</span>` : ''}
                                    ${p.description ? `<p class="product-description">${escapeHtml(p.description)}</p>` : ''}</span>
                                </div>
                                <button class="remove-btn" onclick="removeProductListing('${p.id}')"><i class="fas fa-trash-alt"></i> Remove</button>
                            </div>
                        `;
                        }).join('');
                    }
                }

                const availableProductsItems = document.getElementById('availableProductsItems');
                if (availableProductsItems) {
                    if (products.length === 0) {
                        availableProductsItems.innerHTML = `<p>No products listed yet. Check back soon!</p>`;
                    } else {
                        availableProductsItems.innerHTML = products.map(p => {
                            const rating = getProductRating(p.id);
                            const name = escapeHtml(p.name);
                            const farmerName = escapeHtml(p.farmerName);
                            const farmerPlace = escapeHtml(p.farmerPlace);
                            return `
                            <div class="listing-item">
                                <div class="listing-item-content">
                                    ${p.image ? `<img src="${p.image}" alt="${name}" class="listing-item-thumb">` : ''}
                                    <span>${p.category ? `<span class="category-badge">${CATEGORY_ICONS[p.category] || ''} ${escapeHtml(p.category)}</span>` : ''}<strong>${name}</strong> — ${p.qty > 0 ? `${p.qty} units available` : `<span style="color:#d32f2f;">Sold Out</span>`} × ₹${p.price.toFixed(2)}<br>
                                    ${rating ? `<span class="rating-badge">${starsHtml(rating.avg)} ${rating.avg.toFixed(1)} (${rating.count})</span><br>` : ''}
                                    ${p.description ? `<p class="product-description">${escapeHtml(p.description)}</p>` : ''}
                                    <small>Sold by ${farmerName}${p.farmerPlace ? ', ' + farmerPlace : ''}</small></span>
                                </div>
                                ${p.qty > 0 ? `
                                <div class="buy-controls" style="display:flex;align-items:center;gap:8px;">
                                    <input type="number" id="buyQty-${p.id}" min="1" max="${p.qty}" value="1" aria-label="Quantity to buy" style="width:60px;padding:6px;border-radius:4px;border:1px solid var(--color-card-border); background: var(--color-card-bg); color: var(--color-text); font-size:16px;">
                                    <button onclick="buyProductListing('${p.id}')"><i class="fas fa-cart-plus"></i> Add to Cart</button>
                                </div>` : ''}
                            </div>
                        `;
                        }).join('');
                    }
                }
            }

            // notify farmer bell icon when a buyer buys something
            const notifBellContainer = document.getElementById('notifBellContainer');
            const notifBellBtn = document.getElementById('notifBellBtn');
            const notifBadge = document.getElementById('notifBadge');
            const notifDropdown = document.getElementById('notifDropdown');

            function addFarmerNotification(farmerName, textEn, textHi) {
                if (typeof window.fbAddNotification !== 'function') return;
                window.fbAddNotification({
                    farmerName,
                    en: textEn,
                    hi: textHi || textEn
                }).catch(err => console.error('Failed to send notification:', err));
            }

            function timeAgo(ts) {
                const diff = Math.floor((Date.now() - ts) / 1000);
                const t = TIME_AGO_TEXT[currentLang] || TIME_AGO_TEXT.en;
                if (diff < 60) return t.justNow;
                if (diff < 3600) return t.min(Math.floor(diff / 60));
                if (diff < 86400) return t.hr(Math.floor(diff / 3600));
                return t.day(Math.floor(diff / 86400));
            }

            function renderNotifications() {
                if (!notifBellContainer) return;
                if (!currentUser || currentUser.role !== 'farmer') {
                    notifBadge.style.display = 'none';
                    return;
                }
                const mine = (window.__agriLatestNotifications || [])
                    .filter(n => n.farmerName === currentUser.name)
                    .sort((a, b) => b.createdAt - a.createdAt);
                const unreadCount = mine.filter(n => !n.read).length;

                notifBadge.textContent = unreadCount > 9 ? '9+' : unreadCount;
                notifBadge.style.display = unreadCount > 0 ? 'flex' : 'none';

                if (mine.length === 0) {
                    notifDropdown.innerHTML = `<p class="notif-empty">${NOTIF_EMPTY_TEXT[currentLang] || NOTIF_EMPTY_TEXT.en}</p>`;
                } else {
                    notifDropdown.innerHTML = mine.map(n => `
                        <div class="notif-item ${n.read ? '' : 'unread'}">
                            ${escapeHtml(n[currentLang] || n.en)}
                            <span class="notif-time">${timeAgo(n.createdAt)}</span>
                        </div>
                    `).join('');
                }
            }

            function markFarmerNotificationsRead() {
                if (!currentUser || currentUser.role !== 'farmer') return;
                const unreadIds = (window.__agriLatestNotifications || [])
                    .filter(n => n.farmerName === currentUser.name && !n.read)
                    .map(n => n.id);
                if (unreadIds.length === 0) return;
                if (typeof window.fbMarkNotificationsRead === 'function') {
                    window.fbMarkNotificationsRead(unreadIds).catch(err => console.error('Failed to mark notifications read:', err));
                }
            }

            window.onNotificationsUpdated = function () {
                renderNotifications();
            };

            if (notifBellBtn) {
                notifBellBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const opening = !notifDropdown.classList.contains('open');
                    notifDropdown.classList.toggle('open');
                    if (opening) {
                        renderNotifications();
                        setTimeout(() => {
                            markFarmerNotificationsRead();
                            renderNotifications();
                        }, 1500);
                    }
                });
                document.addEventListener('click', (e) => {
                    if (!notifBellContainer.contains(e.target)) {
                        notifDropdown.classList.remove('open');
                    }
                });
            }

            // buyer's own purchase history stays local, reviews/messages sync via firestore
            const PURCHASE_STORAGE_KEY = 'agriBuyerPurchases';

            function loadPurchases() {
                try {
                    return JSON.parse(localStorage.getItem(PURCHASE_STORAGE_KEY)) || {};
                } catch (e) {
                    return {};
                }
            }

            function savePurchases(data) {
                localStorage.setItem(PURCHASE_STORAGE_KEY, JSON.stringify(data));
            }

            function recordPurchase(item) {
                if (!currentUser || currentUser.role !== 'buyer') return;
                const all = loadPurchases();
                if (!all[currentUser.name]) all[currentUser.name] = [];
                all[currentUser.name].unshift({
                    id: Date.now() + Math.random().toString(16).slice(2),
                    productId: item.productId,
                    name: item.name,
                    farmerName: item.farmerName,
                    qty: item.qty,
                    price: item.price,
                    time: Date.now()
                });
                savePurchases(all);
            }

            // keeps track of which review/message form is open so a firestore update doesn't wipe it mid-typing
            let openPurchaseForm = null;

            function getProductRating(productId) {
                const reviews = (window.__agriLatestReviews || []).filter(r => r.productId === productId);
                if (reviews.length === 0) return null;
                const avg = reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length;
                return { avg, count: reviews.length };
            }

            function starsHtml(value, max = 5) {
                let html = '';
                for (let i = 1; i <= max; i++) {
                    html += `<i class="fa-star ${i <= Math.round(value) ? 'fas' : 'far'}"></i>`;
                }
                return html;
            }

            function t(key) {
                return (translations[currentLang] && translations[currentLang][key]) || translations.en[key];
            }

            function renderPurchases() {
                const container = document.getElementById('myPurchasesItems');
                if (!container || !currentUser || currentUser.role !== 'buyer') return;

                const all = loadPurchases();
                const mine = all[currentUser.name] || [];

                if (mine.length === 0) {
                    container.innerHTML = `<p>${t('purchases-empty')}</p>`;
                    return;
                }

                const myReviews = (window.__agriLatestReviews || []).filter(r => r.buyerName === currentUser.name);
                const myMessages = (window.__agriLatestMessages || []).filter(m => m.buyerName === currentUser.name);

                container.innerHTML = mine.map(p => {
                    const existingReview = myReviews.find(r => r.productId === p.productId);
                    const threadMessages = myMessages
                        .filter(m => m.farmerName === p.farmerName)
                        .sort((a, b) => a.createdAt - b.createdAt);

                    const reviewOpen = openPurchaseForm === `review-${p.id}`;
                    const msgOpen = openPurchaseForm === `message-${p.id}`;
                    const productName = escapeHtml(p.name);
                    const farmerName = escapeHtml(p.farmerName);

                    return `
                        <div class="purchase-item">
                            <div class="listing-item-content">
                                <span>
                                    <strong>${productName}</strong> — ${p.qty} units × ₹${p.price.toFixed(2)}<br>
                                    <small>${t('purchase-bought-from')} ${farmerName} · ${timeAgo(p.time)}</small>
                                </span>
                            </div>

                            <div class="purchase-actions">
                                <button onclick="toggleReviewForm('${p.id}')"><i class="fas fa-star"></i> ${existingReview ? t('btn-update-review') : t('btn-leave-review')}</button>
                                <button onclick="toggleMessageForm('${p.id}')"><i class="fas fa-envelope"></i> ${t('btn-message-farmer')}</button>
                            </div>

                            ${existingReview && !reviewOpen ? `
                                <div class="review-readonly">
                                    <span class="star-rating-display">${starsHtml(existingReview.rating)}</span>
                                    ${existingReview.comment ? `<p>${escapeHtml(existingReview.comment)}</p>` : ''}
                                </div>
                            ` : ''}

                            <div class="review-panel" style="display:${reviewOpen ? 'block' : 'none'};">
                                <div class="star-rating" id="starRating-${p.id}" data-value="${existingReview ? existingReview.rating : 0}">
                                    ${[1,2,3,4,5].map(n => `<i class="${existingReview && n <= existingReview.rating ? 'fas' : 'far'} fa-star" onclick="setReviewRating('${p.id}', ${n})"></i>`).join('')}
                                </div>
                                <textarea id="reviewComment-${p.id}" rows="2" placeholder="${t('review-comment-placeholder')}">${existingReview ? escapeHtml(existingReview.comment || '') : ''}</textarea>
                                <button onclick="submitReview('${p.id}')">${t('btn-submit-review')}</button>
                            </div>

                            <div class="message-panel" style="display:${msgOpen ? 'block' : 'none'};">
                                ${threadMessages.length > 0 ? `
                                    <div class="message-thread">
                                        ${threadMessages.map(m => `<div class="message-bubble-buyer">${escapeHtml(m.text)}<span class="message-time">${timeAgo(m.createdAt)}</span></div>`).join('')}
                                    </div>
                                ` : ''}
                                <textarea id="messageText-${p.id}" rows="2" placeholder="${t('message-ask-placeholder')(farmerName)}"></textarea>
                                <button onclick="submitMessage('${p.id}')">${t('btn-send-message')}</button>
                            </div>
                        </div>
                    `;
                }).join('');
            }

            window.toggleReviewForm = function (purchaseId) {
                const key = `review-${purchaseId}`;
                openPurchaseForm = (openPurchaseForm === key) ? null : key;
                renderPurchases();
            };

            window.toggleMessageForm = function (purchaseId) {
                const key = `message-${purchaseId}`;
                openPurchaseForm = (openPurchaseForm === key) ? null : key;
                renderPurchases();
            };

            window.setReviewRating = function (purchaseId, value) {
                const el = document.getElementById(`starRating-${purchaseId}`);
                if (!el) return;
                el.setAttribute('data-value', value);
                Array.from(el.children).forEach((star, i) => {
                    star.className = (i < value ? 'fas' : 'far') + ' fa-star';
                });
            };

            window.submitReview = async function (purchaseId) {
                if (!currentUser || currentUser.role !== 'buyer') return;
                const all = loadPurchases();
                const mine = all[currentUser.name] || [];
                const purchase = mine.find(p => p.id === purchaseId);
                if (!purchase) return;

                const ratingEl = document.getElementById(`starRating-${purchaseId}`);
                const rating = ratingEl ? parseInt(ratingEl.getAttribute('data-value')) : 0;
                if (!rating || rating < 1 || rating > 5) {
                    showToast(t('toast-select-rating'), false);
                    return;
                }
                const commentEl = document.getElementById(`reviewComment-${purchaseId}`);
                const comment = commentEl ? commentEl.value.trim() : '';

                if (typeof window.fbAddReview !== 'function') {
                    showToast(t('toast-reviews-unavailable'), false);
                    return;
                }
                try {
                    await window.fbAddReview({
                        productId: purchase.productId,
                        productName: purchase.name,
                        farmerName: purchase.farmerName,
                        buyerName: currentUser.name,
                        rating,
                        comment
                    });
                    showToast(t('toast-review-thanks'), true);
                    openPurchaseForm = null;
                    renderPurchases();
                    renderProductListings();
                } catch (err) {
                    console.error('Failed to submit review:', err);
                    showToast(describeFirestoreWriteError(err, t('toast-review-error')), false);
                }
            };

            window.submitMessage = async function (purchaseId) {
                if (!currentUser || currentUser.role !== 'buyer') return;
                const all = loadPurchases();
                const mine = all[currentUser.name] || [];
                const purchase = mine.find(p => p.id === purchaseId);
                if (!purchase) return;

                const textEl = document.getElementById(`messageText-${purchaseId}`);
                const text = textEl ? textEl.value.trim() : '';
                if (!text) {
                    showToast(t('toast-write-message-first'), false);
                    return;
                }

                if (typeof window.fbAddMessage !== 'function') {
                    showToast(t('toast-messaging-unavailable'), false);
                    return;
                }
                try {
                    await window.fbAddMessage({
                        farmerName: purchase.farmerName,
                        buyerName: currentUser.name,
                        productName: purchase.name,
                        text
                    });
                    showToast(t('toast-message-sent')(purchase.farmerName), true);
                    renderPurchases();
                } catch (err) {
                    console.error('Failed to send message:', err);
                    showToast(describeFirestoreWriteError(err, t('toast-message-error')), false);
                }
            };

            function renderFarmerMessages() {
                const container = document.getElementById('farmerMessagesItems');
                if (!container || !currentUser || currentUser.role !== 'farmer') return;

                const mine = (window.__agriLatestMessages || [])
                    .filter(m => m.farmerName === currentUser.name)
                    .sort((a, b) => b.createdAt - a.createdAt);

                if (mine.length === 0) {
                    container.innerHTML = `<p>${t('messages-empty')}</p>`;
                    return;
                }

                container.innerHTML = mine.map(m => `
                    <div class="farmer-message-item">
                        <div>
                            <strong>${escapeHtml(m.buyerName)}</strong> ${m.productName ? `<span class="category-badge">${t('msg-about-prefix')} ${escapeHtml(m.productName)}</span>` : ''}
                            <span class="message-time">${timeAgo(m.createdAt)}</span>
                        </div>
                        <p>${escapeHtml(m.text)}</p>
                    </div>
                `).join('');
            }

            window.onReviewsUpdated = function () {
                renderProductListings();
                if (!openPurchaseForm) renderPurchases();
            };
            window.onMessagesUpdated = function () {
                renderFarmerMessages();
                if (!openPurchaseForm) renderPurchases();
            };

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
                                <strong>${escapeHtml(item.name)}</strong> — ${item.qty} units × ₹${item.price.toFixed(2)} = ₹${subtotal.toFixed(2)}
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

            function addToCart(name, qty, price, productId = null, farmerName = null) {
                if (!name || isNaN(qty) || qty <= 0 || isNaN(price) || price <= 0) {
                    showToast(translations[currentLang]['toast-error-fields'], false);
                    return;
                }
                cart.push({ name, qty: parseInt(qty), price: parseFloat(price), productId, farmerName });
                showToast(translations[currentLang]['alert-cart-add'](name), true);
                displayCart();
            }
            window.removeItem = async function (index) {
                const item = cart[index];
                // give stock back if this came from a real listing
                if (item && item.productId && typeof window.fbUpdateProductQty === 'function') {
                    const products = loadProductListings();
                    const product = products.find(p => p.id === item.productId);
                    if (product) {
                        try {
                            await window.fbUpdateProductQty(item.productId, product.qty + item.qty);
                        } catch (err) {
                            console.error('Failed to restore stock:', err);
                        }
                    }
                }
                cart.splice(index, 1);
                displayCart();
            }

            window.makePayment = function (amount) {
                if (amount <= 0 || cart.length === 0) {
                    showToast(translations[currentLang]['alert-empty-cart'], false);
                    return;
                }

                // fake payment processing
                showToast(translations[currentLang]['alert-pay-processing'](amount), true);
                
                setTimeout(() => {
                    showToast(translations[currentLang]['alert-pay-success'](amount), true);
                    // only real listings can be reviewed/messaged, skip quick-buy items
                    cart.forEach(item => {
                        if (item.productId && item.farmerName) {
                            recordPurchase(item);
                        }
                    });
                    cart = [];
                    displayCart();
                    renderPurchases();
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
            const navLinks = Array.from(document.querySelectorAll('.nav-link'));
            let activeSectionID = 'marketplace';

            // mobile fix: panels are position:absolute so container doesn't auto-grow.
            // old hardcoded min-height clipped content on phones, now measure actual height instead
            function syncContainerHeight() {
                if (!container) return;
                const activeSection = document.getElementById(activeSectionID);
                if (activeSection) {
                    container.style.minHeight = activeSection.scrollHeight + 'px';
                }
            }
            function debounce(fn, wait) {
                let t;
                return (...args) => {
                    clearTimeout(t);
                    t = setTimeout(() => fn(...args), wait);
                };
            }
            const debouncedSyncHeight = debounce(syncContainerHeight, 120);

            sections.forEach((sec, i) => {
                 if (sec.id !== activeSectionID) {
                    sec.classList.remove('active-panel');
                    sec.style.transform = 'translateX(100%)';
                    sec.style.opacity = '0';
                 }
            });

            function navigateToSection(targetID, link) {
                if (targetID === activeSectionID) {
                    navLinks.forEach(l => l.classList.remove('active'));
                    if (link) link.classList.add('active');
                    return;
                }

                const current = document.getElementById(activeSectionID);
                const next = document.getElementById(targetID);
                if (!current || !next) return;

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
                // resize now (best guess) and again after the slide finishes
                syncContainerHeight();
                setTimeout(syncContainerHeight, 650);

                navLinks.forEach(l => l.classList.remove('active'));
                if (link) link.classList.add('active');
            }

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
                    link.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
                    navigateToSection(targetID, link);
                });
            });

            // navbar as a draggable "picker wheel" - centered pill becomes active page, others shrink/fade
            function setupNavWheel() {
                const navbar = document.querySelector('.navbar');
                if (!navbar) return;

                function visibleItems() {
                    return navLinks.filter(item => getComputedStyle(item).display !== 'none');
                }

                // pad both ends so first/last pill can still reach center
                function sizeSpacers() {
                    const visible = visibleItems();
                    if (visible.length === 0) return;
                    const containerWidth = navbar.clientWidth;
                    const firstW = visible[0].offsetWidth;
                    const lastW = visible[visible.length - 1].offsetWidth;
                    navbar.style.paddingLeft = Math.max(containerWidth / 2 - firstW / 2, 0) + 'px';
                    navbar.style.paddingRight = Math.max(containerWidth / 2 - lastW / 2, 0) + 'px';
                }

                // scale/fade pills based on distance from center
                function updateWheelVisuals() {
                    const rect = navbar.getBoundingClientRect();
                    const center = rect.left + rect.width / 2;
                    let closest = null;
                    let closestDist = Infinity;
                    visibleItems().forEach(item => {
                        const r = item.getBoundingClientRect();
                        const itemCenter = r.left + r.width / 2;
                        const dist = Math.abs(itemCenter - center);
                        const t = Math.min(dist / (rect.width / 2), 1);
                        item.style.transform = `scale(${(1 - t * 0.22).toFixed(3)})`;
                        item.style.opacity = (1 - t * 0.5).toFixed(2);
                        if (dist < closestDist) {
                            closestDist = dist;
                            closest = item;
                        }
                    });
                    return closest;
                }

                let settleTimer = null;
                function onScrollSettled() {
                    const centered = updateWheelVisuals();
                    if (!centered) return;
                    const targetID = centered.getAttribute('data-target');
                    if (targetID) navigateToSection(targetID, centered);
                }

                navbar.addEventListener('scroll', () => {
                    updateWheelVisuals();
                    clearTimeout(settleTimer);
                    settleTimer = setTimeout(onScrollSettled, 130);
                }, { passive: true });

                // mouse-drag for desktop (touch already scrolls natively)
                let isDown = false;
                let dragged = false;
                let startX = 0;
                let startScroll = 0;

                navbar.addEventListener('mousedown', (e) => {
                    isDown = true;
                    dragged = false;
                    navbar.classList.add('wheel-dragging');
                    startX = e.pageX;
                    startScroll = navbar.scrollLeft;
                });
                window.addEventListener('mousemove', (e) => {
                    if (!isDown) return;
                    const dx = e.pageX - startX;
                    if (Math.abs(dx) > 4) dragged = true;
                    navbar.scrollLeft = startScroll - dx;
                });
                window.addEventListener('mouseup', () => {
                    if (!isDown) return;
                    isDown = false;
                    navbar.classList.remove('wheel-dragging');
                });
                // don't let a drag-release also trigger a click-navigate
                navbar.addEventListener('click', (e) => {
                    if (dragged) {
                        e.preventDefault();
                        e.stopPropagation();
                        dragged = false;
                    }
                }, true);

                window.addEventListener('resize', debounce(() => {
                    sizeSpacers();
                    updateWheelVisuals();
                }, 150));

                sizeSpacers();
                updateWheelVisuals();

                // login/logout changes which pills show, so let it re-center the wheel
                window.__resizeNavWheel = () => {
                    sizeSpacers();
                    updateWheelVisuals();
                };
            }
            setupNavWheel();

            window.addEventListener('resize', debouncedSyncHeight);

            // recompute height on any content change (products, cart, chat, lang switch etc)
            // instead of calling syncContainerHeight() everywhere manually
            if (container) {
                const containerObserver = new MutationObserver(debouncedSyncHeight);
                containerObserver.observe(container, { childList: true, subtree: true, characterData: true });
            }

            syncContainerHeight();
            setTimeout(syncContainerHeight, 300);

            // text to speech
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
                const listenBtn = document.getElementById('techniqueListenBtn');
                if (listenBtn) {
                    listenBtn.classList.remove('speaking');
                    listenBtn.innerHTML = `<i class="fas fa-volume-up"></i> <span id="listenLabel" data-key="listen-label">${(translations[currentLang] && translations[currentLang]['listen-label']) || 'Listen'}</span>`;
                }
            }

            // Shared by the section "read aloud" buttons and the learning-guide listen
            // button — both just gather some text and hand it to Gemini TTS the same way.
            async function speakText(button, content) {
                if (!content) return;

                button.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
                button.classList.add('speaking');

                try {
                    const voiceName = (TTS_LANG_CONFIG[body.getAttribute('lang')] || TTS_LANG_CONFIG.en).voice;
                    const response = await fetchWithBackoff(TTS_PROXY_URL, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ text: content, voiceName })
                    });

                    const result = await response.json();
                    const part = result?.candidates?.[0]?.content?.parts?.[0];
                    const audioData = part?.inlineData?.data;
                    const mimeType = part?.inlineData?.mimeType;

                    if (audioData && mimeType && mimeType.startsWith("audio/")) {
                        const sampleRateMatch = mimeType.match(/rate=(\d+)/);
                        const sampleRate = sampleRateMatch ? parseInt(sampleRateMatch[1], 10) : 16000;
                        const pcm16 = new Int16Array(base64ToArrayBuffer(audioData));
                        const wavBlob = pcmToWav(pcm16, sampleRate);

                        if (audioEl.src) URL.revokeObjectURL(audioEl.src);
                        audioEl.src = URL.createObjectURL(wavBlob);
                        audioEl.play();

                        button.innerHTML = '<i class="fas fa-volume-off"></i>';
                        audioEl.onended = () => stopPlayback();
                    } else {
                        showToast("TTS failed: Could not generate audio.", false);
                        stopPlayback();
                    }
                } catch (error) {
                    console.error("TTS API Error:", error);
                    showToast("TTS service unavailable. Please try later.", false);
                    stopPlayback();
                }
            }

            const ttsButtons = document.querySelectorAll('.tts-button');
            ttsButtons.forEach(button => {
                button.addEventListener('click', () => {
                    if (button.classList.contains('speaking')) {
                        stopPlayback();
                        return;
                    } else if (!audioEl.paused) {
                        stopPlayback();
                    }

                    const sectionElement = document.getElementById(button.getAttribute('data-content-id'));
                    let content = '';
                    sectionElement.querySelectorAll('[data-key], p, h2, h3, h4, li').forEach(el => {
                        // skip buttons and chat content
                        if (!el.classList.contains('tts-button') && !el.classList.contains('tooltip-text') && !el.closest('#agriChatContainer')) {
                            content += el.textContent.trim() + '. ';
                        }
                    });

                    button.style.boxShadow = `0 0 10px var(--color-accent)`;
                    speakText(button, content);
                });
            });
            // LEARNING HUB — "tap to see easy guide" cards open the notebook-style modal
            const TOPIC_GUIDES = {
                irrigation: { emoji: '💧', diagram: '🚰 → 💧 → 🌱' },
                organic:    { emoji: '🌿', diagram: '🍂 → 🪱 → 🌾' },
                insurance:  { emoji: '📄', diagram: '🌾 → 📄 → 💰' },
                cloud:      { emoji: '☁️', diagram: '📱 → ☁️ → 📊' }
            };
            const TOPIC_COURSE_INDEX = { irrigation: 1, organic: 2, insurance: 3, cloud: 4 };

            const techniqueOverlay = document.getElementById('techniqueOverlay');
            const techniqueModal = document.getElementById('techniqueModal');

            function openTechniqueModal(topic) {
                const guide = TOPIC_GUIDES[topic];
                const courseNum = TOPIC_COURSE_INDEX[topic];
                if (!guide || !courseNum || !techniqueModal || !techniqueOverlay) return;

                document.getElementById('techniqueEmoji').textContent = guide.emoji;
                document.getElementById('techniqueModalTitle').textContent = t(`course-${courseNum}-title`);
                document.getElementById('techniqueDiagram').textContent = guide.diagram;

                const stepsEl = document.getElementById('techniqueSteps');
                stepsEl.innerHTML = '';
                for (let i = 1; i <= 4; i++) {
                    const stepText = t(`guide-${topic}-step-${i}`);
                    if (!stepText) continue;
                    const stepDiv = document.createElement('div');
                    stepDiv.textContent = `${i}. ${stepText}`;
                    stepsEl.appendChild(stepDiv);
                }

                document.getElementById('techniqueTip').textContent = t(`guide-${topic}-tip`);
                techniqueModal.dataset.topic = topic;

                techniqueOverlay.classList.add('visible');
                techniqueModal.classList.add('visible');
                document.body.style.overflow = 'hidden';
            }

            window.closeTechniqueModal = function () {
                if (!techniqueModal || !techniqueOverlay) return;
                techniqueOverlay.classList.remove('visible');
                techniqueModal.classList.remove('visible');
                document.body.style.overflow = '';
                if (audioEl && !audioEl.paused && document.getElementById('techniqueListenBtn')?.classList.contains('speaking')) {
                    stopPlayback();
                }
            };

            document.querySelectorAll('.learning-card').forEach(card => {
                card.addEventListener('click', () => openTechniqueModal(card.getAttribute('data-topic')));
                card.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        openTechniqueModal(card.getAttribute('data-topic'));
                    }
                });
            });

            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && techniqueModal && techniqueModal.classList.contains('visible')) {
                    closeTechniqueModal();
                }
            });

            const techniqueListenBtn = document.getElementById('techniqueListenBtn');
            if (techniqueListenBtn) {
                techniqueListenBtn.addEventListener('click', () => {
                    if (techniqueListenBtn.classList.contains('speaking')) {
                        stopPlayback();
                        return;
                    } else if (!audioEl.paused) {
                        stopPlayback();
                    }
                    const parts = [
                        document.getElementById('techniqueModalTitle').textContent,
                        document.getElementById('techniqueTip').textContent
                    ];
                    document.querySelectorAll('#techniqueSteps > div').forEach(el => parts.push(el.textContent));
                    speakText(techniqueListenBtn, parts.join('. '));
                });
            }

            // SELL YOUR PRODUCTS — image select/preview + Post for Sale submit.
            // (These fields existed in the HTML but had no listeners at all, so
            // choosing a photo never showed a preview and the button did nothing.)
            const sellImageInput = document.getElementById('sellImage');
            const sellImagePreview = document.getElementById('sellImagePreview');
            const postForSaleBtn = document.getElementById('postForSaleBtn');
            let sellImageDataUrl = null;

            if (sellImageInput) {
                sellImageInput.addEventListener('change', async () => {
                    const file = sellImageInput.files[0];
                    if (!file) return;
                    sellImagePreview.style.display = 'none';
                    try {
                        sellImageDataUrl = await compressImageFile(file);
                        sellImagePreview.src = sellImageDataUrl;
                        sellImagePreview.style.display = 'block';
                    } catch (err) {
                        console.error('Failed to process product photo:', err);
                        sellImageDataUrl = null;
                        showToast(err.message || 'Could not process that photo. Try a different one.', false);
                        sellImageInput.value = '';
                    }
                });
            }

            if (postForSaleBtn) {
                postForSaleBtn.addEventListener('click', async () => {
                    postForSaleBtn.disabled = true;
                    const originalLabel = postForSaleBtn.innerHTML;
                    postForSaleBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
                    try {
                        const category = document.getElementById('sellCategory').value;
                        const name = document.getElementById('sellName').value.trim();
                        const qty = parseFloat(document.getElementById('sellQty').value);
                        const price = parseFloat(document.getElementById('sellPrice').value);
                        const description = document.getElementById('sellDescription').value;

                        const ok = await addProductListing(name, qty, price, sellImageDataUrl, category, description);
                        if (ok) {
                            document.getElementById('sellCategory').value = '';
                            document.getElementById('sellName').value = '';
                            document.getElementById('sellQty').value = '';
                            document.getElementById('sellPrice').value = '';
                            document.getElementById('sellDescription').value = '';
                            sellImageInput.value = '';
                            sellImageDataUrl = null;
                            sellImagePreview.style.display = 'none';
                            sellImagePreview.src = '';
                        }
                    } finally {
                        postForSaleBtn.disabled = false;
                        postForSaleBtn.innerHTML = originalLabel;
                    }
                });
            }

            const langToggle = document.getElementById('langToggle');
            const langMenu = document.getElementById('langMenu');
            const translations = {
                'en': {
                    'header-title': 'AGRI DUNIYA',
                    'header-tagline': 'Empowering Farmers with Digital Access to Markets, Knowledge & Government Schemes',
                    'nav-market': 'Marketplace',
                    'nav-myproducts': 'My Products',
                    'nav-learning': 'Learning Hub',
                    'nav-videos': 'Videos',
                    'nav-schemes': 'Schemes',
                    'nav-contact': 'Contact',
                    'sec-market-title': 'Digital Marketplace',
                    'sec-market-p': 'Buy and Sell farm products directly. Farmers can list their crops, and buyers can purchase them directly ensuring fair trade.',
                    'sec-myproducts-title': 'My Products',
                    'sec-myproducts-p': "Manage the products you've listed for sale — buyers can see and purchase these directly from the marketplace.",
                    'sell-title': 'Sell Your Products',
                    'sell-button': 'Post for Sale',
                    'sell-category-label': 'Product Category (required)',
                    'category-option-default': '-- Select Category --',
                    'category-option-vegetables': '🥦 Vegetables',
                    'category-option-fruits': '🍎 Fruits',
                    'category-option-seeds': '🌱 Seeds',
                    'category-option-tools': '🛠️ Tools',
                    'sell-image-label': 'Add a Photo of the Product (required) 📷',
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
                    'guide-irrigation-step-1': 'Check soil moisture with a finger test before watering.',
                    'guide-irrigation-step-2': 'Use drip lines for row crops, sprinklers for open fields.',
                    'guide-irrigation-step-3': 'Water early morning or evening to reduce evaporation loss.',
                    'guide-irrigation-step-4': 'Inspect emitters and nozzles weekly for clogs or leaks.',
                    'guide-irrigation-tip': '💡 A quick soil check beats watering on a fixed calendar.',
                    'guide-organic-step-1': 'Build compost from crop waste, dung, and kitchen scraps.',
                    'guide-organic-step-2': 'Rotate crops each season to keep the soil naturally healthy.',
                    'guide-organic-step-3': 'Use neem oil and companion planting instead of chemical sprays.',
                    'guide-organic-step-4': 'Apply for certification once fields stay chemical-free long enough.',
                    'guide-organic-tip': '💡 Healthy soil is the real fertilizer — feed it, don\'t just feed the plant.',
                    'guide-insurance-step-1': 'Enroll before the season\'s enrollment deadline.',
                    'guide-insurance-step-2': 'Keep proof of sowing date and area on record.',
                    'guide-insurance-step-3': 'Report any crop loss to your insurer within the claim window.',
                    'guide-insurance-step-4': 'Follow up with your local agriculture office if you don\'t hear back.',
                    'guide-insurance-tip': '💡 Photograph your field right after sowing — it speeds up claims later.',
                    'guide-cloud-step-1': 'Create an account on a trusted e-krishi or farm-data portal.',
                    'guide-cloud-step-2': 'Upload your farm and harvest records regularly.',
                    'guide-cloud-step-3': 'Turn on weather and market-price alerts for your crops.',
                    'guide-cloud-step-4': 'Keep a backup of land and purchase documents as photos.',
                    'guide-cloud-tip': '💡 A synced record beats a lost paper receipt every time.',
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
                    'nav-messages': 'Messages',
                    'nav-mypurchases': 'My Purchases',
                    'sec-messages-title': 'Messages from Buyers',
                    'sec-messages-p': 'Notes buyers have sent you about your products.',
                    'messages-empty': 'No messages yet.',
                    'msg-about-prefix': 'about',
                    'sec-mypurchases-title': 'My Purchases',
                    'sec-mypurchases-p': "Products you've bought. Leave a review or send the farmer a message about your order.",
                    'purchases-empty': "You haven't bought anything yet.",
                    'purchase-bought-from': 'Bought from',
                    'btn-leave-review': 'Leave a Review',
                    'btn-update-review': 'Update Review',
                    'btn-message-farmer': 'Message Farmer',
                    'review-comment-placeholder': 'What did you think of this product? (optional)',
                    'btn-submit-review': 'Submit Review',
                    'message-ask-placeholder': (name) => `Ask ${name} a question about your order...`,
                    'btn-send-message': 'Send Message',
                    'toast-select-rating': 'Please select a star rating first.',
                    'toast-reviews-unavailable': 'Reviews are unavailable right now — please try again in a moment.',
                    'toast-review-thanks': 'Thanks for your review!',
                    'toast-review-error': 'Could not submit your review. Please try again.',
                    'toast-write-message-first': 'Please write a message first.',
                    'toast-messaging-unavailable': 'Messaging is unavailable right now — please try again in a moment.',
                    'toast-message-sent': (name) => `Message sent to ${name}.`,
                    'toast-message-error': 'Could not send your message. Please try again.',
                    'toast-success': 'Message sent successfully! We will contact you soon.',
                    'toast-error-fields': 'Please fill all marketplace fields correctly.',
                    'toast-error-image': 'Please add a photo of the product (from storage or camera) before selling.',
                    'toast-error-category': 'Please select a category: Vegetables, Fruits, Seeds, or Tools.',
                    'toast-error-search': 'Please enter a product name to search.',
                    'alert-cart-add': (name) => `${name} added to cart!`,
                    'alert-pay-success': (amount) => `Payment of ₹${amount} successful! Thank you for your purchase.`,
                    'alert-pay-processing': (amount) => `Processing payment of ₹${amount}...`,
                    'alert-search': (name) => `Searching for "${name}" in marketplace...`,
                    'alert-empty-cart': 'Your cart is empty. Nothing to pay for.',
                    'listen-label': 'Listen',
                    'steps-label': '✍️ Steps to follow:',
                    'toast-sold-out': (qty, name) => `Only ${qty} units of ${name} are available.`,
                    'nav-about': 'About Us',
                    'sec-about-title': 'About AGRI दुनिया',
                    'about-eyebrow': 'Our Story',
                    'about-headline': 'Grown by Farmers. Delivered with Care.',
                    'about-intro': "Farmers put in the work to grow good food, but by the time it reaches a plate, a large share of its value has usually gone to people who never touched the soil. AGRI दुनिया exists to change that — a platform where farmers sell straight to the people who eat what they grow, and where farming feels less like a solo struggle and more like a shared effort.",
                    'about-what-title': 'What We Do',
                    'about-what-1-title': 'Direct Selling',
                    'about-what-1-desc': 'Farmers list their produce and sell straight to consumers — no middlemen taking a cut along the way.',
                    'about-what-2-title': 'Order in Advance',
                    'about-what-2-desc': 'Consumers place orders roughly 11–12 hours before delivery, depending on distance, so farmers know exactly what to harvest.',
                    'about-what-3-title': 'Organized Collection',
                    'about-what-3-desc': 'Our assigned tempo and transport team collects produce in bulk directly from farmers, on schedule.',
                    'about-what-4-title': 'Fair Value, Both Sides',
                    'about-what-4-desc': 'Cutting out unnecessary middlemen means better returns for farmers and better prices for consumers.',
                    'about-how-title': 'How We Work',
                    'about-how-1-title': 'Farmer Harvests',
                    'about-how-1-desc': 'Fresh produce, harvested to match actual orders — not guesswork.',
                    'about-how-2-title': 'AGRI दुनिया Collects',
                    'about-how-2-desc': 'Our tempo and transport team picks up produce in bulk from farmers.',
                    'about-how-3-title': 'Sorting & Distribution',
                    'about-how-3-desc': 'Our team sorts the produce and prepares it for delivery.',
                    'about-how-4-title': 'Reaches Consumer',
                    'about-how-4-desc': 'Fresh produce delivered to the buyer, at a fair price.',
                    'about-beyond-title': 'Beyond the Marketplace',
                    'about-beyond-intro': "AGRI दुनिया isn't only a place to buy and sell. We're working toward a cooperative-style farmer community, where farmers support each other instead of competing alone in an unorganized market.",
                    'about-beyond-item-1': 'Buy and sell farming equipment',
                    'about-beyond-item-2': 'Buy seeds and other agricultural resources',
                    'about-beyond-item-3': 'Learn modern farming techniques',
                    'about-beyond-item-4': 'Stay updated on newly launched government schemes',
                    'about-beyond-item-5': 'Follow more responsible, sustainable farming practices',
                    'about-beyond-item-6': 'Work together as a community, not in isolation',
                    'about-beyond-note': "We're also working with farmers on agreements that encourage responsible use of agricultural chemicals and better farming practices — for healthier soil, and healthier food.",
                    'about-vision-title': 'Our Vision',
                    'about-vision-desc': 'We want AGRI दुनिया to be more than an app — a farming community where produce moves straight from field to family, and where farmers have the tools, knowledge, and support to grow with confidence.',
                    'about-cta-title': "Whether you grow it or you buy it, there's a place for you here.",
                    'about-cta-btn': 'Explore the Marketplace',
                    'about-social-title': 'Follow Us on Instagram',
                    'about-social-desc': "Fresh harvests, farmer stories, and what's new at AGRI दुनिया."
                },
                'hi': {
                    'header-title': 'एग्री दुनिया',
                    'header-tagline': 'किसानों को बाज़ार, ज्ञान और सरकारी योजनाओं तक डिजिटल पहुँच के साथ सशक्त बनाना',
                    'nav-market': 'बाज़ार',
                    'nav-myproducts': 'मेरे उत्पाद',
                    'nav-learning': 'सीखने का केंद्र',
                    'nav-videos': 'वीडियो',
                    'nav-schemes': 'योजनाएँ',
                    'nav-contact': 'संपर्क',
                    'sec-market-title': 'डिजिटल बाज़ार',
                    'sec-market-p': 'कृषि उत्पादों को सीधे खरीदें और बेचें। किसान अपनी फसलें सूचीबद्ध कर सकते हैं, और खरीदार सीधे खरीद सकते हैं, जिससे उचित व्यापार सुनिश्चित होगा।',
                    'sec-myproducts-title': 'मेरे उत्पाद',
                    'sec-myproducts-p': 'आपके द्वारा बिक्री के लिए सूचीबद्ध उत्पादों को प्रबंधित करें — खरीदार इन्हें सीधे बाज़ार से देख और खरीद सकते हैं।',
                    'sell-title': 'अपने उत्पाद बेचें',
                    'sell-button': 'बिक्री के लिए पोस्ट करें',
                    'sell-category-label': 'उत्पाद श्रेणी (आवश्यक)',
                    'category-option-default': '-- श्रेणी चुनें --',
                    'category-option-vegetables': '🥦 सब्ज़ियाँ',
                    'category-option-fruits': '🍎 फल',
                    'category-option-seeds': '🌱 बीज',
                    'category-option-tools': '🛠️ उपकरण',
                    'sell-image-label': 'उत्पाद की फोटो जोड़ें (आवश्यक) 📷',
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
                    'guide-irrigation-step-1': 'पानी देने से पहले उंगली से मिट्टी की नमी जाँचें।',
                    'guide-irrigation-step-2': 'कतार वाली फसलों के लिए ड्रिप और खुले खेतों के लिए स्प्रिंकलर उपयोग करें।',
                    'guide-irrigation-step-3': 'वाष्पीकरण कम करने के लिए सुबह जल्दी या शाम को पानी दें।',
                    'guide-irrigation-step-4': 'हर हफ्ते एमिटर और नोज़ल में रुकावट या रिसाव जाँचें।',
                    'guide-irrigation-tip': '💡 तय समय-सारणी से ज़्यादा भरोसेमंद है मिट्टी की जल्दी जाँच।',
                    'guide-organic-step-1': 'फसल अवशेष, गोबर और रसोई कचरे से खाद बनाएं।',
                    'guide-organic-step-2': 'मिट्टी स्वस्थ रखने के लिए हर मौसम में फसल बदलें।',
                    'guide-organic-step-3': 'रासायनिक छिड़काव की जगह नीम तेल और साथी-रोपण अपनाएं।',
                    'guide-organic-step-4': 'खेत पर्याप्त समय तक रसायन-मुक्त रहने पर प्रमाणीकरण के लिए आवेदन करें।',
                    'guide-organic-tip': '💡 असली खाद स्वस्थ मिट्टी है — पौधे के साथ मिट्टी को भी पोषण दें।',
                    'guide-insurance-step-1': 'सीज़न की नामांकन अंतिम तिथि से पहले नामांकन करें।',
                    'guide-insurance-step-2': 'बुवाई की तारीख और क्षेत्रफल का प्रमाण रखें।',
                    'guide-insurance-step-3': 'फसल नुकसान की सूचना दावा अवधि के भीतर बीमा कंपनी को दें।',
                    'guide-insurance-step-4': 'जवाब न मिलने पर स्थानीय कृषि कार्यालय से संपर्क करें।',
                    'guide-insurance-tip': '💡 बुवाई के तुरंत बाद खेत की फोटो लें — इससे दावा जल्दी होता है।',
                    'guide-cloud-step-1': 'किसी भरोसेमंद ई-कृषि या फार्म-डेटा पोर्टल पर खाता बनाएं।',
                    'guide-cloud-step-2': 'अपने खेत और फसल के रिकॉर्ड नियमित रूप से अपलोड करें।',
                    'guide-cloud-step-3': 'अपनी फसलों के लिए मौसम और बाज़ार-भाव अलर्ट चालू करें।',
                    'guide-cloud-step-4': 'ज़मीन और खरीद के दस्तावेज़ों की फोटो बैकअप रखें।',
                    'guide-cloud-tip': '💡 खोई हुई रसीद से बेहतर है सिंक किया हुआ रिकॉर्ड।',
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
                    'nav-messages': 'संदेश',
                    'nav-mypurchases': 'मेरी खरीदारी',
                    'sec-messages-title': 'खरीदारों के संदेश',
                    'sec-messages-p': 'खरीदारों ने आपके उत्पादों के बारे में जो नोट्स भेजे हैं।',
                    'messages-empty': 'अभी तक कोई संदेश नहीं है।',
                    'msg-about-prefix': 'विषय:',
                    'sec-mypurchases-title': 'मेरी खरीदारी',
                    'sec-mypurchases-p': 'आपके द्वारा खरीदे गए उत्पाद। समीक्षा दें या किसान को अपने ऑर्डर के बारे में संदेश भेजें।',
                    'purchases-empty': 'आपने अभी तक कुछ नहीं खरीदा है।',
                    'purchase-bought-from': 'खरीदा गया:',
                    'btn-leave-review': 'समीक्षा लिखें',
                    'btn-update-review': 'समीक्षा अपडेट करें',
                    'btn-message-farmer': 'किसान को संदेश भेजें',
                    'review-comment-placeholder': 'आपको यह उत्पाद कैसा लगा? (वैकल्पिक)',
                    'btn-submit-review': 'समीक्षा सबमिट करें',
                    'message-ask-placeholder': (name) => `${name} से अपने ऑर्डर के बारे में पूछें...`,
                    'btn-send-message': 'संदेश भेजें',
                    'toast-select-rating': 'कृपया पहले स्टार रेटिंग चुनें।',
                    'toast-reviews-unavailable': 'समीक्षाएँ अभी उपलब्ध नहीं हैं — कृपया थोड़ी देर में पुनः प्रयास करें।',
                    'toast-review-thanks': 'आपकी समीक्षा के लिए धन्यवाद!',
                    'toast-review-error': 'आपकी समीक्षा सबमिट नहीं हो सकी। कृपया पुनः प्रयास करें।',
                    'toast-write-message-first': 'कृपया पहले एक संदेश लिखें।',
                    'toast-messaging-unavailable': 'संदेश सेवा अभी उपलब्ध नहीं है — कृपया थोड़ी देर में पुनः प्रयास करें।',
                    'toast-message-sent': (name) => `${name} को संदेश भेज दिया गया।`,
                    'toast-message-error': 'आपका संदेश भेजा नहीं जा सका। कृपया पुनः प्रयास करें।',
                    'toast-success': 'संदेश सफलतापूर्वक भेज दिया गया! हम जल्द ही आपसे संपर्क करेंगे।',
                    'toast-error-fields': 'कृपया बाज़ार के सभी फ़ील्ड सही ढंग से भरें।',
                    'toast-error-image': 'बिक्री से पहले कृपया उत्पाद की फोटो जोड़ें (स्टोरेज या कैमरे से)।',
                    'toast-error-category': 'कृपया एक श्रेणी चुनें: सब्ज़ियाँ, फल, बीज, या उपकरण।',
                    'toast-error-search': 'कृपया खोज के लिए उत्पाद का नाम दर्ज करें।',
                    'alert-cart-add': (name) => `${name} कार्ट में जोड़ा गया!`,
                    'alert-pay-success': (amount) => `₹${amount} का भुगतान सफल रहा! आपकी खरीद के लिए धन्यवाद।`,
                    'alert-pay-processing': (amount) => `₹${amount} का भुगतान संसाधित हो रहा है...`,
                    'alert-search': (name) => `बाज़ार में "${name}" खोजा जा रहा है...`,
                    'alert-empty-cart': 'आपका कार्ट खाली है। भुगतान करने के लिए कुछ भी नहीं है।',
                    'listen-label': 'सुनें',
                    'steps-label': '✍️ अपनाए जाने वाले कदम:',
                    'toast-sold-out': (qty, name) => `${name} की केवल ${qty} इकाइयाँ उपलब्ध हैं।`,
                    'nav-about': 'हमारे बारे में',
                    'sec-about-title': 'AGRI दुनिया के बारे में',
                    'about-eyebrow': 'हमारी कहानी',
                    'about-headline': 'किसानों द्वारा उगाया गया। देखभाल के साथ पहुँचाया गया।',
                    'about-intro': 'किसान अच्छी फसल उगाने के लिए मेहनत करते हैं, लेकिन जब तक वह थाली तक पहुँचती है, उसकी अधिकांश कीमत उन लोगों के पास चली जाती है जिन्होंने कभी मिट्टी को छुआ तक नहीं। AGRI दुनिया इसी को बदलने के लिए बनी है — एक ऐसा मंच जहाँ किसान सीधे उन लोगों को बेचते हैं जो उनकी उपज खाते हैं, और जहाँ खेती अकेली जद्दोजहद न होकर एक साझा प्रयास बन जाती है।',
                    'about-what-title': 'हम क्या करते हैं',
                    'about-what-1-title': 'सीधी बिक्री',
                    'about-what-1-desc': 'किसान अपनी उपज सूचीबद्ध करते हैं और सीधे उपभोक्ताओं को बेचते हैं — बीच में किसी बिचौलिए का हिस्सा नहीं।',
                    'about-what-2-title': 'पहले से ऑर्डर करें',
                    'about-what-2-desc': 'उपभोक्ता डिलीवरी से लगभग 11–12 घंटे पहले ऑर्डर देते हैं (दूरी के अनुसार), ताकि किसान को पता हो कि वास्तव में क्या तोड़ना है।',
                    'about-what-3-title': 'व्यवस्थित संग्रहण',
                    'about-what-3-desc': 'हमारी नियुक्त टेम्पो और परिवहन टीम किसानों से सीधे थोक में उपज इकट्ठा करती है।',
                    'about-what-4-title': 'दोनों पक्षों के लिए बेहतर मूल्य',
                    'about-what-4-desc': 'अनावश्यक बिचौलियों को हटाने से किसानों को बेहतर मुनाफ़ा और उपभोक्ताओं को बेहतर कीमत मिलती है।',
                    'about-how-title': 'हम कैसे काम करते हैं',
                    'about-how-1-title': 'किसान फसल तोड़ता है',
                    'about-how-1-desc': 'ताज़ा उपज, असली ऑर्डर के अनुसार तोड़ी जाती है — अंदाज़े से नहीं।',
                    'about-how-2-title': 'AGRI दुनिया संग्रह करती है',
                    'about-how-2-desc': 'हमारी टेम्पो और परिवहन टीम किसानों से थोक में उपज लेती है।',
                    'about-how-3-title': 'छँटाई और वितरण',
                    'about-how-3-desc': 'हमारी टीम उपज को छाँटती है और डिलीवरी के लिए तैयार करती है।',
                    'about-how-4-title': 'उपभोक्ता तक पहुँचती है',
                    'about-how-4-desc': 'ताज़ा उपज उचित कीमत पर खरीदार तक पहुँचाई जाती है।',
                    'about-beyond-title': 'बाज़ार से आगे',
                    'about-beyond-intro': 'AGRI दुनिया केवल खरीदने-बेचने की जगह नहीं है। हम एक सहकारी-शैली का किसान समुदाय बनाने की दिशा में काम कर रहे हैं, जहाँ किसान अव्यवस्थित बाज़ार में अकेले प्रतिस्पर्धा करने के बजाय एक-दूसरे का साथ दें।',
                    'about-beyond-item-1': 'खेती के उपकरण खरीदें और बेचें',
                    'about-beyond-item-2': 'बीज और अन्य कृषि संसाधन खरीदें',
                    'about-beyond-item-3': 'आधुनिक खेती की तकनीकें सीखें',
                    'about-beyond-item-4': 'नई शुरू हुई सरकारी योजनाओं की जानकारी पाएँ',
                    'about-beyond-item-5': 'अधिक ज़िम्मेदार और टिकाऊ खेती अपनाएँ',
                    'about-beyond-item-6': 'अकेले नहीं, एक समुदाय के रूप में मिलकर काम करें',
                    'about-beyond-note': 'हम किसानों के साथ ऐसे समझौतों पर भी काम कर रहे हैं जो कृषि रसायनों के ज़िम्मेदार उपयोग और बेहतर खेती के तरीकों को बढ़ावा दें — स्वस्थ मिट्टी और स्वस्थ भोजन के लिए।',
                    'about-vision-title': 'हमारा उद्देश्य',
                    'about-vision-desc': 'हम चाहते हैं कि AGRI दुनिया सिर्फ़ एक ऐप न रहे — बल्कि एक ऐसा किसान समुदाय बने जहाँ उपज सीधे खेत से घर तक पहुँचे, और जहाँ किसानों के पास आत्मविश्वास से आगे बढ़ने के लिए ज़रूरी साधन, जानकारी और सहयोग हो।',
                    'about-cta-title': 'चाहे आप उगाते हों या खरीदते हों, यहाँ आपके लिए जगह है।',
                    'about-cta-btn': 'बाज़ार देखें',
                    'about-social-title': 'इंस्टाग्राम पर हमें फॉलो करें',
                    'about-social-desc': 'ताज़ी फसलें, किसानों की कहानियाँ, और AGRI दुनिया की नई जानकारी।'
                },
                                'ta': {
                    'header-title': 'அக்ரி துனியா',
                    'header-tagline': 'சந்தை, அறிவு மற்றும் அரசு திட்டங்களுக்கான டிஜிட்டல் அணுகலுடன் விவசாயிகளை மேம்படுத்துதல்',
                    'nav-market': 'சந்தை',
                    'nav-myproducts': 'எனது பொருட்கள்',
                    'nav-learning': 'கற்றல் மையம்',
                    'nav-videos': 'வீடியோக்கள்',
                    'nav-schemes': 'திட்டங்கள்',
                    'nav-contact': 'தொடர்பு',
                    'sec-market-title': 'டிஜிட்டல் சந்தை',
                    'sec-market-p': 'விவசாய பொருட்களை நேரடியாக வாங்கவும் விற்கவும். விவசாயிகள் தங்கள் பயிர்களை பட்டியலிடலாம், வாங்குபவர்கள் நேரடியாக வாங்கலாம், இது நியாயமான வர்த்தகத்தை உறுதி செய்யும்.',
                    'sec-myproducts-title': 'எனது பொருட்கள்',
                    'sec-myproducts-p': 'நீங்கள் விற்பனைக்கு பட்டியலிட்ட பொருட்களை நிர்வகிக்கவும் — வாங்குபவர்கள் இவற்றை சந்தையில் நேரடியாகக் காணலாம் மற்றும் வாங்கலாம்.',
                    'sell-title': 'உங்கள் பொருட்களை விற்கவும்',
                    'sell-button': 'விற்பனைக்கு பதிவிடவும்',
                    'sell-category-label': 'பொருள் வகை (அவசியம்)',
                    'category-option-default': '-- வகையைத் தேர்ந்தெடுக்கவும் --',
                    'category-option-vegetables': '🥦 காய்கறிகள்',
                    'category-option-fruits': '🍎 பழங்கள்',
                    'category-option-seeds': '🌱 விதைகள்',
                    'category-option-tools': '🛠️ கருவிகள்',
                    'sell-image-label': 'பொருளின் புகைப்படத்தைச் சேர்க்கவும் (அவசியம்) 📷',
                    'cart-title': 'உங்கள் கார்ட்',
                    'cart-empty': 'உங்கள் கார்ட் காலியாக உள்ளது.',
                    'sec-learning-title': 'கற்றல் மையம்',
                    'sec-learning-p': 'எங்கள் தளத்தின் மூலம் நவீன விவசாய நுட்பங்கள், உற்பத்தித்திறன் மேம்பாடு மற்றும் பயிர் மேலாண்மையை கற்றுக்கொள்ளுங்கள்.',
                    'course-1-title': 'நவீன பாசன நுட்பங்கள்',
                    'course-1-desc': 'சொட்டு நீர்ப்பாசனம் மற்றும் தெளிப்பான் முறைகள் மூலம் நீர் பயன்பாட்டை மேம்படுத்துங்கள். புத்திசாலித்தனமான நீர் மேலாண்மையைக் கற்றுக்கொள்ளுங்கள்.',
                    'course-2-title': 'இயற்கை விவசாயம்',
                    'course-2-desc': 'இயற்கையான, ரசாயனமில்லா சாகுபடி மற்றும் மண் வளம் சேர்க்கும் நுட்பங்களில் தேர்ச்சி பெறுங்கள்.',
                    'course-3-title': 'பயிர் காப்பீடு விழிப்புணர்வு',
                    'course-3-desc': 'உங்கள் அறுவடையை ஆபத்துகளிலிருந்து பாதுகாக்க கொள்கை விவரங்கள் மற்றும் கோரிக்கை செயல்முறையைப் புரிந்துகொள்ளுங்கள்.',
                    'course-4-title': 'கிளவுட் ஒருங்கிணைப்பு & இ-கற்றல்',
                    'course-4-desc': 'தரவு மேலாண்மை மற்றும் டிஜிட்டல் விவசாய வளங்களை அணுக கிளவுட் கருவிகளைப் பயன்படுத்துங்கள்.',
                    'guide-irrigation-step-1': 'நீர் பாய்ச்சும் முன் விரல் மூலம் மண் ஈரப்பதத்தை சரிபார்க்கவும்.',
                    'guide-irrigation-step-2': 'வரிசை பயிர்களுக்கு சொட்டு நீர்ப்பாசனம், திறந்த வயல்களுக்கு தெளிப்பான் பயன்படுத்தவும்.',
                    'guide-irrigation-step-3': 'ஆவியாதலைக் குறைக்க அதிகாலை அல்லது மாலையில் நீர் பாய்ச்சவும்.',
                    'guide-irrigation-step-4': 'அடைப்பு அல்லது கசிவுக்காக வாரந்தோறும் எமிட்டர்கள் மற்றும் நாசில்களை ஆய்வு செய்யவும்.',
                    'guide-irrigation-tip': '💡 நிலையான கால அட்டவணையை விட விரைவான மண் சோதனையே சிறந்தது.',
                    'guide-organic-step-1': 'பயிர் கழிவு, சாணம் மற்றும் சமையலறை கழிவுகளிலிருந்து உரம் தயாரிக்கவும்.',
                    'guide-organic-step-2': 'மண்ணை இயற்கையாக ஆரோக்கியமாக வைக்க ஒவ்வொரு பருவத்திலும் பயிர் சுழற்சி செய்யவும்.',
                    'guide-organic-step-3': 'ரசாயன தெளிப்புக்கு பதிலாக வேப்பெண்ணெய் மற்றும் துணைப் பயிர் நடவு முறையைப் பயன்படுத்தவும்.',
                    'guide-organic-step-4': 'வயல்கள் போதுமான காலம் ரசாயனமில்லாமல் இருந்தால் சான்றிதழுக்கு விண்ணப்பிக்கவும்.',
                    'guide-organic-tip': '💡 உண்மையான உரம் ஆரோக்கியமான மண்ணே — செடிக்கு மட்டுமல்ல, மண்ணுக்கும் உணவளியுங்கள்.',
                    'guide-insurance-step-1': 'பருவத்தின் பதிவு கடைசி தேதிக்கு முன் பதிவு செய்யவும்.',
                    'guide-insurance-step-2': 'விதைப்பு தேதி மற்றும் பரப்பளவின் ஆதாரத்தை பராமரிக்கவும்.',
                    'guide-insurance-step-3': 'பயிர் இழப்பை உரிமைகோரல் காலத்திற்குள் உங்கள் காப்பீட்டு நிறுவனத்திற்குத் தெரிவிக்கவும்.',
                    'guide-insurance-step-4': 'பதில் கிடைக்கவில்லை எனில் உங்கள் உள்ளூர் வேளாண் அலுவலகத்துடன் தொடர்பு கொள்ளவும்.',
                    'guide-insurance-tip': '💡 விதைத்த உடனேயே உங்கள் வயலின் புகைப்படம் எடுக்கவும் — இது பின்னர் கோரிக்கையை விரைவுபடுத்தும்.',
                    'guide-cloud-step-1': 'நம்பகமான இ-கிருஷி அல்லது பண்ணை-தரவு போர்ட்டலில் கணக்கு தொடங்கவும்.',
                    'guide-cloud-step-2': 'உங்கள் பண்ணை மற்றும் அறுவடை பதிவுகளை தொடர்ந்து பதிவேற்றவும்.',
                    'guide-cloud-step-3': 'உங்கள் பயிர்களுக்கான வானிலை மற்றும் சந்தை-விலை எச்சரிக்கைகளை இயக்கவும்.',
                    'guide-cloud-step-4': 'நில மற்றும் கொள்முதல் ஆவணங்களை புகைப்படங்களாக காப்புப் பிரதி எடுத்து வையுங்கள்.',
                    'guide-cloud-tip': '💡 தொலைந்த காகித ரசீதை விட ஒத்திசைவான பதிவே சிறந்தது.',
                    'ai-chat-title': '✨ அக்ரி-ஜெமினி: உடனடி பயிர் ஆலோசகர்',
                    'ai-desc': 'விவசாய நுட்பங்கள், சந்தை போக்குகள் அல்லது பூச்சி மேலாண்மை பற்றி எதையும் கேளுங்கள்!',
                    'sec-video-title': 'விவசாயிகளுக்கான வீடியோக்கள்',
                    'sec-video-p': 'பயிர் சாகுபடி, மண் ஆரோக்கியம் மற்றும் நவீன விவசாய முறைகள் பற்றிய இந்த பயனுள்ள வீடியோக்களைப் பாருங்கள்.',
                    'sec-scheme-title': 'விவசாயிகளுக்கான அரசு திட்டங்கள்',
                    'sec-scheme-p': 'விவசாயிகளுக்கு உதவும் வகையில் வடிவமைக்கப்பட்ட சில முக்கியமான அரசு திட்டங்கள் இங்கே உள்ளன. மேலும் அறிந்து விண்ணப்பிக்க இணைப்புகளைக் கிளிக் செய்யவும்:',
                    'scheme-1-desc': 'பிரதான் மந்திரி கிசான் சம்மான் நிதி (பிஎம்-கிசான்) – விவசாயிகளுக்கு ஆண்டுதோறும் ₹6,000 நேரடி வருமான உதவி.',
                    'scheme-2-desc': 'பிரதான் மந்திரி பசல் பீமா யோஜனா (பிஎம்எஃப்பிபிஒய்) – இயற்கை பேரிடர்களுக்கு எதிராக விவசாயிகளுக்கான பயிர் காப்பீடு.',
                    'scheme-3-desc': 'மண் ஆரோக்கிய அட்டை திட்டம் – விவசாயிகளுக்கு மண் ஆரோக்கிய அறிக்கைகள் மற்றும் பரிந்துரைகளை வழங்குகிறது.',
                    'scheme-4-desc': 'வேளாண் உள்கட்டமைப்பு நிதி (ஏஐஎஃப்) – வேளாண் உள்கட்டமைப்பு மேம்பாட்டிற்கான நிதி உதவி.',
                    'scheme-5-desc': 'தேசிய வேளாண் சந்தை (இ-நாம்) – விவசாயிகள் தங்கள் விளைபொருட்களை விற்க ஆன்லைன் வர்த்தக தளம்.',
                    'sec-contact-title': 'எங்களைத் தொடர்பு கொள்ளுங்கள்',
                    'contact-info-1': 'மின்னஞ்சல்: support@farmerplatform.in',
                    'contact-info-2': 'உதவி எண்: +91 7393953233',
                    'form-label-name': 'பெயர்',
                    'form-label-email': 'மின்னஞ்சல்',
                    'form-label-message': 'செய்தி',
                    'form-button-send': 'செய்தி அனுப்பவும்',
                    'footer-copyright': '© 2025 விவசாயிகளுக்கான டிஜிட்டல் சந்தை & கற்றல் தளம் | அனைத்து உரிமைகளும் பாதுகாக்கப்பட்டவை',
                    'footer-visits': 'மொத்த வருகைகள்: ',
                    'nav-messages': 'செய்திகள்',
                    'nav-mypurchases': 'எனது கொள்முதல்',
                    'sec-messages-title': 'வாங்குபவர்களிடமிருந்து செய்திகள்',
                    'sec-messages-p': 'உங்கள் பொருட்கள் குறித்து வாங்குபவர்கள் அனுப்பிய குறிப்புகள்.',
                    'messages-empty': 'இதுவரை செய்திகள் இல்லை.',
                    'msg-about-prefix': 'பற்றி',
                    'sec-mypurchases-title': 'எனது கொள்முதல்',
                    'sec-mypurchases-p': 'நீங்கள் வாங்கிய பொருட்கள். மதிப்பாய்வு எழுதவும் அல்லது உங்கள் ஆர்டர் பற்றி விவசாயிக்கு செய்தி அனுப்பவும்.',
                    'purchases-empty': 'நீங்கள் இதுவரை எதுவும் வாங்கவில்லை.',
                    'purchase-bought-from': 'இவரிடமிருந்து வாங்கப்பட்டது',
                    'btn-leave-review': 'மதிப்பாய்வு எழுதவும்',
                    'btn-update-review': 'மதிப்பாய்வை புதுப்பிக்கவும்',
                    'btn-message-farmer': 'விவசாயிக்கு செய்தி அனுப்பவும்',
                    'review-comment-placeholder': 'இந்த பொருள் குறித்து உங்கள் கருத்து என்ன? (விருப்பத்திற்குரியது)',
                    'btn-submit-review': 'மதிப்பாய்வைச் சமர்ப்பிக்கவும்',
                    'message-ask-placeholder': (name) => `${name} இடம் உங்கள் ஆர்டர் பற்றி கேளுங்கள்...`,
                    'btn-send-message': 'செய்தி அனுப்பவும்',
                    'toast-select-rating': 'முதலில் ஒரு நட்சத்திர மதிப்பீட்டைத் தேர்ந்தெடுக்கவும்.',
                    'toast-reviews-unavailable': 'மதிப்பாய்வுகள் தற்போது கிடைக்கவில்லை — சிறிது நேரத்தில் மீண்டும் முயற்சிக்கவும்.',
                    'toast-review-thanks': 'உங்கள் மதிப்பாய்விற்கு நன்றி!',
                    'toast-review-error': 'உங்கள் மதிப்பாய்வைச் சமர்ப்பிக்க முடியவில்லை. மீண்டும் முயற்சிக்கவும்.',
                    'toast-write-message-first': 'முதலில் ஒரு செய்தியை எழுதவும்.',
                    'toast-messaging-unavailable': 'செய்தி அனுப்பும் சேவை தற்போது கிடைக்கவில்லை — சிறிது நேரத்தில் மீண்டும் முயற்சிக்கவும்.',
                    'toast-message-sent': (name) => `${name} க்கு செய்தி அனுப்பப்பட்டது.`,
                    'toast-message-error': 'உங்கள் செய்தியை அனுப்ப முடியவில்லை. மீண்டும் முயற்சிக்கவும்.',
                    'toast-success': 'செய்தி வெற்றிகரமாக அனுப்பப்பட்டது! நாங்கள் விரைவில் உங்களைத் தொடர்பு கொள்வோம்.',
                    'toast-error-fields': 'சந்தை புலங்கள் அனைத்தையும் சரியாக நிரப்பவும்.',
                    'toast-error-image': 'விற்பனைக்கு முன் பொருளின் புகைப்படத்தைச் சேர்க்கவும் (சேமிப்பகம் அல்லது கேமராவிலிருந்து).',
                    'toast-error-category': 'ஒரு வகையைத் தேர்ந்தெடுக்கவும்: காய்கறிகள், பழங்கள், விதைகள் அல்லது கருவிகள்.',
                    'toast-error-search': 'தேட ஒரு பொருளின் பெயரை உள்ளிடவும்.',
                    'alert-cart-add': (name) => `${name} கார்ட்டில் சேர்க்கப்பட்டது!`,
                    'alert-pay-success': (amount) => `₹${amount} கட்டணம் வெற்றிகரமாக செலுத்தப்பட்டது! உங்கள் கொள்முதலுக்கு நன்றி.`,
                    'alert-pay-processing': (amount) => `₹${amount} கட்டணம் செயலாக்கப்படுகிறது...`,
                    'alert-search': (name) => `"${name}" சந்தையில் தேடப்படுகிறது...`,
                    'alert-empty-cart': 'உங்கள் கார்ட் காலியாக உள்ளது. செலுத்த எதுவும் இல்லை.',
                    'listen-label': 'கேளுங்கள்',
                    'steps-label': '✍️ பின்பற்ற வேண்டிய படிகள்:',
                    'toast-sold-out': (qty, name) => `${name} இன் ${qty} அலகுகள் மட்டுமே உள்ளன.`,
                    'nav-about': 'எங்களைப் பற்றி',
                    'sec-about-title': 'அக்ரி துனியா பற்றி',
                    'about-eyebrow': 'எங்கள் கதை',
                    'about-headline': 'விவசாயிகளால் விளைவிக்கப்பட்டது. அக்கறையுடன் வழங்கப்பட்டது.',
                    'about-intro': 'விவசாயிகள் நல்ல உணவை விளைவிக்க கடுமையாக உழைக்கிறார்கள், ஆனால் அது தட்டை சென்றடையும் போது, அதன் மதிப்பில் பெரும் பங்கு மண்ணைத் தொடாத நபர்களுக்குச் சென்றுவிடுகிறது. அக்ரி துனியா இதை மாற்ற உருவாக்கப்பட்டது — விவசாயிகள் தங்கள் விளைபொருளை உண்பவர்களுக்கு நேரடியாக விற்கும் ஒரு தளம், விவசாயம் தனிப்போராட்டமாக இல்லாமல் ஒரு பகிரப்பட்ட முயற்சியாக உணரும் இடம்.',
                    'about-what-title': 'நாங்கள் என்ன செய்கிறோம்',
                    'about-what-1-title': 'நேரடி விற்பனை',
                    'about-what-1-desc': 'விவசாயிகள் தங்கள் விளைபொருளை பட்டியலிட்டு நுகர்வோருக்கு நேரடியாக விற்கிறார்கள் — வழியில் எந்த இடைத்தரகரும் பங்கு எடுப்பதில்லை.',
                    'about-what-2-title': 'முன்கூட்டியே ஆர்டர் செய்யுங்கள்',
                    'about-what-2-desc': 'தூரத்தைப் பொறுத்து, டெலிவரிக்கு சுமார் 11–12 மணி நேரத்திற்கு முன் நுகர்வோர் ஆர்டர் செய்கிறார்கள், இதனால் விவசாயிகளுக்கு சரியாக என்ன அறுவடை செய்ய வேண்டும் என்று தெரியும்.',
                    'about-what-3-title': 'ஒழுங்கமைக்கப்பட்ட சேகரிப்பு',
                    'about-what-3-desc': 'எங்கள் நியமிக்கப்பட்ட டெம்போ மற்றும் போக்குவரத்து குழு விவசாயிகளிடமிருந்து நேரடியாக மொத்தமாக விளைபொருளை சேகரிக்கிறது.',
                    'about-what-4-title': 'இரு தரப்பினருக்கும் நியாயமான மதிப்பு',
                    'about-what-4-desc': 'தேவையற்ற இடைத்தரகர்களை நீக்குவது விவசாயிகளுக்கு சிறந்த லாபத்தையும் நுகர்வோருக்கு சிறந்த விலையையும் தருகிறது.',
                    'about-how-title': 'நாங்கள் எப்படி வேலை செய்கிறோம்',
                    'about-how-1-title': 'விவசாயி அறுவடை செய்கிறார்',
                    'about-how-1-desc': 'உண்மையான ஆர்டர்களுக்கு ஏற்ப அறுவடை செய்யப்பட்ட புதிய விளைபொருள் — யூகத்தின் அடிப்படையில் அல்ல.',
                    'about-how-2-title': 'அக்ரி துனியா சேகரிக்கிறது',
                    'about-how-2-desc': 'எங்கள் டெம்போ மற்றும் போக்குவரத்து குழு விவசாயிகளிடமிருந்து மொத்தமாக விளைபொருளை எடுக்கிறது.',
                    'about-how-3-title': 'வரிசைப்படுத்துதல் & விநியோகம்',
                    'about-how-3-desc': 'எங்கள் குழு விளைபொருளை வரிசைப்படுத்தி டெலிவரிக்குத் தயார் செய்கிறது.',
                    'about-how-4-title': 'நுகர்வோரை சென்றடைகிறது',
                    'about-how-4-desc': 'நியாயமான விலையில் புதிய விளைபொருள் வாங்குபவரிடம் வழங்கப்படுகிறது.',
                    'about-beyond-title': 'சந்தையை மீறி',
                    'about-beyond-intro': 'அக்ரி துனியா வெறும் வாங்கவும் விற்கவும் மட்டுமான இடமல்ல. ஒழுங்கமைக்கப்படாத சந்தையில் தனித்தனியாக போட்டியிடுவதற்குப் பதிலாக, விவசாயிகள் ஒருவருக்கொருவர் ஆதரவளிக்கும் ஒரு கூட்டுறவு-பாணி விவசாயி சமூகத்தை நோக்கி நாங்கள் பணியாற்றி வருகிறோம்.',
                    'about-beyond-item-1': 'விவசாய உபகரணங்களை வாங்கவும் விற்கவும்',
                    'about-beyond-item-2': 'விதைகள் மற்றும் பிற வேளாண் வளங்களை வாங்குங்கள்',
                    'about-beyond-item-3': 'நவீன விவசாய நுட்பங்களைக் கற்றுக்கொள்ளுங்கள்',
                    'about-beyond-item-4': 'புதிதாக அறிமுகப்படுத்தப்பட்ட அரசு திட்டங்கள் குறித்து புதுப்பித்த நிலையில் இருங்கள்',
                    'about-beyond-item-5': 'மேலும் பொறுப்பான, நிலையான விவசாய முறைகளைப் பின்பற்றுங்கள்',
                    'about-beyond-item-6': 'தனித்தனியாக அல்ல, ஒரு சமூகமாக இணைந்து பணியாற்றுங்கள்',
                    'about-beyond-note': 'ஆரோக்கியமான மண் மற்றும் ஆரோக்கியமான உணவுக்காக, வேளாண் ரசாயனங்களை பொறுப்புடன் பயன்படுத்துவதையும் சிறந்த விவசாய முறைகளையும் ஊக்குவிக்கும் ஒப்பந்தங்களில் விவசாயிகளுடன் நாங்கள் இணைந்து பணியாற்றி வருகிறோம்.',
                    'about-vision-title': 'எங்கள் நோக்கம்',
                    'about-vision-desc': 'அக்ரி துனியா ஒரு செயலியை விட மேலானதாக இருக்க வேண்டும் என நாங்கள் விரும்புகிறோம் — வயலிலிருந்து குடும்பத்திற்கு நேரடியாக விளைபொருள் செல்லும், விவசாயிகள் நம்பிக்கையுடன் வளர தேவையான கருவிகள், அறிவு மற்றும் ஆதரவு கிடைக்கும் ஒரு விவசாயி சமூகம்.',
                    'about-cta-title': 'நீங்கள் விளைவித்தாலும் சரி வாங்கினாலும் சரி, இங்கு உங்களுக்கு ஒரு இடம் உண்டு.',
                    'about-cta-btn': 'சந்தையை ஆராயுங்கள்',
                    'about-social-title': 'இன்ஸ்டாகிராமில் எங்களைப் பின்தொடருங்கள்',
                    'about-social-desc': 'புதிய அறுவடைகள், விவசாயிகளின் கதைகள், மற்றும் அக்ரி துனியாவில் புதியவை.',
                },
                'te': {
                    'header-title': 'అగ్రి దునియా',
                    'header-tagline': 'మార్కెట్లు, జ్ఞానం మరియు ప్రభుత్వ పథకాలకు డిజిటల్ యాక్సెస్‌తో రైతులను శక్తివంతం చేయడం',
                    'nav-market': 'మార్కెట్‌ప్లేస్',
                    'nav-myproducts': 'నా ఉత్పత్తులు',
                    'nav-learning': 'లెర్నింగ్ హబ్',
                    'nav-videos': 'వీడియోలు',
                    'nav-schemes': 'పథకాలు',
                    'nav-contact': 'సంప్రదించండి',
                    'sec-market-title': 'డిజిటల్ మార్కెట్‌ప్లేస్',
                    'sec-market-p': 'వ్యవసాయ ఉత్పత్తులను నేరుగా కొనుగోలు చేయండి మరియు అమ్మండి. రైతులు తమ పంటలను జాబితా చేయవచ్చు, కొనుగోలుదారులు నేరుగా కొనుగోలు చేయవచ్చు, ఇది న్యాయమైన వాణిజ్యాన్ని నిర్ధారిస్తుంది.',
                    'sec-myproducts-title': 'నా ఉత్పత్తులు',
                    'sec-myproducts-p': 'మీరు అమ్మకానికి జాబితా చేసిన ఉత్పత్తులను నిర్వహించండి — కొనుగోలుదారులు వీటిని మార్కెట్‌ప్లేస్‌లో నేరుగా చూసి కొనుగోలు చేయవచ్చు.',
                    'sell-title': 'మీ ఉత్పత్తులను అమ్మండి',
                    'sell-button': 'అమ్మకానికి పోస్ట్ చేయండి',
                    'sell-category-label': 'ఉత్పత్తి వర్గం (అవసరం)',
                    'category-option-default': '-- వర్గాన్ని ఎంచుకోండి --',
                    'category-option-vegetables': '🥦 కూరగాయలు',
                    'category-option-fruits': '🍎 పండ్లు',
                    'category-option-seeds': '🌱 విత్తనాలు',
                    'category-option-tools': '🛠️ పనిముట్లు',
                    'sell-image-label': 'ఉత్పత్తి ఫోటోను జోడించండి (అవసరం) 📷',
                    'cart-title': 'మీ కార్ట్',
                    'cart-empty': 'మీ కార్ట్ ఖాళీగా ఉంది.',
                    'sec-learning-title': 'లెర్నింగ్ హబ్',
                    'sec-learning-p': 'మా ప్లాట్‌ఫారమ్ ద్వారా ఆధునిక వ్యవసాయ పద్ధతులు, ఉత్పాదకత మెరుగుదల మరియు పంట నిర్వహణను నేర్చుకోండి.',
                    'course-1-title': 'ఆధునిక నీటిపారుదల పద్ధతులు',
                    'course-1-desc': 'డ్రిప్ మరియు స్ప్రింక్లర్ వ్యవస్థలతో నీటి వినియోగాన్ని మెరుగుపరచండి. స్మార్ట్ నీటి నిర్వహణను నేర్చుకోండి.',
                    'course-2-title': 'సేంద్రియ వ్యవసాయం',
                    'course-2-desc': 'సహజమైన, రసాయనరహిత సాగు మరియు నేల సుసంపన్నత పద్ధతులలో నైపుణ్యం సాధించండి.',
                    'course-3-title': 'పంట బీమా అవగాహన',
                    'course-3-desc': 'మీ పంటను నష్టాల నుండి రక్షించుకోవడానికి పాలసీ వివరాలు మరియు క్లెయిమ్ ప్రక్రియను అర్థం చేసుకోండి.',
                    'course-4-title': 'క్లౌడ్ ఇంటిగ్రేషన్ & ఇ-లెర్నింగ్',
                    'course-4-desc': 'డేటా నిర్వహణ మరియు డిజిటల్ వ్యవసాయ వనరులను యాక్సెస్ చేయడానికి క్లౌడ్ సాధనాలను ఉపయోగించండి.',
                    'guide-irrigation-step-1': 'నీరు పెట్టే ముందు వేలితో నేల తేమను తనిఖీ చేయండి.',
                    'guide-irrigation-step-2': 'వరుస పంటలకు డ్రిప్ లైన్లు, బహిరంగ పొలాలకు స్ప్రింక్లర్లు వాడండి.',
                    'guide-irrigation-step-3': 'బాష్పీభవన నష్టాన్ని తగ్గించడానికి తెల్లవారుజామున లేదా సాయంత్రం నీరు పెట్టండి.',
                    'guide-irrigation-step-4': 'ప్రతి వారం ఎమిటర్లు మరియు నాజిల్‌లలో అడ్డంకులు లేదా లీకేజీల కోసం తనిఖీ చేయండి.',
                    'guide-irrigation-tip': '💡 స్థిర క్యాలెండర్ ప్రకారం నీరు పెట్టడం కంటే త్వరిత నేల తనిఖీ మేలు.',
                    'guide-organic-step-1': 'పంట వ్యర్థాలు, పేడ మరియు వంటగది వ్యర్థాల నుండి కంపోస్ట్ తయారు చేయండి.',
                    'guide-organic-step-2': 'నేలను సహజంగా ఆరోగ్యంగా ఉంచడానికి ప్రతి సీజన్‌లో పంటలను మార్చండి.',
                    'guide-organic-step-3': 'రసాయన స్ప్రేలకు బదులుగా వేప నూనె మరియు సహచర పంటలను ఉపయోగించండి.',
                    'guide-organic-step-4': 'పొలాలు తగినంత కాలం రసాయనరహితంగా ఉన్న తర్వాత ధృవీకరణ కోసం దరఖాస్తు చేయండి.',
                    'guide-organic-tip': '💡 నిజమైన ఎరువు ఆరోగ్యకరమైన నేలే — మొక్కకే కాదు, నేలకు కూడా పోషణ ఇవ్వండి.',
                    'guide-insurance-step-1': 'సీజన్ నమోదు గడువుకు ముందే నమోదు చేసుకోండి.',
                    'guide-insurance-step-2': 'విత్తిన తేదీ మరియు విస్తీర్ణం యొక్క ఆధారాలను భద్రపరచుకోండి.',
                    'guide-insurance-step-3': 'క్లెయిమ్ వ్యవధిలో మీ బీమా సంస్థకు పంట నష్టాన్ని నివేదించండి.',
                    'guide-insurance-step-4': 'స్పందన రాకపోతే మీ స్థానిక వ్యవసాయ కార్యాలయాన్ని సంప్రదించండి.',
                    'guide-insurance-tip': '💡 విత్తిన వెంటనే మీ పొలం ఫోటో తీయండి — ఇది క్లెయిమ్‌లను వేగవంతం చేస్తుంది.',
                    'guide-cloud-step-1': 'నమ్మకమైన ఇ-కృషి లేదా ఫార్మ్-డేటా పోర్టల్‌లో ఖాతా సృష్టించండి.',
                    'guide-cloud-step-2': 'మీ పొలం మరియు పంట రికార్డులను క్రమం తప్పకుండా అప్‌లోడ్ చేయండి.',
                    'guide-cloud-step-3': 'మీ పంటల కోసం వాతావరణం మరియు మార్కెట్-ధర హెచ్చరికలను ఆన్ చేయండి.',
                    'guide-cloud-step-4': 'భూమి మరియు కొనుగోలు పత్రాలను ఫోటోలుగా బ్యాకప్ చేసుకోండి.',
                    'guide-cloud-tip': '💡 పోగొట్టుకున్న కాగితం రసీదు కంటే సింక్ చేసిన రికార్డు మేలు.',
                    'ai-chat-title': '✨ అగ్రి-జెమిని: తక్షణ పంట సలహాదారు',
                    'ai-desc': 'వ్యవసాయ పద్ధతులు, మార్కెట్ ధోరణులు లేదా చీడపీడల నిర్వహణ గురించి ఏదైనా అడగండి!',
                    'sec-video-title': 'రైతుల కోసం వీడియోలు',
                    'sec-video-p': 'పంట సాగు, నేల ఆరోగ్యం మరియు ఆధునిక వ్యవసాయ పద్ధతులపై ఈ ఉపయోగకరమైన వీడియోలను చూడండి.',
                    'sec-scheme-title': 'రైతుల కోసం ప్రభుత్వ పథకాలు',
                    'sec-scheme-p': 'రైతులకు మద్దతుగా రూపొందించిన కొన్ని ముఖ్యమైన ప్రభుత్వ పథకాలు ఇక్కడ ఉన్నాయి. మరింత తెలుసుకోవడానికి మరియు దరఖాస్తు చేయడానికి లింక్‌లపై క్లిక్ చేయండి:',
                    'scheme-1-desc': 'ప్రధాన మంత్రి కిసాన్ సమ్మాన్ నిధి (పిఎం-కిసాన్) – రైతులకు ఏటా ₹6,000 ప్రత్యక్ష ఆదాయ మద్దతు.',
                    'scheme-2-desc': 'ప్రధాన మంత్రి ఫసల్ బీమా యోజన (పిఎంఎఫ్‌బివై) – ప్రకృతి వైపరీత్యాలకు వ్యతిరేకంగా రైతులకు పంట బీమా.',
                    'scheme-3-desc': 'సాయిల్ హెల్త్ కార్డ్ పథకం – రైతులకు నేల ఆరోగ్య నివేదికలు మరియు సిఫార్సులను అందిస్తుంది.',
                    'scheme-4-desc': 'వ్యవసాయ మౌలిక సదుపాయాల నిధి (ఏఐఎఫ్) – వ్యవసాయ మౌలిక సదుపాయాల అభివృద్ధికి ఆర్థిక సహాయం.',
                    'scheme-5-desc': 'జాతీయ వ్యవసాయ మార్కెట్ (ఇ-నామ్) – రైతులు తమ ఉత్పత్తులను అమ్ముకోవడానికి ఆన్‌లైన్ ట్రేడింగ్ ప్లాట్‌ఫారమ్.',
                    'sec-contact-title': 'మమ్మల్ని సంప్రదించండి',
                    'contact-info-1': 'ఇమెయిల్: support@farmerplatform.in',
                    'contact-info-2': 'హెల్ప్‌లైన్: +91 7393953233',
                    'form-label-name': 'పేరు',
                    'form-label-email': 'ఇమెయిల్',
                    'form-label-message': 'సందేశం',
                    'form-button-send': 'సందేశం పంపండి',
                    'footer-copyright': '© 2025 రైతుల కోసం డిజిటల్ మార్కెట్‌ప్లేస్ & లెర్నింగ్ ప్లాట్‌ఫారమ్ | సర్వహక్కులు రిజర్వ్ చేయబడ్డాయి',
                    'footer-visits': 'మొత్తం సందర్శనలు: ',
                    'nav-messages': 'సందేశాలు',
                    'nav-mypurchases': 'నా కొనుగోళ్లు',
                    'sec-messages-title': 'కొనుగోలుదారుల నుండి సందేశాలు',
                    'sec-messages-p': 'మీ ఉత్పత్తుల గురించి కొనుగోలుదారులు పంపిన గమనికలు.',
                    'messages-empty': 'ఇంకా సందేశాలు లేవు.',
                    'msg-about-prefix': 'గురించి',
                    'sec-mypurchases-title': 'నా కొనుగోళ్లు',
                    'sec-mypurchases-p': 'మీరు కొనుగోలు చేసిన ఉత్పత్తులు. సమీక్ష ఇవ్వండి లేదా మీ ఆర్డర్ గురించి రైతుకు సందేశం పంపండి.',
                    'purchases-empty': 'మీరు ఇంకా ఏమీ కొనుగోలు చేయలేదు.',
                    'purchase-bought-from': 'నుండి కొనుగోలు చేయబడింది',
                    'btn-leave-review': 'సమీక్ష ఇవ్వండి',
                    'btn-update-review': 'సమీక్షను నవీకరించండి',
                    'btn-message-farmer': 'రైతుకు సందేశం పంపండి',
                    'review-comment-placeholder': 'ఈ ఉత్పత్తి గురించి మీ అభిప్రాయం ఏమిటి? (ఐచ్ఛికం)',
                    'btn-submit-review': 'సమీక్షను సమర్పించండి',
                    'message-ask-placeholder': (name) => `మీ ఆర్డర్ గురించి ${name} ను అడగండి...`,
                    'btn-send-message': 'సందేశం పంపండి',
                    'toast-select-rating': 'దయచేసి ముందుగా స్టార్ రేటింగ్‌ను ఎంచుకోండి.',
                    'toast-reviews-unavailable': 'సమీక్షలు ప్రస్తుతం అందుబాటులో లేవు — దయచేసి కొద్దిసేపట్లో మళ్లీ ప్రయత్నించండి.',
                    'toast-review-thanks': 'మీ సమీక్షకు ధన్యవాదాలు!',
                    'toast-review-error': 'మీ సమీక్షను సమర్పించలేకపోయాము. దయచేసి మళ్లీ ప్రయత్నించండి.',
                    'toast-write-message-first': 'దయచేసి ముందుగా ఒక సందేశం రాయండి.',
                    'toast-messaging-unavailable': 'సందేశ సేవ ప్రస్తుతం అందుబాటులో లేదు — దయచేసి కొద్దిసేపట్లో మళ్లీ ప్రయత్నించండి.',
                    'toast-message-sent': (name) => `${name} కు సందేశం పంపబడింది.`,
                    'toast-message-error': 'మీ సందేశాన్ని పంపలేకపోయాము. దయచేసి మళ్లీ ప్రయత్నించండి.',
                    'toast-success': 'సందేశం విజయవంతంగా పంపబడింది! మేము త్వరలో మిమ్మల్ని సంప్రదిస్తాము.',
                    'toast-error-fields': 'దయచేసి మార్కెట్‌ప్లేస్ ఫీల్డ్‌లన్నింటినీ సరిగ్గా పూరించండి.',
                    'toast-error-image': 'అమ్మకానికి ముందు ఉత్పత్తి ఫోటోను జోడించండి (స్టోరేజ్ లేదా కెమెరా నుండి).',
                    'toast-error-category': 'దయచేసి ఒక వర్గాన్ని ఎంచుకోండి: కూరగాయలు, పండ్లు, విత్తనాలు లేదా పనిముట్లు.',
                    'toast-error-search': 'శోధించడానికి ఉత్పత్తి పేరును నమోదు చేయండి.',
                    'alert-cart-add': (name) => `${name} కార్ట్‌కు జోడించబడింది!`,
                    'alert-pay-success': (amount) => `₹${amount} చెల్లింపు విజయవంతమైంది! మీ కొనుగోలుకు ధన్యవాదాలు.`,
                    'alert-pay-processing': (amount) => `₹${amount} చెల్లింపు ప్రాసెస్ అవుతోంది...`,
                    'alert-search': (name) => `మార్కెట్‌ప్లేస్‌లో "${name}" కోసం శోధిస్తోంది...`,
                    'alert-empty-cart': 'మీ కార్ట్ ఖాళీగా ఉంది. చెల్లించడానికి ఏమీ లేదు.',
                    'listen-label': 'వినండి',
                    'steps-label': '✍️ అనుసరించవలసిన దశలు:',
                    'toast-sold-out': (qty, name) => `${name} యొక్క ${qty} యూనిట్లు మాత్రమే అందుబాటులో ఉన్నాయి.`,
                    'nav-about': 'మా గురించి',
                    'sec-about-title': 'అగ్రి దునియా గురించి',
                    'about-eyebrow': 'మా కథ',
                    'about-headline': 'రైతులచే పండించబడింది. శ్రద్ధతో అందించబడింది.',
                    'about-intro': 'రైతులు మంచి ఆహారాన్ని పండించడానికి కష్టపడతారు, కానీ అది కంచానికి చేరేసరికి, దాని విలువలో ఎక్కువ భాగం మట్టిని ఎప్పుడూ తాకని వారికే వెళ్తుంది. దీన్ని మార్చడానికే అగ్రి దునియా ఉంది — రైతులు తాము పండించిన దాన్ని తినేవారికి నేరుగా అమ్మే వేదిక, ఇక్కడ వ్యవసాయం ఒంటరి పోరాటంగా కాకుండా ఒక భాగస్వామ్య ప్రయత్నంగా అనిపిస్తుంది.',
                    'about-what-title': 'మేము ఏమి చేస్తాము',
                    'about-what-1-title': 'ప్రత్యక్ష విక్రయం',
                    'about-what-1-desc': 'రైతులు తమ ఉత్పత్తులను జాబితా చేసి వినియోగదారులకు నేరుగా అమ్ముతారు — మధ్యలో ఏ దళారీ వాటా తీసుకోరు.',
                    'about-what-2-title': 'ముందుగానే ఆర్డర్ చేయండి',
                    'about-what-2-desc': 'దూరాన్ని బట్టి, డెలివరీకి సుమారు 11–12 గంటల ముందు వినియోగదారులు ఆర్డర్లు పెడతారు, తద్వారా రైతులకు సరిగ్గా ఏమి కోయాలో తెలుస్తుంది.',
                    'about-what-3-title': 'వ్యవస్థీకృత సేకరణ',
                    'about-what-3-desc': 'మా నియమిత టెంపో మరియు రవాణా బృందం రైతుల నుండి నేరుగా బల్క్‌గా ఉత్పత్తులను సేకరిస్తుంది.',
                    'about-what-4-title': 'రెండు వైపులా న్యాయమైన విలువ',
                    'about-what-4-desc': 'అనవసరమైన మధ్యవర్తులను తొలగించడం వల్ల రైతులకు మెరుగైన లాభాలు, వినియోగదారులకు మెరుగైన ధరలు లభిస్తాయి.',
                    'about-how-title': 'మేము ఎలా పనిచేస్తాము',
                    'about-how-1-title': 'రైతు పంట కోస్తారు',
                    'about-how-1-desc': 'ఊహాజనితంగా కాకుండా, నిజమైన ఆర్డర్లకు అనుగుణంగా కోసిన తాజా ఉత్పత్తులు.',
                    'about-how-2-title': 'అగ్రి దునియా సేకరిస్తుంది',
                    'about-how-2-desc': 'మా టెంపో మరియు రవాణా బృందం రైతుల నుండి బల్క్‌గా ఉత్పత్తులను తీసుకుంటుంది.',
                    'about-how-3-title': 'వర్గీకరణ & పంపిణీ',
                    'about-how-3-desc': 'మా బృందం ఉత్పత్తులను వర్గీకరించి డెలివరీకి సిద్ధం చేస్తుంది.',
                    'about-how-4-title': 'వినియోగదారుని చేరుకుంటుంది',
                    'about-how-4-desc': 'న్యాయమైన ధరకు తాజా ఉత్పత్తులు కొనుగోలుదారుకు అందించబడతాయి.',
                    'about-beyond-title': 'మార్కెట్‌ప్లేస్‌కు మించి',
                    'about-beyond-intro': 'అగ్రి దునియా కేవలం కొనుగోలు మరియు అమ్మకం చేసే స్థలం మాత్రమే కాదు. అస్తవ్యస్తమైన మార్కెట్‌లో ఒంటరిగా పోటీపడకుండా, రైతులు ఒకరికొకరు మద్దతు ఇచ్చుకునే సహకార తరహా రైతు సమాజం వైపు మేము పనిచేస్తున్నాము.',
                    'about-beyond-item-1': 'వ్యవసాయ పరికరాలను కొనుగోలు చేయండి మరియు అమ్మండి',
                    'about-beyond-item-2': 'విత్తనాలు మరియు ఇతర వ్యవసాయ వనరులను కొనుగోలు చేయండి',
                    'about-beyond-item-3': 'ఆధునిక వ్యవసాయ పద్ధతులను నేర్చుకోండి',
                    'about-beyond-item-4': 'కొత్తగా ప్రారంభించిన ప్రభుత్వ పథకాల గురించి తాజాగా ఉండండి',
                    'about-beyond-item-5': 'మరింత బాధ్యతాయుతమైన, స్థిరమైన వ్యవసాయ పద్ధతులను అనుసరించండి',
                    'about-beyond-item-6': 'ఒంటరిగా కాకుండా, ఒక సమాజంగా కలిసి పనిచేయండి',
                    'about-beyond-note': 'ఆరోగ్యకరమైన నేల మరియు ఆరోగ్యకరమైన ఆహారం కోసం, వ్యవసాయ రసాయనాల బాధ్యతాయుత వినియోగాన్ని మరియు మెరుగైన వ్యవసాయ పద్ధతులను ప్రోత్సహించే ఒప్పందాలపై మేము రైతులతో కలిసి పనిచేస్తున్నాము.',
                    'about-vision-title': 'మా దృష్టి',
                    'about-vision-desc': 'అగ్రి దునియా కేవలం యాప్‌గా కాకుండా — పొలం నుండి కుటుంబానికి నేరుగా ఉత్పత్తులు చేరే, రైతులు నమ్మకంతో ఎదగడానికి అవసరమైన సాధనాలు, జ్ఞానం మరియు మద్దతు లభించే ఒక వ్యవసాయ సమాజంగా ఉండాలని మేము కోరుకుంటున్నాము.',
                    'about-cta-title': 'మీరు పండించినా, కొనుగోలు చేసినా, ఇక్కడ మీకు ఒక స్థానం ఉంది.',
                    'about-cta-btn': 'మార్కెట్‌ప్లేస్‌ను అన్వేషించండి',
                    'about-social-title': 'ఇన్‌స్టాగ్రామ్‌లో మమ్మల్ని ఫాలో అవ్వండి',
                    'about-social-desc': 'తాజా పంటలు, రైతుల కథలు, మరియు అగ్రి దునియాలో కొత్తవి.',
                },
                'bn': {
                    'header-title': 'এগ্রি দুনিয়া',
                    'header-tagline': 'বাজার, জ্ঞান ও সরকারি প্রকল্পে ডিজিটাল প্রবেশাধিকার দিয়ে কৃষকদের ক্ষমতায়ন',
                    'nav-market': 'বাজার',
                    'nav-myproducts': 'আমার পণ্য',
                    'nav-learning': 'লার্নিং হাব',
                    'nav-videos': 'ভিডিও',
                    'nav-schemes': 'প্রকল্পসমূহ',
                    'nav-contact': 'যোগাযোগ',
                    'sec-market-title': 'ডিজিটাল বাজার',
                    'sec-market-p': 'কৃষি পণ্য সরাসরি কিনুন এবং বিক্রি করুন। কৃষকরা তাদের ফসল তালিকাভুক্ত করতে পারেন, এবং ক্রেতারা সরাসরি কিনতে পারেন, যা ন্যায্য বাণিজ্য নিশ্চিত করে।',
                    'sec-myproducts-title': 'আমার পণ্য',
                    'sec-myproducts-p': 'আপনি বিক্রির জন্য তালিকাভুক্ত করা পণ্যগুলি পরিচালনা করুন — ক্রেতারা এগুলি সরাসরি বাজার থেকে দেখতে এবং কিনতে পারেন।',
                    'sell-title': 'আপনার পণ্য বিক্রি করুন',
                    'sell-button': 'বিক্রির জন্য পোস্ট করুন',
                    'sell-category-label': 'পণ্যের বিভাগ (প্রয়োজনীয়)',
                    'category-option-default': '-- বিভাগ নির্বাচন করুন --',
                    'category-option-vegetables': '🥦 সবজি',
                    'category-option-fruits': '🍎 ফল',
                    'category-option-seeds': '🌱 বীজ',
                    'category-option-tools': '🛠️ যন্ত্রপাতি',
                    'sell-image-label': 'পণ্যের একটি ছবি যোগ করুন (প্রয়োজনীয়) 📷',
                    'cart-title': 'আপনার কার্ট',
                    'cart-empty': 'আপনার কার্ট খালি।',
                    'sec-learning-title': 'লার্নিং হাব',
                    'sec-learning-p': 'আমাদের প্ল্যাটফর্মের মাধ্যমে আধুনিক কৃষি পদ্ধতি, উৎপাদনশীলতা বৃদ্ধি এবং ফসল ব্যবস্থাপনা শিখুন।',
                    'course-1-title': 'আধুনিক সেচ পদ্ধতি',
                    'course-1-desc': 'ড্রিপ ও স্প্রিংকলার সিস্টেম দিয়ে জলের ব্যবহার অপ্টিমাইজ করুন। স্মার্ট জল ব্যবস্থাপনা শিখুন।',
                    'course-2-title': 'জৈব চাষ',
                    'course-2-desc': 'প্রাকৃতিক, রাসায়নিকমুক্ত চাষ এবং মাটির উর্বরতা বৃদ্ধির কৌশলে দক্ষতা অর্জন করুন।',
                    'course-3-title': 'ফসল বীমা সচেতনতা',
                    'course-3-desc': 'ঝুঁকি থেকে আপনার ফসল রক্ষা করতে পলিসির বিবরণ এবং দাবি প্রক্রিয়া বুঝুন।',
                    'course-4-title': 'ক্লাউড ইন্টিগ্রেশন ও ই-লার্নিং',
                    'course-4-desc': 'ডেটা ব্যবস্থাপনা এবং ডিজিটাল কৃষি সম্পদ অ্যাক্সেসের জন্য ক্লাউড টুল ব্যবহার করুন।',
                    'guide-irrigation-step-1': 'জল দেওয়ার আগে আঙুল দিয়ে মাটির আর্দ্রতা পরীক্ষা করুন।',
                    'guide-irrigation-step-2': 'সারিবদ্ধ ফসলের জন্য ড্রিপ লাইন, খোলা মাঠের জন্য স্প্রিংকলার ব্যবহার করুন।',
                    'guide-irrigation-step-3': 'বাষ্পীভবন কমাতে ভোরে বা সন্ধ্যায় জল দিন।',
                    'guide-irrigation-step-4': 'প্রতি সপ্তাহে এমিটার এবং নজলে আটকানো বা লিক আছে কিনা পরীক্ষা করুন।',
                    'guide-irrigation-tip': '💡 নির্দিষ্ট সময়সূচি অনুযায়ী জল দেওয়ার চেয়ে দ্রুত মাটি পরীক্ষা করাই ভালো।',
                    'guide-organic-step-1': 'ফসলের বর্জ্য, গোবর এবং রান্নাঘরের বর্জ্য থেকে কম্পোস্ট তৈরি করুন।',
                    'guide-organic-step-2': 'মাটিকে স্বাভাবিকভাবে স্বাস্থ্যকর রাখতে প্রতি মৌসুমে ফসল পরিবর্তন করুন।',
                    'guide-organic-step-3': 'রাসায়নিক স্প্রের পরিবর্তে নিম তেল এবং সহচর রোপণ ব্যবহার করুন।',
                    'guide-organic-step-4': 'জমি যথেষ্ট সময় রাসায়নিকমুক্ত থাকলে সার্টিফিকেশনের জন্য আবেদন করুন।',
                    'guide-organic-tip': '💡 প্রকৃত সার হলো স্বাস্থ্যকর মাটি — শুধু গাছ নয়, মাটিকেও পুষ্টি দিন।',
                    'guide-insurance-step-1': 'মৌসুমের নথিভুক্তির শেষ তারিখের আগে নথিভুক্ত করুন।',
                    'guide-insurance-step-2': 'বপনের তারিখ ও জমির পরিমাণের প্রমাণ সংরক্ষণ করুন।',
                    'guide-insurance-step-3': 'দাবি জানানোর সময়সীমার মধ্যে আপনার বীমা প্রতিষ্ঠানকে ফসলের ক্ষতি জানান।',
                    'guide-insurance-step-4': 'সাড়া না পেলে স্থানীয় কৃষি অফিসের সাথে যোগাযোগ করুন।',
                    'guide-insurance-tip': '💡 বপনের পরপরই আপনার জমির ছবি তুলুন — এতে পরে দাবি দ্রুত হয়।',
                    'guide-cloud-step-1': 'বিশ্বস্ত ই-কৃষি বা ফার্ম-ডেটা পোর্টালে একটি অ্যাকাউন্ট তৈরি করুন।',
                    'guide-cloud-step-2': 'নিয়মিতভাবে আপনার খামার ও ফসলের রেকর্ড আপলোড করুন।',
                    'guide-cloud-step-3': 'আপনার ফসলের জন্য আবহাওয়া এবং বাজার-মূল্য সতর্কতা চালু করুন।',
                    'guide-cloud-step-4': 'জমি ও ক্রয়ের নথিগুলির ছবি ব্যাকআপ রাখুন।',
                    'guide-cloud-tip': '💡 হারিয়ে যাওয়া কাগজের রসিদের চেয়ে সিঙ্ক করা রেকর্ড ভালো।',
                    'ai-chat-title': '✨ এগ্রি-জেমিনি: তাৎক্ষণিক ফসল পরামর্শদাতা',
                    'ai-desc': 'চাষের কৌশল, বাজারের প্রবণতা বা কীটপতঙ্গ ব্যবস্থাপনা সম্পর্কে যেকোনো কিছু জিজ্ঞাসা করুন!',
                    'sec-video-title': 'কৃষকদের জন্য ভিডিও',
                    'sec-video-p': 'ফসল চাষ, মাটির স্বাস্থ্য এবং আধুনিক কৃষি পদ্ধতি সম্পর্কে এই সহায়ক ভিডিওগুলি দেখুন।',
                    'sec-scheme-title': 'কৃষকদের জন্য সরকারি প্রকল্প',
                    'sec-scheme-p': 'কৃষকদের সহায়তার জন্য ডিজাইন করা কিছু গুরুত্বপূর্ণ সরকারি প্রকল্প এখানে দেওয়া হলো। আরও জানতে এবং আবেদন করতে লিঙ্কে ক্লিক করুন:',
                    'scheme-1-desc': 'প্রধানমন্ত্রী কিষাণ সম্মান নিধি (পিএম-কিষাণ) – কৃষকদের বার্ষিক ₹6,000 সরাসরি আয় সহায়তা।',
                    'scheme-2-desc': 'প্রধানমন্ত্রী ফসল বীমা যোজনা (পিএমএফবিওয়াই) – প্রাকৃতিক দুর্যোগের বিরুদ্ধে কৃষকদের জন্য ফসল বীমা।',
                    'scheme-3-desc': 'মৃত্তিকা স্বাস্থ্য কার্ড প্রকল্প – কৃষকদের মাটির স্বাস্থ্য প্রতিবেদন ও সুপারিশ প্রদান করে।',
                    'scheme-4-desc': 'কৃষি পরিকাঠামো তহবিল (এআইএফ) – কৃষি পরিকাঠামো উন্নয়নের জন্য আর্থিক সহায়তা।',
                    'scheme-5-desc': 'জাতীয় কৃষি বাজার (ই-নাম) – কৃষকদের তাদের ফসল বিক্রির জন্য অনলাইন ট্রেডিং প্ল্যাটফর্ম।',
                    'sec-contact-title': 'আমাদের সাথে যোগাযোগ করুন',
                    'contact-info-1': 'ইমেইল: support@farmerplatform.in',
                    'contact-info-2': 'হেল্পলাইন: +91 7393953233',
                    'form-label-name': 'নাম',
                    'form-label-email': 'ইমেইল',
                    'form-label-message': 'বার্তা',
                    'form-button-send': 'বার্তা পাঠান',
                    'footer-copyright': '© 2025 কৃষকদের জন্য ডিজিটাল বাজার ও লার্নিং প্ল্যাটফর্ম | সর্বস্বত্ব সংরক্ষিত',
                    'footer-visits': 'মোট ভিজিট: ',
                    'nav-messages': 'বার্তাসমূহ',
                    'nav-mypurchases': 'আমার ক্রয়',
                    'sec-messages-title': 'ক্রেতাদের কাছ থেকে বার্তা',
                    'sec-messages-p': 'আপনার পণ্য সম্পর্কে ক্রেতারা যে নোট পাঠিয়েছেন।',
                    'messages-empty': 'এখনো কোনো বার্তা নেই।',
                    'msg-about-prefix': 'বিষয়ে',
                    'sec-mypurchases-title': 'আমার ক্রয়',
                    'sec-mypurchases-p': 'আপনি যে পণ্যগুলি কিনেছেন। একটি রিভিউ দিন অথবা আপনার অর্ডার সম্পর্কে কৃষককে বার্তা পাঠান।',
                    'purchases-empty': 'আপনি এখনো কিছু কেনেননি।',
                    'purchase-bought-from': 'থেকে কেনা হয়েছে',
                    'btn-leave-review': 'রিভিউ দিন',
                    'btn-update-review': 'রিভিউ আপডেট করুন',
                    'btn-message-farmer': 'কৃষককে বার্তা পাঠান',
                    'review-comment-placeholder': 'এই পণ্য সম্পর্কে আপনার মতামত কী? (ঐচ্ছিক)',
                    'btn-submit-review': 'রিভিউ জমা দিন',
                    'message-ask-placeholder': (name) => `আপনার অর্ডার সম্পর্কে ${name}-কে জিজ্ঞাসা করুন...`,
                    'btn-send-message': 'বার্তা পাঠান',
                    'toast-select-rating': 'অনুগ্রহ করে প্রথমে একটি স্টার রেটিং নির্বাচন করুন।',
                    'toast-reviews-unavailable': 'রিভিউ এই মুহূর্তে উপলব্ধ নেই — অনুগ্রহ করে একটু পরে আবার চেষ্টা করুন।',
                    'toast-review-thanks': 'আপনার রিভিউয়ের জন্য ধন্যবাদ!',
                    'toast-review-error': 'আপনার রিভিউ জমা দেওয়া যায়নি। অনুগ্রহ করে আবার চেষ্টা করুন।',
                    'toast-write-message-first': 'অনুগ্রহ করে প্রথমে একটি বার্তা লিখুন।',
                    'toast-messaging-unavailable': 'বার্তা পরিষেবা এই মুহূর্তে উপলব্ধ নেই — অনুগ্রহ করে একটু পরে আবার চেষ্টা করুন।',
                    'toast-message-sent': (name) => `${name}-কে বার্তা পাঠানো হয়েছে।`,
                    'toast-message-error': 'আপনার বার্তা পাঠানো যায়নি। অনুগ্রহ করে আবার চেষ্টা করুন।',
                    'toast-success': 'বার্তা সফলভাবে পাঠানো হয়েছে! আমরা শীঘ্রই আপনার সাথে যোগাযোগ করব।',
                    'toast-error-fields': 'অনুগ্রহ করে বাজারের সমস্ত ক্ষেত্র সঠিকভাবে পূরণ করুন।',
                    'toast-error-image': 'বিক্রির আগে অনুগ্রহ করে পণ্যের একটি ছবি যোগ করুন (স্টোরেজ বা ক্যামেরা থেকে)।',
                    'toast-error-category': 'অনুগ্রহ করে একটি বিভাগ নির্বাচন করুন: সবজি, ফল, বীজ, বা যন্ত্রপাতি।',
                    'toast-error-search': 'অনুসন্ধানের জন্য একটি পণ্যের নাম লিখুন।',
                    'alert-cart-add': (name) => `${name} কার্টে যোগ করা হয়েছে!`,
                    'alert-pay-success': (amount) => `₹${amount} পেমেন্ট সফল হয়েছে! আপনার কেনাকাটার জন্য ধন্যবাদ।`,
                    'alert-pay-processing': (amount) => `₹${amount} পেমেন্ট প্রক্রিয়াকরণ হচ্ছে...`,
                    'alert-search': (name) => `বাজারে "${name}" অনুসন্ধান করা হচ্ছে...`,
                    'alert-empty-cart': 'আপনার কার্ট খালি। পেমেন্ট করার মতো কিছু নেই।',
                    'listen-label': 'শুনুন',
                    'steps-label': '✍️ অনুসরণ করার ধাপসমূহ:',
                    'toast-sold-out': (qty, name) => `${name}-এর মাত্র ${qty}টি ইউনিট উপলব্ধ আছে।`,
                    'nav-about': 'আমাদের সম্পর্কে',
                    'sec-about-title': 'এগ্রি দুনিয়া সম্পর্কে',
                    'about-eyebrow': 'আমাদের গল্প',
                    'about-headline': 'কৃষকদের দ্বারা উৎপাদিত। যত্নসহকারে সরবরাহ করা।',
                    'about-intro': 'কৃষকরা ভালো খাবার ফলাতে কঠোর পরিশ্রম করেন, কিন্তু যখন তা থালায় পৌঁছায়, তার মূল্যের একটি বড় অংশ চলে যায় তাদের কাছে যারা কখনো মাটি স্পর্শও করেননি। এটি বদলাতেই এগ্রি দুনিয়ার সৃষ্টি — এমন একটি প্ল্যাটফর্ম যেখানে কৃষকরা সরাসরি তাদের কাছে বিক্রি করেন যারা তাদের ফলানো খাবার খান, এবং যেখানে চাষাবাদ একক সংগ্রামের মতো নয়, বরং একটি যৌথ প্রচেষ্টার মতো অনুভূত হয়।',
                    'about-what-title': 'আমরা যা করি',
                    'about-what-1-title': 'সরাসরি বিক্রয়',
                    'about-what-1-desc': 'কৃষকরা তাদের ফসল তালিকাভুক্ত করেন এবং সরাসরি ভোক্তাদের কাছে বিক্রি করেন — পথে কোনো মধ্যস্বত্বভোগী অংশ নেয় না।',
                    'about-what-2-title': 'আগাম অর্ডার করুন',
                    'about-what-2-desc': 'দূরত্বের উপর নির্ভর করে, ডেলিভারির প্রায় 11–12 ঘণ্টা আগে ভোক্তারা অর্ডার দেন, যাতে কৃষকরা ঠিক কী সংগ্রহ করতে হবে তা জানতে পারেন।',
                    'about-what-3-title': 'সুসংগঠিত সংগ্রহ',
                    'about-what-3-desc': 'আমাদের নির্ধারিত টেম্পো ও পরিবহন দল কৃষকদের কাছ থেকে সরাসরি বাল্কে ফসল সংগ্রহ করে।',
                    'about-what-4-title': 'উভয় পক্ষের জন্য ন্যায্য মূল্য',
                    'about-what-4-desc': 'অপ্রয়োজনীয় মধ্যস্বত্বভোগী বাদ দেওয়ার ফলে কৃষকরা ভালো লাভ পান এবং ভোক্তারা ভালো দাম পান।',
                    'about-how-title': 'আমরা কীভাবে কাজ করি',
                    'about-how-1-title': 'কৃষক ফসল তোলেন',
                    'about-how-1-desc': 'অনুমানের ভিত্তিতে নয়, প্রকৃত অর্ডার অনুযায়ী সংগ্রহ করা তাজা ফসল।',
                    'about-how-2-title': 'এগ্রি দুনিয়া সংগ্রহ করে',
                    'about-how-2-desc': 'আমাদের টেম্পো ও পরিবহন দল কৃষকদের কাছ থেকে বাল্কে ফসল সংগ্রহ করে।',
                    'about-how-3-title': 'বাছাই ও বিতরণ',
                    'about-how-3-desc': 'আমাদের দল ফসল বাছাই করে ডেলিভারির জন্য প্রস্তুত করে।',
                    'about-how-4-title': 'ভোক্তার কাছে পৌঁছায়',
                    'about-how-4-desc': 'ন্যায্য মূল্যে তাজা ফসল ক্রেতার কাছে সরবরাহ করা হয়।',
                    'about-beyond-title': 'বাজারের বাইরেও',
                    'about-beyond-intro': 'এগ্রি দুনিয়া শুধু কেনাবেচার জায়গা নয়। আমরা একটি সমবায়-ধাঁচের কৃষক সম্প্রদায় গড়ে তোলার দিকে কাজ করছি, যেখানে কৃষকরা অসংগঠিত বাজারে একা প্রতিযোগিতা না করে একে অপরকে সহায়তা করেন।',
                    'about-beyond-item-1': 'কৃষি সরঞ্জাম কিনুন ও বিক্রি করুন',
                    'about-beyond-item-2': 'বীজ এবং অন্যান্য কৃষি সম্পদ কিনুন',
                    'about-beyond-item-3': 'আধুনিক কৃষি পদ্ধতি শিখুন',
                    'about-beyond-item-4': 'নতুন চালু হওয়া সরকারি প্রকল্প সম্পর্কে আপডেট থাকুন',
                    'about-beyond-item-5': 'আরও দায়িত্বশীল, টেকসই কৃষি পদ্ধতি অনুসরণ করুন',
                    'about-beyond-item-6': 'একা নয়, একটি সম্প্রদায় হিসেবে একসাথে কাজ করুন',
                    'about-beyond-note': 'স্বাস্থ্যকর মাটি এবং স্বাস্থ্যকর খাদ্যের জন্য, কৃষি রাসায়নিকের দায়িত্বশীল ব্যবহার এবং উন্নত কৃষি পদ্ধতি উৎসাহিত করার চুক্তির ক্ষেত্রেও আমরা কৃষকদের সাথে কাজ করছি।',
                    'about-vision-title': 'আমাদের লক্ষ্য',
                    'about-vision-desc': 'আমরা চাই এগ্রি দুনিয়া শুধু একটি অ্যাপ না হয়ে উঠুক — একটি কৃষক সম্প্রদায় হয়ে উঠুক যেখানে ফসল সরাসরি ক্ষেত থেকে পরিবারে পৌঁছায়, এবং যেখানে কৃষকদের আত্মবিশ্বাসের সাথে এগিয়ে যাওয়ার জন্য প্রয়োজনীয় সরঞ্জাম, জ্ঞান ও সহায়তা থাকে।',
                    'about-cta-title': 'আপনি চাষ করুন বা কিনুন, এখানে আপনার জন্য জায়গা আছে।',
                    'about-cta-btn': 'বাজার দেখুন',
                    'about-social-title': 'ইনস্টাগ্রামে আমাদের ফলো করুন',
                    'about-social-desc': 'তাজা ফসল, কৃষকদের গল্প, এবং এগ্রি দুনিয়ায় নতুন কী আছে।',
                }
            };

            // --- Language switcher ---
            // NOTE: this block was missing from the file (it was cut off here) and has
            // been reconstructed from scratch, reusing the existing SUPPORTED_LANGS /
            // LANG_LABELS constants (declared earlier in this file) and the langToggle /
            // langMenu / data-key elements already present in index.html.
            // It was not part of the original recovered code.
            //
            // All five languages ('en', 'hi', 'ta', 'te', 'bn') now have complete,
            // matching key sets in `translations` above, so switching to any
            // supported language fully replaces the UI text (no English fallback).
            function applyLanguage(lang) {
                const dict = translations[lang] || translations['en'];
                document.querySelectorAll('[data-key]').forEach(el => {
                    const key = el.getAttribute('data-key');
                    if (dict[key] !== undefined) {
                        el.textContent = dict[key];
                    }
                });
                currentLang = lang;
                langToggle.textContent = lang.toUpperCase();
                localStorage.setItem('agriLang', lang);
                langMenu.querySelectorAll('.lang-menu-item').forEach(el => {
                    el.classList.toggle('active', el.dataset.lang === lang);
                });
            }

            if (langToggle && langMenu) {
                SUPPORTED_LANGS.forEach(lang => {
                    const item = document.createElement('button');
                    item.type = 'button';
                    item.className = 'lang-menu-item';
                    item.dataset.lang = lang;
                    item.textContent = LANG_LABELS[lang] || lang.toUpperCase();
                    item.addEventListener('click', () => {
                        applyLanguage(lang);
                        langMenu.classList.remove('open');
                    });
                    langMenu.appendChild(item);
                });

                langToggle.addEventListener('click', (e) => {
                    e.stopPropagation();
                    langMenu.classList.toggle('open');
                });
                document.addEventListener('click', () => langMenu.classList.remove('open'));

                const savedLang = localStorage.getItem('agriLang') || 'en';
                applyLanguage(savedLang);
            }
        });
