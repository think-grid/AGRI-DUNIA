// gemini key stays server side (firebase cloud function), this file just hits these urls
const CHAT_PROXY_URL = "https://us-central1-agri-dunia.cloudfunctions.net/geminiChat";
const TTS_PROXY_URL = "https://us-central1-agri-dunia.cloudfunctions.net/geminiTts";

// google sign-in client id, get one from google cloud console if this needs changing
const GOOGLE_CLIENT_ID = "1007423755384-j0q27cdejbiqbv8cjtifmnr9e29jajkv.apps.googleusercontent.com";

        // Cloud Functions occasionally 429 under load; retry with jittered exponential
        // backoff instead of failing the chat/TTS request outright.
        async function fetchWithBackoff(url, options, maxRetries = 3) {
            for (let i = 0; i < maxRetries; i++) {
                try {
                    const response = await fetch(url, options);
                    if (response.ok) {
                        return response;
                    }
                    if (i === maxRetries - 1) {
                        throw new Error(`API call failed with status: ${response.status}`);
                    }
                    const delay = Math.pow(2, i) * 1000 + Math.random() * 1000;
                    await new Promise(resolve => setTimeout(resolve, delay));
                } catch (error) {
                    if (i === maxRetries - 1) throw error;
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

            async function addProductListing(name, qty, price, imageDataUrl, category) {
                if (!currentUser || currentUser.role !== 'farmer') return;
                if (!name || isNaN(qty) || qty <= 0 || isNaN(price) || price <= 0) {
                    showToast(translations[currentLang]['toast-error-fields'], false);
                    return;
                }
                if (!ALLOWED_PRODUCT_CATEGORIES.includes(category)) {
                    showToast(translations[currentLang]['toast-error-category'], false);
                    return;
                }
                if (!imageDataUrl) {
                    showToast(translations[currentLang]['toast-error-image'], false);
                    return;
                }
                if (typeof window.fbAddProduct !== 'function') {
                    showToast('Marketplace sync is unavailable right now — please try again in a moment.', false);
                    return;
                }
                if (!navigator.onLine) {
                    showToast('You appear to be offline. Reconnect and try again.', false);
                    return;
                }
                try {
                    await window.fbAddProduct({
                        name,
                        qty: parseInt(qty),
                        price: parseFloat(price),
                        farmerName: currentUser.name,
                        farmerPlace: currentUser.place || '',
                        image: imageDataUrl,
                        category
                    });
                    // No need to call renderProductListings() here — the Firestore
                    // onSnapshot listener in firebase.js will fire onProductsUpdated
                    // for this browser (and every other logged-in account) shortly.
                    showToast(`${name} has been listed for sale!`, true);
                } catch (err) {
                    // Surface *why* it failed instead of a one-size-fits-all message —
                    // "permission-denied" (Firestore security rules blocking writes)
                    // and "invalid-argument"/oversized payload are the two real causes
                    // seen in practice; both were previously masked as a generic
                    // "check your connection" toast, which sent debugging in the
                    // wrong direction (looks like a network problem, isn't one).
                    console.error('Failed to add product listing:', err);
                    showToast(describeFirestoreWriteError(err, 'Could not publish your listing. Please try again.'), false);
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
                                    ${rating ? `<br><span class="rating-badge">${starsHtml(rating.avg)} ${rating.avg.toFixed(1)} (${rating.count})</span>` : ''}</span>
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

            function renderPurchases() {
                const container = document.getElementById('myPurchasesItems');
                if (!container || !currentUser || currentUser.role !== 'buyer') return;

                const all = loadPurchases();
                const mine = all[currentUser.name] || [];

                if (mine.length === 0) {
                    container.innerHTML = `<p>You haven't bought anything yet.</p>`;
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
                                    <small>Bought from ${farmerName} · ${timeAgo(p.time)}</small>
                                </span>
                            </div>

                            <div class="purchase-actions">
                                <button onclick="toggleReviewForm('${p.id}')"><i class="fas fa-star"></i> ${existingReview ? 'Update Review' : 'Leave a Review'}</button>
                                <button onclick="toggleMessageForm('${p.id}')"><i class="fas fa-envelope"></i> Message Farmer</button>
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
                                <textarea id="reviewComment-${p.id}" rows="2" placeholder="What did you think of this product? (optional)">${existingReview ? escapeHtml(existingReview.comment || '') : ''}</textarea>
                                <button onclick="submitReview('${p.id}')">Submit Review</button>
                            </div>

                            <div class="message-panel" style="display:${msgOpen ? 'block' : 'none'};">
                                ${threadMessages.length > 0 ? `
                                    <div class="message-thread">
                                        ${threadMessages.map(m => `<div class="message-bubble-buyer">${escapeHtml(m.text)}<span class="message-time">${timeAgo(m.createdAt)}</span></div>`).join('')}
                                    </div>
                                ` : ''}
                                <textarea id="messageText-${p.id}" rows="2" placeholder="Ask ${farmerName} a question about your order..."></textarea>
                                <button onclick="submitMessage('${p.id}')">Send Message</button>
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
                    showToast('Please select a star rating first.', false);
                    return;
                }
                const commentEl = document.getElementById(`reviewComment-${purchaseId}`);
                const comment = commentEl ? commentEl.value.trim() : '';

                if (typeof window.fbAddReview !== 'function') {
                    showToast('Reviews are unavailable right now — please try again in a moment.', false);
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
                    showToast('Thanks for your review!', true);
                    openPurchaseForm = null;
                    renderPurchases();
                    renderProductListings();
                } catch (err) {
                    console.error('Failed to submit review:', err);
                    showToast(describeFirestoreWriteError(err, 'Could not submit your review. Please try again.'), false);
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
                    showToast('Please write a message first.', false);
                    return;
                }

                if (typeof window.fbAddMessage !== 'function') {
                    showToast('Messaging is unavailable right now — please try again in a moment.', false);
                    return;
                }
                try {
                    await window.fbAddMessage({
                        farmerName: purchase.farmerName,
                        buyerName: currentUser.name,
                        productName: purchase.name,
                        text
                    });
                    showToast(`Message sent to ${purchase.farmerName}.`, true);
                    renderPurchases();
                } catch (err) {
                    console.error('Failed to send message:', err);
                    showToast(describeFirestoreWriteError(err, 'Could not send your message. Please try again.'), false);
                }
            };

            function renderFarmerMessages() {
                const container = document.getElementById('farmerMessagesItems');
                if (!container || !currentUser || currentUser.role !== 'farmer') return;

                const mine = (window.__agriLatestMessages || [])
                    .filter(m => m.farmerName === currentUser.name)
                    .sort((a, b) => b.createdAt - a.createdAt);

                if (mine.length === 0) {
                    container.innerHTML = `<p>No messages yet.</p>`;
                    return;
                }

                container.innerHTML = mine.map(m => `
                    <div class="farmer-message-item">
                        <div>
                            <strong>${escapeHtml(m.buyerName)}</strong> ${m.productName ? `<span class="category-badge">about ${escapeHtml(m.productName)}</span>` : ''}
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
            const langToggle = document.getElementById('langToggle');
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
                    'toast-sold-out': (qty, name) => `Only ${qty} units of ${name} are available.`
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
                    'toast-sold-out': (qty, name) => `${name} की केवल ${qty} इकाइयाँ उपलब्ध हैं।`
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
                    'sell-button': 'விற்பனைக்கு இடுங்கள்',
                    'sell-category-label': 'பொருள் வகை (அவசியம்)',
                    'category-option-default': '-- வகையை தேர்ந்தெடுக்கவும் --',
                    'category-option-vegetables': '🥦 காய்கறிகள்',
                    'category-option-fruits': '🍎 பழங்கள்',
                    'category-option-seeds': '🌱 விதைகள்',
                    'category-option-tools': '🛠️ கருவிகள்',
                    'sell-image-label': 'பொருளின் புகைப்படத்தை சேர்க்கவும் (அவசியம்) 📷',
                    'cart-title': 'உங்கள் கார்ட்',
                    'cart-empty': 'உங்கள் கார்ட் காலியாக உள்ளது.',
                    'sec-learning-title': 'கற்றல் மையம்',
                    'sec-learning-p': 'எங்கள் தளத்தின் மூலம் நவீன விவசாய நுட்பங்கள், உற்பத்தி மேம்பாடு மற்றும் பயிர் மேலாண்மையை கற்றுக்கொள்ளுங்கள்.',
                    'course-1-title': 'நவீன நீர்ப்பாசன நுட்பங்கள்',
                    'course-1-desc': 'சொட்டு மற்றும் தெளிப்பு முறைகள் மூலம் நீர் பயன்பாட்டை மேம்படுத்துங்கள். சிறந்த நீர் மேலாண்மையை கற்றுக்கொள்ளுங்கள்.',
                    'course-2-title': 'இயற்கை வேளாண்மை',
                    'course-2-desc': 'இயற்கை, ரசாயனமற்ற சாகுபடி மற்றும் மண் வளப்படுத்தும் நுட்பங்களில் தேர்ச்சி பெறுங்கள்.',
                    'course-3-title': 'பயிர் காப்பீடு விழிப்புணர்வு',
                    'course-3-desc': 'உங்கள் அறுவடையை ஆபத்துகளிலிருந்து பாதுகாக்க கொள்கை விவரங்கள் மற்றும் உரிமைகோரல் செயல்முறையை புரிந்துகொள்ளுங்கள்.',
                    'course-4-title': 'கிளவுட் ஒருங்கிணைப்பு மற்றும் இ-கற்றல்',
                    'course-4-desc': 'தரவு மேலாண்மை மற்றும் டிஜிட்டல் வேளாண் வளங்களை அணுக கிளவுட் கருவிகளைப் பயன்படுத்துங்கள்.',
                    'ai-chat-title': '✨ அக்ரி-ஜெமினி: உடனடி பயிர் ஆலோசகர்',
                    'ai-desc': 'விவசாய நுட்பங்கள், சந்தை போக்குகள் அல்லது பூச்சி மேலாண்மை பற்றி என்னிடம் எதுவும் கேளுங்கள்!',
                    'sec-video-title': 'விவசாயிகளுக்கான வீடியோக்கள்',
                    'sec-video-p': 'பயிர் சாகுபடி, மண் ஆரோக்கியம் மற்றும் நவீன விவசாய நடைமுறைகள் குறித்த இந்த பயனுள்ள வீடியோக்களைப் பாருங்கள்.',
                    'sec-scheme-title': 'விவசாயிகளுக்கான அரசு திட்டங்கள்',
                    'sec-scheme-p': 'விவசாயிகளுக்கு உதவும் வகையில் வடிவமைக்கப்பட்ட சில முக்கிய அரசு திட்டங்கள் இங்கே உள்ளன. மேலும் அறியவும் விண்ணப்பிக்கவும் இணைப்புகளை கிளிக் செய்யவும்:',
                    'scheme-1-desc': 'பிரதான் மந்திரி கிசான் சம்மான் நிதி (PM-KISAN) – விவசாயிகளுக்கு ஆண்டுதோறும் ₹6,000 நேரடி வருமான உதவி.',
                    'scheme-2-desc': 'பிரதான் மந்திரி பசல் பீமா யோஜனா (PMFBY) – இயற்கை பேரிடர்களுக்கு எதிராக விவசாயிகளுக்கான பயிர் காப்பீடு.',
                    'scheme-3-desc': 'மண் ஆரோக்கிய அட்டை திட்டம் – விவசாயிகளுக்கு மண் ஆரோக்கிய அறிக்கைகள் மற்றும் பரிந்துரைகளை வழங்குகிறது.',
                    'scheme-4-desc': 'வேளாண் உள்கட்டமைப்பு நிதி (AIF) – வேளாண் உள்கட்டமைப்பை மேம்படுத்த நிதி உதவி.',
                    'scheme-5-desc': 'தேசிய வேளாண் சந்தை (eNAM) – விவசாயிகள் தங்கள் விளைபொருட்களை விற்க ஆன்லைன் வர்த்தக தளம்.',
                    'sec-contact-title': 'எங்களை தொடர்பு கொள்ளுங்கள்',
                    'contact-info-1': 'மின்னஞ்சல்: support@farmerplatform.in',
                    'contact-info-2': 'உதவி எண்: +91 7393953233',
                    'form-label-name': 'பெயர்',
                    'form-label-email': 'மின்னஞ்சல்',
                    'form-label-message': 'செய்தி',
                    'form-button-send': 'செய்தி அனுப்பவும்',
                    'footer-copyright': '© 2025 டிஜிட்டல் சந்தை & விவசாயிகளுக்கான கற்றல் தளம் | அனைத்து உரிமைகளும் பாதுகாக்கப்பட்டவை',
                    'footer-visits': 'மொத்த வருகைகள்: ',
                    'toast-success': 'செய்தி வெற்றிகரமாக அனுப்பப்பட்டது! நாங்கள் விரைவில் உங்களை தொடர்பு கொள்வோம்.',
                    'toast-error-fields': 'சந்தை புலங்கள் அனைத்தையும் சரியாக நிரப்பவும்.',
                    'toast-error-image': 'விற்பனைக்கு முன் பொருளின் புகைப்படத்தை (சேமிப்பு அல்லது கேமராவிலிருந்து) சேர்க்கவும்.',
                    'toast-error-category': 'ஒரு வகையை தேர்ந்தெடுக்கவும்: காய்கறிகள், பழங்கள், விதைகள் அல்லது கருவிகள்.',
                    'toast-error-search': 'தேட பொருளின் பெயரை உள்ளிடவும்.',
                    'alert-cart-add': (name) => `${name} கார்ட்டில் சேர்க்கப்பட்டது!`,
                    'alert-pay-success': (amount) => `₹${amount} கட்டணம் வெற்றிகரமாக செலுத்தப்பட்டது! உங்கள் வாங்குதலுக்கு நன்றி.`,
                    'alert-pay-processing': (amount) => `₹${amount} கட்டணம் செயலாக்கப்படுகிறது...`,
                    'alert-search': (name) => `"${name}" சந்தையில் தேடப்படுகிறது...`,
                    'alert-empty-cart': 'உங்கள் கார்ட் காலியாக உள்ளது. செலுத்த எதுவும் இல்லை.',
                    'listen-label': 'கேளுங்கள்',
                    'steps-label': '✍️ பின்பற்ற வேண்டிய படிகள்:',
                    'toast-sold-out': (qty, name) => `${name} இன் ${qty} அலகுகள் மட்டுமே கிடைக்கின்றன.`
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
                    'sec-market-p': 'వ్యవసాయ ఉత్పత్తులను నేరుగా కొనండి మరియు అమ్మండి. రైతులు తమ పంటలను జాబితా చేయవచ్చు, కొనుగోలుదారులు నేరుగా కొనుగోలు చేయవచ్చు, ఇది న్యాయమైన వాణిజ్యాన్ని నిర్ధారిస్తుంది.',
                    'sec-myproducts-title': 'నా ఉత్పత్తులు',
                    'sec-myproducts-p': 'మీరు అమ్మకానికి జాబితా చేసిన ఉత్పత్తులను నిర్వహించండి — కొనుగోలుదారులు వీటిని మార్కెట్‌ప్లేస్ నుండి నేరుగా చూసి కొనుగోలు చేయవచ్చు.',
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
                    'sec-learning-p': 'మా వేదిక ద్వారా ఆధునిక వ్యవసాయ పద్ధతులు, ఉత్పాదకత మెరుగుదల మరియు పంట నిర్వహణను నేర్చుకోండి.',
                    'course-1-title': 'ఆధునిక నీటిపారుదల పద్ధతులు',
                    'course-1-desc': 'డ్రిప్ మరియు స్ప్రింక్లర్ వ్యవస్థలతో నీటి వినియోగాన్ని ఆప్టిమైజ్ చేయండి. స్మార్ట్ నీటి నిర్వహణను నేర్చుకోండి.',
                    'course-2-title': 'సేంద్రీయ వ్యవసాయం',
                    'course-2-desc': 'సహజ, రసాయన రహిత సాగు మరియు నేల సుసంపన్నత పద్ధతులను నేర్చుకోండి.',
                    'course-3-title': 'పంట బీమా అవగాహన',
                    'course-3-desc': 'మీ పంటను ప్రమాదాల నుండి రక్షించడానికి పాలసీ వివరాలు మరియు క్లెయిమ్‌ల ప్రక్రియను అర్థం చేసుకోండి.',
                    'course-4-title': 'క్లౌడ్ ఇంటిగ్రేషన్ & ఇ-లెర్నింగ్',
                    'course-4-desc': 'డేటా నిర్వహణ మరియు డిజిటల్ వ్యవసాయ వనరుల కోసం క్లౌడ్ సాధనాలను ఉపయోగించండి.',
                    'ai-chat-title': '✨ అగ్రి-జెమిని: తక్షణ పంట సలహాదారు',
                    'ai-desc': 'వ్యవసాయ పద్ధతులు, మార్కెట్ ధోరణులు లేదా చీడపీడల నిర్వహణ గురించి నన్ను ఏదైనా అడగండి!',
                    'sec-video-title': 'రైతుల కోసం వీడియోలు',
                    'sec-video-p': 'పంట సాగు, నేల ఆరోగ్యం మరియు ఆధునిక వ్యవసాయ పద్ధతులపై ఈ ఉపయోగకరమైన వీడియోలను చూడండి.',
                    'sec-scheme-title': 'రైతుల కోసం ప్రభుత్వ పథకాలు',
                    'sec-scheme-p': 'రైతులకు మద్దతు ఇవ్వడానికి రూపొందించిన కొన్ని ముఖ్యమైన ప్రభుత్వ పథకాలు ఇక్కడ ఉన్నాయి. మరింత తెలుసుకోవడానికి మరియు దరఖాస్తు చేయడానికి లింక్‌లపై క్లిక్ చేయండి:',
                    'scheme-1-desc': 'ప్రధాన మంత్రి కిసాన్ సమ్మాన్ నిధి (PM-KISAN) – రైతులకు ఏటా ₹6,000 ప్రత్యక్ష ఆదాయ మద్దతు.',
                    'scheme-2-desc': 'ప్రధాన మంత్రి ఫసల్ బీమా యోజన (PMFBY) – ప్రకృతి వైపరీత్యాలకు వ్యతిరేకంగా రైతులకు పంట బీమా.',
                    'scheme-3-desc': 'నేల ఆరోగ్య కార్డు పథకం – రైతులకు నేల ఆరోగ్య నివేదికలు మరియు సిఫార్సులను అందిస్తుంది.',
                    'scheme-4-desc': 'వ్యవసాయ మౌలిక సదుపాయాల నిధి (AIF) – వ్యవసాయ మౌలిక సదుపాయాల అభివృద్ధికి ఆర్థిక మద్దతు.',
                    'scheme-5-desc': 'జాతీయ వ్యవసాయ మార్కెట్ (eNAM) – రైతులు తమ ఉత్పత్తులను అమ్మడానికి ఆన్‌లైన్ ట్రేడింగ్ ప్లాట్‌ఫారమ్.',
                    'sec-contact-title': 'మమ్మల్ని సంప్రదించండి',
                    'contact-info-1': 'ఇమెయిల్: support@farmerplatform.in',
                    'contact-info-2': 'హెల్ప్‌లైన్: +91 7393953233',
                    'form-label-name': 'పేరు',
                    'form-label-email': 'ఇమెయిల్',
                    'form-label-message': 'సందేశం',
                    'form-button-send': 'సందేశం పంపండి',
                    'footer-copyright': '© 2025 డిజిటల్ మార్కెట్‌ప్లేస్ & రైతుల కోసం లెర్నింగ్ ప్లాట్‌ఫారమ్ | అన్ని హక్కులు రక్షించబడ్డాయి',
                    'footer-visits': 'మొత్తం సందర్శనలు: ',
                    'toast-success': 'సందేశం విజయవంతంగా పంపబడింది! మేము త్వరలో మిమ్మల్ని సంప్రదిస్తాము.',
                    'toast-error-fields': 'దయచేసి మార్కెట్‌ప్లేస్ ఫీల్డ్‌లన్నింటినీ సరిగ్గా పూరించండి.',
                    'toast-error-image': 'అమ్మడానికి ముందు దయచేసి ఉత్పత్తి ఫోటోను (స్టోరేజ్ లేదా కెమెరా నుండి) జోడించండి.',
                    'toast-error-category': 'దయచేసి ఒక వర్గాన్ని ఎంచుకోండి: కూరగాయలు, పండ్లు, విత్తనాలు లేదా పనిముట్లు.',
                    'toast-error-search': 'శోధించడానికి ఉత్పత్తి పేరును నమోదు చేయండి.',
                    'alert-cart-add': (name) => `${name} కార్ట్‌కు జోడించబడింది!`,
                    'alert-pay-success': (amount) => `₹${amount} చెల్లింపు విజయవంతమైంది! మీ కొనుగోలుకు ధన్యవాదాలు.`,
                    'alert-pay-processing': (amount) => `₹${amount} చెల్లింపు ప్రాసెస్ చేయబడుతోంది...`,
                    'alert-search': (name) => `మార్కెట్‌ప్లేస్‌లో "${name}" కోసం శోధిస్తోంది...`,
                    'alert-empty-cart': 'మీ కార్ట్ ఖాళీగా ఉంది. చెల్లించడానికి ఏమీ లేదు.',
                    'listen-label': 'వినండి',
                    'steps-label': '✍️ అనుసరించాల్సిన దశలు:',
                    'toast-sold-out': (qty, name) => `${name} యొక్క ${qty} యూనిట్లు మాత్రమే అందుబాటులో ఉన్నాయి.`
                },
                'bn': {
                    'header-title': 'অ্যাগ্রি দুনিয়া',
                    'header-tagline': 'বাজার, জ্ঞান এবং সরকারি প্রকল্পে ডিজিটাল অ্যাক্সেসের মাধ্যমে কৃষকদের ক্ষমতায়ন',
                    'nav-market': 'মার্কেটপ্লেস',
                    'nav-myproducts': 'আমার পণ্য',
                    'nav-learning': 'লার্নিং হাব',
                    'nav-videos': 'ভিডিও',
                    'nav-schemes': 'প্রকল্প',
                    'nav-contact': 'যোগাযোগ',
                    'sec-market-title': 'ডিজিটাল মার্কেটপ্লেস',
                    'sec-market-p': 'সরাসরি কৃষি পণ্য কিনুন এবং বিক্রি করুন। কৃষকরা তাদের ফসল তালিকাভুক্ত করতে পারেন, এবং ক্রেতারা সরাসরি কিনতে পারেন, যা ন্যায্য বাণিজ্য নিশ্চিত করে।',
                    'sec-myproducts-title': 'আমার পণ্য',
                    'sec-myproducts-p': 'আপনি বিক্রির জন্য তালিকাভুক্ত পণ্যগুলি পরিচালনা করুন — ক্রেতারা এগুলি সরাসরি মার্কেটপ্লেস থেকে দেখতে ও কিনতে পারবেন।',
                    'sell-title': 'আপনার পণ্য বিক্রি করুন',
                    'sell-button': 'বিক্রির জন্য পোস্ট করুন',
                    'sell-category-label': 'পণ্যের বিভাগ (আবশ্যক)',
                    'category-option-default': '-- বিভাগ নির্বাচন করুন --',
                    'category-option-vegetables': '🥦 সবজি',
                    'category-option-fruits': '🍎 ফল',
                    'category-option-seeds': '🌱 বীজ',
                    'category-option-tools': '🛠️ সরঞ্জাম',
                    'sell-image-label': 'পণ্যের ছবি যোগ করুন (আবশ্যক) 📷',
                    'cart-title': 'আপনার কার্ট',
                    'cart-empty': 'আপনার কার্ট খালি।',
                    'sec-learning-title': 'লার্নিং হাব',
                    'sec-learning-p': 'আমাদের প্ল্যাটফর্মের মাধ্যমে আধুনিক কৃষি কৌশল, উৎপাদনশীলতা উন্নতি এবং ফসল ব্যবস্থাপনা শিখুন।',
                    'course-1-title': 'আধুনিক সেচ কৌশল',
                    'course-1-desc': 'ড্রিপ এবং স্প্রিংকলার সিস্টেমের মাধ্যমে জলের ব্যবহার অপ্টিমাইজ করুন। স্মার্ট জল ব্যবস্থাপনা শিখুন।',
                    'course-2-title': 'জৈব চাষ',
                    'course-2-desc': 'প্রাকৃতিক, রাসায়নিকমুক্ত চাষাবাদ এবং মাটি সমৃদ্ধকরণের কৌশলে দক্ষতা অর্জন করুন।',
                    'course-3-title': 'ফসল বীমা সচেতনতা',
                    'course-3-desc': 'ঝুঁকির বিরুদ্ধে আপনার ফসল সুরক্ষিত রাখতে নীতির বিবরণ এবং দাবি প্রক্রিয়া বুঝুন।',
                    'course-4-title': 'ক্লাউড ইন্টিগ্রেশন ও ই-লার্নিং',
                    'course-4-desc': 'ডেটা ব্যবস্থাপনা এবং ডিজিটাল কৃষি সম্পদ অ্যাক্সেসের জন্য ক্লাউড টুল ব্যবহার করুন।',
                    'ai-chat-title': '✨ অ্যাগ্রি-জেমিনি: তাৎক্ষণিক ফসল উপদেষ্টা',
                    'ai-desc': 'কৃষি কৌশল, বাজারের প্রবণতা বা পোকামাকড় ব্যবস্থাপনা সম্পর্কে আমাকে যেকোনো কিছু জিজ্ঞাসা করুন!',
                    'sec-video-title': 'কৃষকদের জন্য ভিডিও',
                    'sec-video-p': 'ফসল চাষ, মাটির স্বাস্থ্য এবং আধুনিক কৃষি পদ্ধতি সম্পর্কিত এই সহায়ক ভিডিওগুলি দেখুন।',
                    'sec-scheme-title': 'কৃষকদের জন্য সরকারি প্রকল্প',
                    'sec-scheme-p': 'কৃষকদের সহায়তার জন্য ডিজাইন করা কিছু গুরুত্বপূর্ণ সরকারি প্রকল্প এখানে দেওয়া হলো। আরও জানতে এবং আবেদন করতে লিঙ্কে ক্লিক করুন:',
                    'scheme-1-desc': 'প্রধানমন্ত্রী কিষান সম্মান নিধি (PM-KISAN) – কৃষকদের বার্ষিক ₹৬,০০০ সরাসরি আয় সহায়তা।',
                    'scheme-2-desc': 'প্রধানমন্ত্রী ফসল বীমা যোজনা (PMFBY) – প্রাকৃতিক দুর্যোগের বিরুদ্ধে কৃষকদের জন্য ফসল বীমা।',
                    'scheme-3-desc': 'মৃত্তিকা স্বাস্থ্য কার্ড প্রকল্প – কৃষকদের মাটির স্বাস্থ্য প্রতিবেদন এবং সুপারিশ প্রদান করে।',
                    'scheme-4-desc': 'কৃষি অবকাঠামো তহবিল (AIF) – কৃষি অবকাঠামো উন্নয়নের জন্য আর্থিক সহায়তা।',
                    'scheme-5-desc': 'জাতীয় কৃষি বাজার (eNAM) – কৃষকদের তাদের পণ্য বিক্রির জন্য অনলাইন ট্রেডিং প্ল্যাটফর্ম।',
                    'sec-contact-title': 'যোগাযোগ করুন',
                    'contact-info-1': 'ইমেইল: support@farmerplatform.in',
                    'contact-info-2': 'হেল্পলাইন: +91 7393953233',
                    'form-label-name': 'নাম',
                    'form-label-email': 'ইমেইল',
                    'form-label-message': 'বার্তা',
                    'form-button-send': 'বার্তা পাঠান',
                    'footer-copyright': '© 2025 ডিজিটাল মার্কেটপ্লেস ও কৃষকদের জন্য লার্নিং প্ল্যাটফর্ম | সর্বস্বত্ব সংরক্ষিত',
                    'footer-visits': 'মোট ভিজিট: ',
                    'toast-success': 'বার্তা সফলভাবে পাঠানো হয়েছে! আমরা শীঘ্রই আপনার সাথে যোগাযোগ করব।',
                    'toast-error-fields': 'অনুগ্রহ করে মার্কেটপ্লেসের সব ক্ষেত্র সঠিকভাবে পূরণ করুন।',
                    'toast-error-image': 'বিক্রি করার আগে অনুগ্রহ করে পণ্যের একটি ছবি (স্টোরেজ বা ক্যামেরা থেকে) যোগ করুন।',
                    'toast-error-category': 'অনুগ্রহ করে একটি বিভাগ নির্বাচন করুন: সবজি, ফল, বীজ, বা সরঞ্জাম।',
                    'toast-error-search': 'অনুসন্ধান করতে পণ্যের নাম লিখুন।',
                    'alert-cart-add': (name) => `${name} কার্টে যোগ করা হয়েছে!`,
                    'alert-pay-success': (amount) => `₹${amount} পেমেন্ট সফল হয়েছে! আপনার কেনাকাটার জন্য ধন্যবাদ।`,
                    'alert-pay-processing': (amount) => `₹${amount} পেমেন্ট প্রক্রিয়াকরণ হচ্ছে...`,
                    'alert-search': (name) => `মার্কেটপ্লেসে "${name}" অনুসন্ধান করা হচ্ছে...`,
                    'alert-empty-cart': 'আপনার কার্ট খালি। পেমেন্ট করার কিছু নেই।',
                    'listen-label': 'শুনুন',
                    'steps-label': '✍️ অনুসরণ করার ধাপ:',
                    'toast-sold-out': (qty, name) => `${name}-এর মাত্র ${qty}টি ইউনিট উপলব্ধ।`
                }
            };

            function applyTranslation(lang) {
                if (!SUPPORTED_LANGS.includes(lang)) lang = 'en';
                currentLang = lang;
                body.setAttribute('lang', lang);
                langToggle.textContent = lang.toUpperCase();
                langToggle.setAttribute('aria-label', `Change language (current: ${LANG_LABELS[lang]})`);

                document.querySelectorAll('[data-key]').forEach(element => {
                    const key = element.getAttribute('data-key');
                    const text = translations[lang] && translations[lang][key];
                    if (text && typeof text === 'string') {
                        element.textContent = text;
                    }
                });

                
                        displayCart(); 
                        renderNotifications();

                const initialChatText = INITIAL_CHAT_TEXT[lang] || INITIAL_CHAT_TEXT.en;
                const initialChatBubble = document.querySelector('#chatHistory .chat-message.ai .message-bubble');
                if (initialChatBubble) {
                    initialChatBubble.textContent = initialChatText;
                }

                if (langMenu) {
                    langMenu.querySelectorAll('[data-lang]').forEach(btn => {
                        btn.classList.toggle('active', btn.getAttribute('data-lang') === lang);
                    });
                }

                stopPlayback();
            }

            // build lang dropdown from SUPPORTED_LANGS/LANG_LABELS
            const langMenu = document.getElementById('langMenu');
            if (langMenu) {
                langMenu.innerHTML = SUPPORTED_LANGS.map(code =>
                    `<button type="button" class="lang-menu-item" data-lang="${code}">${LANG_LABELS[code]}</button>`
                ).join('');

                langMenu.addEventListener('click', (e) => {
                    const btn = e.target.closest('[data-lang]');
                    if (!btn) return;
                    const newLang = btn.getAttribute('data-lang');
                    localStorage.setItem('language', newLang);
                    applyTranslation(newLang);
                    if (techniqueModal.classList.contains('visible')) {
                        openTechniqueModal(techniqueModal.getAttribute('data-topic'));
                    }
                    langMenu.classList.remove('open');
                });
            }

            langToggle.addEventListener('click', (e) => {
                e.stopPropagation();
                if (langMenu) langMenu.classList.toggle('open');
            });

            document.addEventListener('click', (e) => {
                if (langMenu && langMenu.classList.contains('open') && !langMenu.contains(e.target) && e.target !== langToggle) {
                    langMenu.classList.remove('open');
                }
            });

            const savedLang = localStorage.getItem('language') || 'en';
            applyTranslation(savedLang);

            // "tap to see easy guide" learning modal
            const learningGuides = {
                irrigation: {
                    courseNum: 1,
                    emoji: '💧',
                    diagram: ['🚰', '⚙️', '💧', '🌱'],
                    steps: [
                        { icon: '👉', en: 'Check your soil before watering — dig down about 2 inches; only water if it feels dry.', hi: 'पानी देने से पहले मिट्टी जांचें — करीब 2 इंच खोदकर देखें; अगर सूखी लगे तभी पानी दें।', ta: 'நீர் பாய்ச்சுவதற்கு முன் மண்ணை சரிபார்க்கவும் — சுமார் 2 அங்குலம் தோண்டிப் பாருங்கள்; உலர்ந்திருந்தால் மட்டும் நீர் பாய்ச்சவும்.', te: 'నీళ్లు పోసే ముందు మీ నేలను తనిఖీ చేయండి — దాదాపు 2 అంగుళాలు తవ్వి చూడండి; పొడిగా అనిపిస్తేనే నీళ్లు పోయండి.', bn: 'জল দেওয়ার আগে মাটি পরীক্ষা করুন — প্রায় ২ ইঞ্চি খুঁড়ে দেখুন; শুকনো মনে হলেই জল দিন।' },
                        { icon: '🚿', en: 'Install drip lines or micro-sprinklers along the crop rows instead of flooding the field.', hi: 'खेत में पानी भरने की जगह फसल की कतारों में ड्रिप लाइन या माइक्रो-स्प्रिंकलर लगाएं।', ta: 'வயலில் நீர் நிரப்புவதற்குப் பதிலாக பயிர் வரிசைகளில் சொட்டு நீர் குழாய்கள் அல்லது மைக்ரோ-ஸ்பிரிங்க்லர்களை பொருத்தவும்.', te: 'పొలాన్ని నీటితో నింపడానికి బదులుగా పంట వరుసల వెంట డ్రిప్ లైన్లు లేదా మైక్రో-స్ప్రింక్లర్లను అమర్చండి.', bn: 'জমি প্লাবিত করার পরিবর্তে ফসলের সারি বরাবর ড্রিপ লাইন বা মাইক্রো-স্প্রিংকলার বসান।' },
                        { icon: '⏰', en: 'Water early morning or evening to reduce loss from evaporation.', hi: 'वाष्पीकरण से बचाव के लिए सुबह जल्दी या शाम को पानी दें।', ta: 'ஆவியாதலால் ஏற்படும் இழப்பைக் குறைக்க அதிகாலை அல்லது மாலையில் நீர் பாய்ச்சவும்.', te: 'ఆవిరి కావడం వల్ల నష్టాన్ని తగ్గించడానికి ఉదయం లేదా సాయంత్రం నీళ్లు పోయండి.', bn: 'বাষ্পীভবনের কারণে ক্ষতি কমাতে ভোরে বা সন্ধ্যায় জল দিন।' },
                        { icon: '🔧', en: 'Check pipes and drip emitters every week for leaks or blockages.', hi: 'हर हफ्ते पाइप और ड्रिप एमिटर में रिसाव या रुकावट की जांच करें।', ta: 'கசிவு அல்லது அடைப்புகளுக்காக ஒவ்வொரு வாரமும் குழாய்கள் மற்றும் சொட்டு உமிழிகளை சரிபார்க்கவும்.', te: 'లీకేజీలు లేదా అడ్డంకుల కోసం ప్రతి వారం పైపులు మరియు డ్రిప్ ఎమిటర్లను తనిఖీ చేయండి.', bn: 'ফুটো বা বাধার জন্য প্রতি সপ্তাহে পাইপ এবং ড্রিপ এমিটার পরীক্ষা করুন।' },
                        { icon: '📊', en: 'Keep a simple weekly note of water used to see how much you are saving.', hi: 'बचत देखने के लिए हर हफ्ते इस्तेमाल हुए पानी का हिसाब रखें।', ta: 'எவ்வளவு சேமிக்கிறீர்கள் என்பதைப் பார்க்க பயன்படுத்தப்பட்ட நீரின் எளிய வாராந்திர குறிப்பை வைத்திருங்கள்.', te: 'మీరు ఎంత ఆదా చేస్తున్నారో చూడటానికి ఉపయోగించిన నీటి గురించి సాధారణ వారపు గమనిక ఉంచండి.', bn: 'কতটা সাশ্রয় হচ্ছে তা দেখতে ব্যবহৃত জলের একটি সহজ সাপ্তাহিক হিসাব রাখুন।' }
                    ],
                    tip: { en: 'Drip irrigation can cut water use by 40–60% compared to flood irrigation, while also improving crop yield.', hi: 'खेत में पानी भरने की तुलना में ड्रिप सिंचाई से 40–60% तक पानी बचता है और फसल की पैदावार भी बढ़ती है।', ta: 'வெள்ள நீர்ப்பாசனத்துடன் ஒப்பிடும்போது சொட்டு நீர்ப்பாசனம் 40–60% நீர் பயன்பாட்டைக் குறைக்கும், மேலும் பயிர் விளைச்சலையும் மேம்படுத்தும்.', te: 'వరద నీటిపారుదలతో పోలిస్తే డ్రిప్ ఇరిగేషన్ నీటి వినియోగాన్ని 40–60% తగ్గించగలదు, అలాగే పంట దిగుబడిని కూడా మెరుగుపరుస్తుంది.', bn: 'বন্যা সেচের তুলনায় ড্রিপ সেচ জলের ব্যবহার ৪০–৬০% কমাতে পারে, পাশাপাশি ফসলের ফলনও বাড়ায়।' }
                },
                organic: {
                    courseNum: 2,
                    emoji: '🌿',
                    diagram: ['🍂', '🪱', '🌱', '🥦'],
                    steps: [
                        { icon: '🍂', en: 'Start a compost pit with crop waste, dry leaves, and cow dung — turn it every 2 weeks.', hi: 'फसल अवशेष, सूखी पत्तियों और गोबर से खाद का गड्ढा बनाएं — हर 2 हफ्ते में पलटें।', ta: 'பயிர் கழிவு, உலர்ந்த இலைகள் மற்றும் சாணத்துடன் உரக்குழி தொடங்குங்கள் — ஒவ்வொரு 2 வாரங்களுக்கும் புரட்டவும்.', te: 'పంట వ్యర్థాలు, ఎండిన ఆకులు మరియు ఆవు పేడతో కంపోస్ట్ గుంట మొదలుపెట్టండి — ప్రతి 2 వారాలకు తిప్పండి.', bn: 'ফসলের বর্জ্য, শুকনো পাতা এবং গোবর দিয়ে একটি কম্পোস্ট গর্ত শুরু করুন — প্রতি ২ সপ্তাহে উল্টান।' },
                        { icon: '🪱', en: 'Use vermicompost or biofertilizers in place of chemical fertilizers.', hi: 'रासायनिक खाद की जगह वर्मीकम्पोस्ट या जैव-उर्वरक का उपयोग करें।', ta: 'ரசாயன உரங்களுக்குப் பதிலாக மண்புழு உரம் அல்லது உயிர்-உரங்களைப் பயன்படுத்துங்கள்.', te: 'రసాయన ఎరువులకు బదులుగా వర్మీకంపోస్ట్ లేదా జీవ ఎరువులను ఉపయోగించండి.', bn: 'রাসায়নিক সারের পরিবর্তে ভার্মিকম্পোস্ট বা জৈব সার ব্যবহার করুন।' },
                        { icon: '🌼', en: 'Rotate crops and try intercropping to keep the soil\'s nutrients balanced.', hi: 'मिट्टी के पोषक तत्व संतुलित रखने के लिए फसल चक्र और अंतर-फसल अपनाएं।', ta: 'மண்ணின் ஊட்டச்சத்துக்களை சமநிலையில் வைத்திருக்க பயிர் சுழற்சி மற்றும் இடைப்பயிரிடலை முயற்சிக்கவும்.', te: 'నేల పోషకాలను సమతుల్యంగా ఉంచడానికి పంట మార్పిడి మరియు అంతర పంటలను ప్రయత్నించండి.', bn: 'মাটির পুষ্টি সুষম রাখতে ফসল আবর্তন এবং আন্তঃফসল চেষ্টা করুন।' },
                        { icon: '🐞', en: 'Control pests with neem oil spray or companion planting instead of chemical pesticides.', hi: 'रासायनिक कीटनाशक की जगह नीम के तेल का छिड़काव या साथी-रोपण अपनाएं।', ta: 'ரசாயன பூச்சிக்கொல்லிகளுக்குப் பதிலாக வேப்ப எண்ணெய் தெளிப்பு அல்லது துணை-நடவு மூலம் பூச்சிகளைக் கட்டுப்படுத்துங்கள்.', te: 'రసాయన పురుగుమందులకు బదులుగా వేప నూనె స్ప్రే లేదా సహచర పెంపకంతో పురుగులను నియంత్రించండి.', bn: 'রাসায়নিক কীটনাশকের পরিবর্তে নিম তেল স্প্রে বা সহচর রোপণের মাধ্যমে পোকা নিয়ন্ত্রণ করুন।' },
                        { icon: '📜', en: 'Once your field stays chemical-free for the required period, apply for organic certification to sell at better prices.', hi: 'खेत पूरी तरह रसायन-मुक्त होने के बाद बेहतर दाम पाने के लिए ऑर्गेनिक प्रमाणन के लिए आवेदन करें।', ta: 'உங்கள் வயல் தேவையான காலத்திற்கு ரசாயனமில்லாமல் இருந்தவுடன், சிறந்த விலைக்கு விற்க கரிம சான்றிதழுக்கு விண்ணப்பிக்கவும்.', te: 'మీ పొలం అవసరమైన కాలం పాటు రసాయన రహితంగా ఉన్న తర్వాత, మెరుగైన ధరలకు అమ్మడానికి సేంద్రీయ ధృవీకరణ కోసం దరఖాస్తు చేసుకోండి.', bn: 'আপনার জমি প্রয়োজনীয় সময়ের জন্য রাসায়নিকমুক্ত থাকলে, ভালো দামে বিক্রির জন্য জৈব সার্টিফিকেশনের জন্য আবেদন করুন।' }
                    ],
                    tip: { en: 'Healthy, organic-rich soil holds more water and needs fewer inputs season after season.', hi: 'जैविक तत्वों से भरपूर स्वस्थ मिट्टी अधिक पानी रोकती है और हर मौसम में कम खाद-दवा की जरूरत पड़ती है।', ta: 'ஆரோக்கியமான, கரிமச்சத்து நிறைந்த மண் அதிக நீரைத் தக்கவைத்து, ஒவ்வொரு பருவத்திலும் குறைவான உள்ளீடுகளைத் தேவைப்படுத்தும்.', te: 'ఆరోగ్యకరమైన, సేంద్రీయ సమృద్ధిగల నేల ఎక్కువ నీటిని పట్టుకుంటుంది మరియు ప్రతి సీజన్‌లో తక్కువ ఇన్‌పుట్‌లు అవసరం.', bn: 'স্বাস্থ্যকর, জৈব-সমৃদ্ধ মাটি বেশি জল ধরে রাখে এবং মৌসুমের পর মৌসুম কম উপকরণের প্রয়োজন হয়।' }
                },
                insurance: {
                    courseNum: 3,
                    emoji: '🛡️',
                    diagram: ['🌾', '⚠️', '🛡️', '💰'],
                    steps: [
                        { icon: '📝', en: 'Enroll in Pradhan Mantri Fasal Bima Yojana (PMFBY) before the cut-off date for your crop season.', hi: 'अपने फसल सीजन की अंतिम तिथि से पहले प्रधानमंत्री फसल बीमा योजना (PMFBY) में नामांकन करें।', ta: 'உங்கள் பயிர் பருவத்தின் கடைசி தேதிக்கு முன் பிரதான் மந்திரி பசல் பீமா யோஜனாவில் (PMFBY) பதிவு செய்யுங்கள்.', te: 'మీ పంట సీజన్ చివరి తేదీకి ముందు ప్రధాన మంత్రి ఫసల్ బీమా యోజన (PMFBY)లో నమోదు చేసుకోండి.', bn: 'আপনার ফসলের মৌসুমের শেষ তারিখের আগে প্রধানমন্ত্রী ফসল বীমা যোজনায় (PMFBY) নথিভুক্ত করুন।' },
                        { icon: '🏦', en: 'You pay only a small share of the premium — the government covers the rest.', hi: 'आपको प्रीमियम का बहुत छोटा हिस्सा ही देना होता है — बाकी सरकार वहन करती है।', ta: 'நீங்கள் பிரீமியத்தில் ஒரு சிறிய பங்கை மட்டுமே செலுத்துகிறீர்கள் — மீதமுள்ளதை அரசு ஏற்கிறது.', te: 'మీరు ప్రీమియంలో కేవలం చిన్న భాగాన్ని మాత్రమే చెల్లిస్తారు — మిగిలినది ప్రభుత్వం భరిస్తుంది.', bn: 'আপনি প্রিমিয়ামের শুধু একটি ছোট অংশ প্রদান করেন — বাকিটা সরকার বহন করে।' },
                        { icon: '🌪️', en: 'If your crop is damaged by drought, flood, pests, or disease, report it to your bank or insurer within 72 hours.', hi: 'सूखा, बाढ़, कीट या रोग से फसल खराब होने पर 72 घंटे के अंदर बैंक या बीमा कंपनी को सूचित करें।', ta: 'வறட்சி, வெள்ளம், பூச்சி அல்லது நோயால் உங்கள் பயிர் சேதமடைந்தால், 72 மணி நேரத்திற்குள் உங்கள் வங்கி அல்லது காப்பீட்டாளரிடம் தெரிவிக்கவும்.', te: 'కరువు, వరద, పురుగులు లేదా వ్యాధి వల్ల మీ పంట దెబ్బతింటే, 72 గంటల్లోపు మీ బ్యాంకుకు లేదా బీమా సంస్థకు తెలియజేయండి.', bn: 'খরা, বন্যা, পোকামাকড় বা রোগে আপনার ফসল ক্ষতিগ্রস্ত হলে, ৭২ ঘণ্টার মধ্যে আপনার ব্যাংক বা বীমাকারীকে জানান।' },
                        { icon: '📸', en: 'Take clear photos of the damaged field as proof when you report the loss.', hi: 'नुकसान की सूचना देते समय खराब फसल की स्पष्ट तस्वीरें सबूत के तौर पर लें।', ta: 'இழப்பைப் புகாரளிக்கும்போது சேதமடைந்த வயலின் தெளிவான புகைப்படங்களை ஆதாரமாக எடுக்கவும்.', te: 'నష్టాన్ని నివేదించేటప్పుడు దెబ్బతిన్న పొలం యొక్క స్పష్టమైన ఫోటోలను రుజువుగా తీయండి.', bn: 'ক্ষতির প্রতিবেদন করার সময় ক্ষতিগ্রস্ত জমির স্পষ্ট ছবি প্রমাণ হিসেবে তুলুন।' },
                        { icon: '💵', en: 'After assessment, the claim amount is usually paid directly into your linked bank account.', hi: 'आकलन के बाद दावे की राशि आमतौर पर सीधे आपके जुड़े बैंक खाते में भेजी जाती है।', ta: 'மதிப்பீட்டிற்குப் பிறகு, உரிமைகோரல் தொகை பொதுவாக உங்கள் இணைக்கப்பட்ட வங்கிக் கணக்கில் நேரடியாக செலுத்தப்படும்.', te: 'మదింపు తర్వాత, క్లెయిమ్ మొత్తం సాధారణంగా మీ లింక్ చేసిన బ్యాంకు ఖాతాలో నేరుగా చెల్లించబడుతుంది.', bn: 'মূল্যায়নের পর, দাবির পরিমাণ সাধারণত সরাসরি আপনার সংযুক্ত ব্যাংক অ্যাকাউন্টে প্রদান করা হয়।' }
                    ],
                    tip: { en: 'Keep your Aadhaar, land records, and bank details updated — mismatched details are the most common reason claims get delayed.', hi: 'अपना आधार, भूमि रिकॉर्ड और बैंक विवरण अपडेट रखें — जानकारी न मिलने से ही ज़्यादातर दावों में देरी होती है।', ta: 'உங்கள் ஆதார், நில பதிவுகள் மற்றும் வங்கி விவரங்களை புதுப்பித்து வைத்திருங்கள் — பொருந்தாத விவரங்களே உரிமைகோரல் தாமதத்திற்கு பொதுவான காரணம்.', te: 'మీ ఆధార్, భూమి రికార్డులు మరియు బ్యాంకు వివరాలను తాజాగా ఉంచుకోండి — సరిపోలని వివరాలే క్లెయిమ్‌లు ఆలస్యం కావడానికి అత్యంత సాధారణ కారణం.', bn: 'আপনার আধার, জমির রেকর্ড এবং ব্যাংক বিবরণ আপডেট রাখুন — অমিল বিবরণই দাবি বিলম্বের সবচেয়ে সাধারণ কারণ।' }
                },
                cloud: {
                    courseNum: 4,
                    emoji: '☁️',
                    diagram: ['📱', '☁️', '📊', '🎓'],
                    steps: [
                        { icon: '📱', en: 'Use a smartphone or your nearest CSC (Common Service Centre) to access government agri-portals and apps.', hi: 'सरकारी कृषि पोर्टल और ऐप तक पहुंचने के लिए स्मार्टफोन या नज़दीकी CSC (कॉमन सर्विस सेंटर) का उपयोग करें।', ta: 'அரசு வேளாண் போர்டல்கள் மற்றும் ஆப்ஸை அணுக ஸ்மார்ட்போன் அல்லது உங்களுக்கு அருகிலுள்ள CSC (பொது சேவை மையம்) பயன்படுத்துங்கள்.', te: 'ప్రభుత్వ వ్యవసాయ పోర్టల్‌లు మరియు యాప్‌లను యాక్సెస్ చేయడానికి స్మార్ట్‌ఫోన్ లేదా మీకు దగ్గరలోని CSC (కామన్ సర్వీస్ సెంటర్) ఉపయోగించండి.', bn: 'সরকারি কৃষি পোর্টাল ও অ্যাপ ব্যবহার করতে স্মার্টফোন বা আপনার নিকটতম CSC (কমন সার্ভিস সেন্টার) ব্যবহার করুন।' },
                        { icon: '☁️', en: 'Save your soil health reports, insurance papers, and land records online so they are never lost.', hi: 'मिट्टी स्वास्थ्य रिपोर्ट, बीमा कागज़ात और भूमि रिकॉर्ड को ऑनलाइन सुरक्षित रखें ताकि वे कभी न खोएं।', ta: 'உங்கள் மண் ஆரோக்கிய அறிக்கைகள், காப்பீட்டு ஆவணங்கள் மற்றும் நில பதிவுகளை ஆன்லைனில் சேமித்து வையுங்கள், அவை ஒருபோதும் தொலைந்துவிடாது.', te: 'మీ నేల ఆరోగ్య నివేదికలు, బీమా పత్రాలు మరియు భూమి రికార్డులను ఆన్‌లైన్‌లో సేవ్ చేయండి, తద్వారా అవి ఎప్పటికీ పోవు.', bn: 'আপনার মাটির স্বাস্থ্য প্রতিবেদন, বীমার কাগজপত্র এবং জমির রেকর্ড অনলাইনে সংরক্ষণ করুন যাতে সেগুলো কখনো হারিয়ে না যায়।' },
                        { icon: '📊', en: 'Check mandi (market) prices online before deciding when and where to sell your produce.', hi: 'उपज कब और कहां बेचनी है, यह तय करने से पहले मंडी के भाव ऑनलाइन जांच लें।', ta: 'உங்கள் விளைபொருளை எப்போது, எங்கு விற்பது என்பதை முடிவு செய்யும் முன் மண்டி (சந்தை) விலைகளை ஆன்லைனில் சரிபார்க்கவும்.', te: 'మీ ఉత్పత్తిని ఎప్పుడు, ఎక్కడ అమ్మాలో నిర్ణయించే ముందు మండి (మార్కెట్) ధరలను ఆన్‌లైన్‌లో తనిఖీ చేయండి.', bn: 'আপনার ফসল কখন এবং কোথায় বিক্রি করবেন তা ঠিক করার আগে অনলাইনে মান্ডি (বাজার) দাম পরীক্ষা করুন।' },
                        { icon: '🎓', en: 'Watch free e-learning videos and webinars from agricultural universities (KVK) to learn new techniques.', hi: 'नई तकनीकें सीखने के लिए कृषि विश्वविद्यालयों (KVK) के मुफ्त ई-लर्निंग वीडियो और वेबिनार देखें।', ta: 'புதிய நுட்பங்களைக் கற்க வேளாண் பல்கலைக்கழகங்களின் (KVK) இலவச இ-கற்றல் வீடியோக்கள் மற்றும் வெபினார்களைப் பாருங்கள்.', te: 'కొత్త పద్ధతులను నేర్చుకోవడానికి వ్యవసాయ విశ్వవిద్యాలయాల (KVK) ఉచిత ఇ-లెర్నింగ్ వీడియోలు మరియు వెబినార్‌లను చూడండి.', bn: 'নতুন কৌশল শিখতে কৃষি বিশ্ববিদ্যালয়ের (KVK) বিনামূল্যে ই-লার্নিং ভিডিও এবং ওয়েবিনার দেখুন।' },
                        { icon: '🔔', en: 'Turn on SMS or app alerts for weather warnings and scheme deadlines.', hi: 'मौसम की चेतावनी और योजनाओं की अंतिम तिथि के लिए SMS या ऐप अलर्ट चालू करें।', ta: 'வானிலை எச்சரிக்கைகள் மற்றும் திட்ட காலக்கெடுவுக்கான SMS அல்லது ஆப் அறிவிப்புகளை இயக்கவும்.', te: 'వాతావరణ హెచ్చరికలు మరియు పథకం గడువుల కోసం SMS లేదా యాప్ అలర్ట్‌లను ఆన్ చేయండి.', bn: 'আবহাওয়ার সতর্কতা এবং প্রকল্পের শেষ তারিখের জন্য SMS বা অ্যাপ অ্যালার্ট চালু করুন।' }
                    ],
                    tip: { en: 'A free app like Kisan Suvidha or eNAM puts market prices and weather alerts right in your pocket.', hi: 'किसान सुविधा या ई-नाम जैसे मुफ्त ऐप से बाज़ार भाव और मौसम अलर्ट सीधे आपकी जेब में मिलते हैं।', ta: 'கிசான் சுவிதா அல்லது eNAM போன்ற இலவச ஆப் சந்தை விலைகள் மற்றும் வானிலை எச்சரிக்கைகளை உங்கள் பாக்கெட்டிலேயே தருகிறது.', te: 'కిసాన్ సువిధ లేదా eNAM వంటి ఉచిత యాప్ మార్కెట్ ధరలు మరియు వాతావరణ హెచ్చరికలను నేరుగా మీ జేబులో ఉంచుతుంది.', bn: 'কিষান সুবিধা বা eNAM-এর মতো একটি বিনামূল্যের অ্যাপ বাজারের দাম এবং আবহাওয়ার সতর্কতা সরাসরি আপনার পকেটে নিয়ে আসে।' }
                }
            };

            const techniqueOverlay = document.getElementById('techniqueOverlay');
            const techniqueModal = document.getElementById('techniqueModal');
            const techniqueEmoji = document.getElementById('techniqueEmoji');
            const techniqueModalTitle = document.getElementById('techniqueModalTitle');
            const techniqueDiagram = document.getElementById('techniqueDiagram');
            const techniqueSteps = document.getElementById('techniqueSteps');
            const techniqueTip = document.getElementById('techniqueTip');
            const techniqueListenBtn = document.getElementById('techniqueListenBtn');

            function openTechniqueModal(topic) {
                const guide = learningGuides[topic];
                if (!guide) return;

                techniqueEmoji.textContent = guide.emoji;
                techniqueModalTitle.textContent = translations[currentLang][`course-${guide.courseNum}-title`];

                techniqueDiagram.innerHTML = guide.diagram
                    .map((node, i) => `<div class="diagram-node">${node}</div>` + (i < guide.diagram.length - 1 ? `<span class="diagram-arrow">→</span>` : ''))
                    .join('');

                techniqueSteps.innerHTML = guide.steps
                    .map((step, i) => `
                        <div class="technique-step">
                            <span class="step-num">${i + 1}</span>
                            <span class="step-icon">${step.icon}</span>
                            <span>${step[currentLang] || step.en}</span>
                        </div>
                    `).join('');

                techniqueTip.textContent = '💡 ' + (guide.tip[currentLang] || guide.tip.en);

                techniqueModal.setAttribute('data-topic', topic);
                techniqueOverlay.classList.add('visible');
                techniqueModal.classList.add('visible');
                document.body.style.overflow = 'hidden';
            }

            window.closeTechniqueModal = function () {
                stopPlayback();
                techniqueOverlay.classList.remove('visible');
                techniqueModal.classList.remove('visible');
                document.body.style.overflow = '';
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

            techniqueListenBtn.addEventListener('click', () => {
                if (techniqueListenBtn.classList.contains('speaking')) {
                    stopPlayback();
                    return;
                } else if (!audioEl.paused) {
                    stopPlayback();
                }

                let content = '';
                techniqueModal.querySelectorAll('h3, .technique-step, .technique-tip').forEach(el => {
                    content += el.textContent.trim() + '. ';
                });
                speakText(techniqueListenBtn, content);
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

            const sellImageInput = document.getElementById('sellImage');
            const sellImagePreview = document.getElementById('sellImagePreview');
            let sellImageDataUrl = '';

            sellImageInput.addEventListener('change', async () => {
                const file = sellImageInput.files[0];
                if (!file) {
                    sellImageDataUrl = '';
                    sellImagePreview.style.display = 'none';
                    return;
                }
                try {
                    // compress so it fits firestore's 1mb limit
                    sellImageDataUrl = await compressImageFile(file);
                    sellImagePreview.src = sellImageDataUrl;
                    sellImagePreview.style.display = 'block';
                } catch (err) {
                    console.error('Failed to process image:', err);
                    showToast('Could not process that photo. Please try a different image.', false);
                    sellImageDataUrl = '';
                    sellImagePreview.style.display = 'none';
                }
            });

            sellButton.addEventListener('click', function () {
                const name = document.getElementById('sellName').value.trim();
                const qty = document.getElementById('sellQty').value;
                const price = document.getElementById('sellPrice').value;
                const category = document.getElementById('sellCategory').value;
                if (!ALLOWED_PRODUCT_CATEGORIES.includes(category)) {
                    showToast(translations[currentLang]['toast-error-category'], false);
                    return;
                }
                if (!sellImageDataUrl) {
                    showToast(translations[currentLang]['toast-error-image'], false);
                    return;
                }
                addProductListing(name, qty, price, sellImageDataUrl, category);
                document.getElementById('sellName').value = "";
                document.getElementById('sellQty').value = "";
                document.getElementById('sellPrice').value = "";
                document.getElementById('sellCategory').value = "";
                sellImageInput.value = "";
                sellImageDataUrl = '';
                sellImagePreview.style.display = 'none';
                sellImagePreview.src = '';
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
            const drawerImageLabel = document.getElementById('drawerImageLabel');
            const drawerImageInput = document.getElementById('drawerImage');
            const drawerImagePreview = document.getElementById('drawerImagePreview');
            const drawerCategoryLabel = document.getElementById('drawerCategoryLabel');
            const drawerCategorySelect = document.getElementById('drawerCategory');
            let drawerImageDataUrl = '';

            drawerImageInput.addEventListener('change', async () => {
                const file = drawerImageInput.files[0];
                if (!file) {
                    drawerImageDataUrl = '';
                    drawerImagePreview.style.display = 'none';
                    return;
                }
                try {
                    drawerImageDataUrl = await compressImageFile(file);
                    drawerImagePreview.src = drawerImageDataUrl;
                    drawerImagePreview.style.display = 'block';
                } catch (err) {
                    console.error('Failed to process image:', err);
                    showToast('Could not process that photo. Please try a different image.', false);
                    drawerImageDataUrl = '';
                    drawerImagePreview.style.display = 'none';
                }
            });

            function openDrawer(type) {
                const isBuy = type === 'buy';
                drawerTitle.textContent = isBuy ? 'Quick Buy Product' : 'Quick Sell Product';
                drawerInstruction.textContent = isBuy 
                    ? 'Enter the product you want to buy and add it to your cart (mock transaction).'
                    : 'Enter the product you want to sell, set a price, and add a photo (mock listing).';
                
                drawerPriceInput.style.display = isBuy ? 'none' : 'block';
                drawerCategoryLabel.style.display = isBuy ? 'none' : 'block';
                drawerCategorySelect.style.display = isBuy ? 'none' : 'block';
                drawerImageLabel.style.display = isBuy ? 'none' : 'block';
                drawerImageInput.style.display = isBuy ? 'none' : 'block';
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
                drawerCategorySelect.value = '';
                drawerImageInput.value = '';
                drawerImageDataUrl = '';
                drawerImagePreview.style.display = 'none';
                drawerImagePreview.src = '';
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

                if (type === 'sell') {
                    const price = document.getElementById('drawerPrice').value;
                    const category = drawerCategorySelect.value;
                    if (isNaN(price) || parseFloat(price) <= 0) {
                        showToast("Please enter a valid price to sell.", false);
                        return;
                    }
                    if (!ALLOWED_PRODUCT_CATEGORIES.includes(category)) {
                        showToast(translations[currentLang]['toast-error-category'], false);
                        return;
                    }
                    if (!drawerImageDataUrl) {
                        showToast(translations[currentLang]['toast-error-image'], false);
                        return;
                    }
                    addProductListing(name, qty, price, drawerImageDataUrl, category);
                } else {
                    const price = 100; // Default price for mock buy
                    addToCart(name, qty, price);
                }

                closeDrawer();
            });
        });
