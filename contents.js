const API_KEY = ""; 

/* =====================================================================
   GOOGLE SIGN-IN SETUP
   -------------------------------------------------------------------
   To turn on "Continue with Google":
   1. Go to https://console.cloud.google.com/apis/credentials
   2. Create an OAuth 2.0 Client ID (type: "Web application")
   3. Under "Authorized JavaScript origins", add the exact URL(s) this
      site will be served from (e.g. https://your-site.com — no
      trailing slash; add http://localhost:PORT too if testing locally)
   4. Paste the Client ID below, replacing the placeholder.
   Until a real Client ID is set, the Google buttons stay hidden and
   the rest of the login flow (name/place/address) works as before.
   ===================================================================== */
const GOOGLE_CLIENT_ID = "1007423755384-3v07pfaoaq16r6mc2dsfdtr6aiv0so40.apps.googleusercontent.com";


        
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
            const PRODUCTS_STORAGE_KEY = 'agriProductListings';
            const NOTIF_STORAGE_KEY = 'agriFarmerNotifications';
            // Declared early so functions that read it (e.g. renderNotifications, called from
            // initAuth on page load) never run before it's initialized.
            let currentLang = 'en';

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
            }

            function initials(name) {
                return (name || '').trim().split(/\s+/).slice(0, 2).map(w => w[0] ? w[0].toUpperCase() : '').join('');
            }

            function updateWelcomeAndProfile(user) {
                if (user.role === 'farmer') {
                    welcomeBannerEl.innerHTML = `Welcome Farmer ${user.name} <i class="fa-solid fa-seedling"></i>`;
                    profileRoleEl.textContent = 'Farmer' + (user.place ? ' · ' + user.place : '');
                } else {
                    welcomeBannerEl.innerHTML = `Welcome ${user.name} <i class="fa-solid fa-basket-shopping"></i>`;
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
                            return;
                        }
                    } catch (e) {
                        console.error('Could not parse saved profile', e);
                    }
                }
                // Not logged in yet — keep the login overlay up and lock background scroll
                document.body.style.overflow = 'hidden';
            }

            initAuth();
            /* ================= END AUTH / LOGIN SYSTEM ================= */

            /* ===================================================== */
            /* GOOGLE SIGN-IN — "Continue with Google" on login forms */
            /* ===================================================== */
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
                    // No real Client ID configured yet — leave the slots empty.
                    // (CSS hides the "or continue with Google" divider automatically.)
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
            /* ================= END GOOGLE SIGN-IN ================= */

            /* ===================================================== */
            /* PRODUCT LISTINGS — Farmer lists, Buyer browses/buys   */
            /* ===================================================== */
            function loadProductListings() {
                try {
                    return JSON.parse(localStorage.getItem(PRODUCTS_STORAGE_KEY)) || [];
                } catch (e) {
                    return [];
                }
            }

            function saveProductListings(products) {
                localStorage.setItem(PRODUCTS_STORAGE_KEY, JSON.stringify(products));
            }

            function addProductListing(name, qty, price, imageDataUrl) {
                if (!currentUser || currentUser.role !== 'farmer') return;
                if (!name || isNaN(qty) || qty <= 0 || isNaN(price) || price <= 0) {
                    showToast(translations[currentLang]['toast-error-fields'], false);
                    return;
                }
                if (!imageDataUrl) {
                    showToast(translations[currentLang]['toast-error-image'], false);
                    return;
                }
                const products = loadProductListings();
                products.push({
                    id: Date.now() + Math.random().toString(16).slice(2),
                    name,
                    qty: parseInt(qty),
                    price: parseFloat(price),
                    farmerName: currentUser.name,
                    farmerPlace: currentUser.place || '',
                    image: imageDataUrl
                });
                saveProductListings(products);
                renderProductListings();
                showToast(`${name} has been listed for sale!`, true);
            }

            window.removeProductListing = function (id) {
                const products = loadProductListings().filter(p => p.id !== id);
                saveProductListings(products);
                renderProductListings();
                showToast('Listing removed.', true);
            };

            window.buyProductListing = function (id) {
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

                // Reduce the remaining stock by the quantity bought
                product.qty -= requestedQty;
                saveProductListings(products);
                renderProductListings();

                const buyerName = (currentUser && currentUser.name) ? currentUser.name : 'A buyer';
                const unitWordEn = requestedQty > 1 ? 'units' : 'unit';
                addFarmerNotification(
                    product.farmerName,
                    `${buyerName} bought ${requestedQty} ${unitWordEn} of your ${product.name}.`,
                    `${buyerName} ने आपके ${product.name} की ${requestedQty} इकाइयाँ खरीदीं।`
                );

                addToCart(product.name, requestedQty, product.price, product.id);
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
                        myListingsItems.innerHTML = mine.map(p => `
                            <div class="listing-item">
                                <div class="listing-item-content">
                                    ${p.image ? `<img src="${p.image}" alt="${p.name}" class="listing-item-thumb">` : ''}
                                    <span><strong>${p.name}</strong> — ${p.qty > 0 ? `${p.qty} units left` : `<span style="color:#d32f2f;">Sold Out</span>`} × ₹${p.price.toFixed(2)}</span>
                                </div>
                                <button class="remove-btn" onclick="removeProductListing('${p.id}')"><i class="fas fa-trash-alt"></i> Remove</button>
                            </div>
                        `).join('');
                    }
                }

                const availableProductsItems = document.getElementById('availableProductsItems');
                if (availableProductsItems) {
                    if (products.length === 0) {
                        availableProductsItems.innerHTML = `<p>No products listed yet. Check back soon!</p>`;
                    } else {
                        availableProductsItems.innerHTML = products.map(p => `
                            <div class="listing-item">
                                <div class="listing-item-content">
                                    ${p.image ? `<img src="${p.image}" alt="${p.name}" class="listing-item-thumb">` : ''}
                                    <span><strong>${p.name}</strong> — ${p.qty > 0 ? `${p.qty} units available` : `<span style="color:#d32f2f;">Sold Out</span>`} × ₹${p.price.toFixed(2)}<br>
                                    <small>Sold by ${p.farmerName}${p.farmerPlace ? ', ' + p.farmerPlace : ''}</small></span>
                                </div>
                                ${p.qty > 0 ? `
                                <div class="buy-controls" style="display:flex;align-items:center;gap:8px;">
                                    <input type="number" id="buyQty-${p.id}" min="1" max="${p.qty}" value="1" aria-label="Quantity to buy" style="width:60px;padding:6px;border-radius:4px;border:1px solid var(--color-card-border); background: var(--color-card-bg); color: var(--color-text);">
                                    <button onclick="buyProductListing('${p.id}')"><i class="fas fa-cart-plus"></i> Add to Cart</button>
                                </div>` : ''}
                            </div>
                        `).join('');
                    }
                }
            }
            /* ================= END PRODUCT LISTINGS ================= */

            /* ===================================================== */
            /* FARMER NOTIFICATIONS — alert when a buyer buys         */
            /* ===================================================== */
            const notifBellContainer = document.getElementById('notifBellContainer');
            const notifBellBtn = document.getElementById('notifBellBtn');
            const notifBadge = document.getElementById('notifBadge');
            const notifDropdown = document.getElementById('notifDropdown');

            function loadNotifications() {
                try {
                    return JSON.parse(localStorage.getItem(NOTIF_STORAGE_KEY)) || {};
                } catch (e) {
                    return {};
                }
            }

            function saveNotifications(data) {
                localStorage.setItem(NOTIF_STORAGE_KEY, JSON.stringify(data));
            }

            function addFarmerNotification(farmerName, textEn, textHi) {
                const all = loadNotifications();
                if (!all[farmerName]) all[farmerName] = [];
                all[farmerName].unshift({
                    id: Date.now() + Math.random().toString(16).slice(2),
                    en: textEn,
                    hi: textHi,
                    time: Date.now(),
                    read: false
                });
                saveNotifications(all);
                if (currentUser && currentUser.role === 'farmer' && currentUser.name === farmerName) {
                    renderNotifications();
                }
            }

            function timeAgo(ts) {
                const diff = Math.floor((Date.now() - ts) / 1000);
                const isHi = currentLang === 'hi';
                if (diff < 60) return isHi ? 'अभी' : 'just now';
                if (diff < 3600) { const m = Math.floor(diff / 60); return isHi ? `${m} मिनट पहले` : `${m} min ago`; }
                if (diff < 86400) { const h = Math.floor(diff / 3600); return isHi ? `${h} घंटे पहले` : `${h} hr ago`; }
                const d = Math.floor(diff / 86400);
                return isHi ? `${d} दिन पहले` : `${d} day(s) ago`;
            }

            function renderNotifications() {
                if (!notifBellContainer) return;
                if (!currentUser || currentUser.role !== 'farmer') {
                    notifBadge.style.display = 'none';
                    return;
                }
                const all = loadNotifications();
                const mine = all[currentUser.name] || [];
                const unreadCount = mine.filter(n => !n.read).length;

                notifBadge.textContent = unreadCount > 9 ? '9+' : unreadCount;
                notifBadge.style.display = unreadCount > 0 ? 'flex' : 'none';

                if (mine.length === 0) {
                    notifDropdown.innerHTML = `<p class="notif-empty">${currentLang === 'hi' ? 'अभी तक कोई सूचना नहीं।' : 'No notifications yet.'}</p>`;
                } else {
                    notifDropdown.innerHTML = mine.map(n => `
                        <div class="notif-item ${n.read ? '' : 'unread'}">
                            ${currentLang === 'hi' ? n.hi : n.en}
                            <span class="notif-time">${timeAgo(n.time)}</span>
                        </div>
                    `).join('');
                }
            }

            function markFarmerNotificationsRead() {
                if (!currentUser || currentUser.role !== 'farmer') return;
                const all = loadNotifications();
                const mine = all[currentUser.name] || [];
                if (mine.length === 0) return;
                mine.forEach(n => n.read = true);
                all[currentUser.name] = mine;
                saveNotifications(all);
            }

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
            /* ================= END FARMER NOTIFICATIONS ================= */


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

            function addToCart(name, qty, price, productId = null) {
                if (!name || isNaN(qty) || qty <= 0 || isNaN(price) || price <= 0) {
                    showToast(translations[currentLang]['toast-error-fields'], false);
                    return;
                }
                cart.push({ name, qty: parseInt(qty), price: parseFloat(price), productId });
                showToast(translations[currentLang]['alert-cart-add'](name), true);
                displayCart();
            }
            window.removeItem = function (index) {
                const item = cart[index];
                // Give the stock back to the listing if this item came from a real product listing
                if (item && item.productId) {
                    const products = loadProductListings();
                    const product = products.find(p => p.id === item.productId);
                    if (product) {
                        product.qty += item.qty;
                        saveProductListings(products);
                        renderProductListings();
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
                const listenBtn = document.getElementById('techniqueListenBtn');
                if (listenBtn) {
                    listenBtn.classList.remove('speaking');
                    listenBtn.innerHTML = `<i class="fas fa-volume-up"></i> <span id="listenLabel" data-key="listen-label">${(translations[currentLang] && translations[currentLang]['listen-label']) || 'Listen'}</span>`;
                }
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
                    'sell-image-label': 'Add a Photo of the Vegetable (required) 📷',
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
                    'toast-error-image': 'Please add a photo of the vegetable (from storage or camera) before selling.',
                    'toast-error-search': 'Please enter a product name to search.',
                    'toast-error-listing': 'Please enter a product name and some key points for the listing generator.',
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
                    'sell-image-label': 'सब्ज़ी की फोटो जोड़ें (आवश्यक) 📷',
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
                    'toast-error-image': 'बिक्री से पहले कृपया सब्ज़ी की फोटो जोड़ें (स्टोरेज या कैमरे से)।',
                    'toast-error-search': 'कृपया खोज के लिए उत्पाद का नाम दर्ज करें।',
                    'toast-error-listing': 'कृपया लिस्टिंग जनरेटर के लिए उत्पाद का नाम और कुछ मुख्य बिंदु दर्ज करें।',
                    'alert-cart-add': (name) => `${name} कार्ट में जोड़ा गया!`,
                    'alert-pay-success': (amount) => `₹${amount} का भुगतान सफल रहा! आपकी खरीद के लिए धन्यवाद।`,
                    'alert-pay-processing': (amount) => `₹${amount} का भुगतान संसाधित हो रहा है...`,
                    'alert-empty-cart': 'आपका कार्ट खाली है। भुगतान करने के लिए कुछ भी नहीं है।',
                    'listen-label': 'सुनें',
                    'steps-label': '✍️ अपनाए जाने वाले कदम:',
                    'toast-sold-out': (qty, name) => `${name} की केवल ${qty} इकाइयाँ उपलब्ध हैं।`
                }
            };

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
                        renderNotifications();

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
                if (techniqueModal.classList.contains('visible')) {
                    openTechniqueModal(techniqueModal.getAttribute('data-topic'));
                }
            });

            /* ===================================================== */
            /* EASY LEARNING GUIDE MODAL — "Tap to see easy guide"   */
            /* ===================================================== */
            const learningGuides = {
                irrigation: {
                    courseNum: 1,
                    emoji: '💧',
                    diagram: ['🚰', '⚙️', '💧', '🌱'],
                    steps: [
                        { icon: '👉', en: 'Check your soil before watering — dig down about 2 inches; only water if it feels dry.', hi: 'पानी देने से पहले मिट्टी जांचें — करीब 2 इंच खोदकर देखें; अगर सूखी लगे तभी पानी दें।' },
                        { icon: '🚿', en: 'Install drip lines or micro-sprinklers along the crop rows instead of flooding the field.', hi: 'खेत में पानी भरने की जगह फसल की कतारों में ड्रिप लाइन या माइक्रो-स्प्रिंकलर लगाएं।' },
                        { icon: '⏰', en: 'Water early morning or evening to reduce loss from evaporation.', hi: 'वाष्पीकरण से बचाव के लिए सुबह जल्दी या शाम को पानी दें।' },
                        { icon: '🔧', en: 'Check pipes and drip emitters every week for leaks or blockages.', hi: 'हर हफ्ते पाइप और ड्रिप एमिटर में रिसाव या रुकावट की जांच करें।' },
                        { icon: '📊', en: 'Keep a simple weekly note of water used to see how much you are saving.', hi: 'बचत देखने के लिए हर हफ्ते इस्तेमाल हुए पानी का हिसाब रखें।' }
                    ],
                    tip: { en: 'Drip irrigation can cut water use by 40–60% compared to flood irrigation, while also improving crop yield.', hi: 'खेत में पानी भरने की तुलना में ड्रिप सिंचाई से 40–60% तक पानी बचता है और फसल की पैदावार भी बढ़ती है।' }
                },
                organic: {
                    courseNum: 2,
                    emoji: '🌿',
                    diagram: ['🍂', '🪱', '🌱', '🥦'],
                    steps: [
                        { icon: '🍂', en: 'Start a compost pit with crop waste, dry leaves, and cow dung — turn it every 2 weeks.', hi: 'फसल अवशेष, सूखी पत्तियों और गोबर से खाद का गड्ढा बनाएं — हर 2 हफ्ते में पलटें।' },
                        { icon: '🪱', en: 'Use vermicompost or biofertilizers in place of chemical fertilizers.', hi: 'रासायनिक खाद की जगह वर्मीकम्पोस्ट या जैव-उर्वरक का उपयोग करें।' },
                        { icon: '🌼', en: 'Rotate crops and try intercropping to keep the soil\'s nutrients balanced.', hi: 'मिट्टी के पोषक तत्व संतुलित रखने के लिए फसल चक्र और अंतर-फसल अपनाएं।' },
                        { icon: '🐞', en: 'Control pests with neem oil spray or companion planting instead of chemical pesticides.', hi: 'रासायनिक कीटनाशक की जगह नीम के तेल का छिड़काव या साथी-रोपण अपनाएं।' },
                        { icon: '📜', en: 'Once your field stays chemical-free for the required period, apply for organic certification to sell at better prices.', hi: 'खेत पूरी तरह रसायन-मुक्त होने के बाद बेहतर दाम पाने के लिए ऑर्गेनिक प्रमाणन के लिए आवेदन करें।' }
                    ],
                    tip: { en: 'Healthy, organic-rich soil holds more water and needs fewer inputs season after season.', hi: 'जैविक तत्वों से भरपूर स्वस्थ मिट्टी अधिक पानी रोकती है और हर मौसम में कम खाद-दवा की जरूरत पड़ती है।' }
                },
                insurance: {
                    courseNum: 3,
                    emoji: '🛡️',
                    diagram: ['🌾', '⚠️', '🛡️', '💰'],
                    steps: [
                        { icon: '📝', en: 'Enroll in Pradhan Mantri Fasal Bima Yojana (PMFBY) before the cut-off date for your crop season.', hi: 'अपने फसल सीजन की अंतिम तिथि से पहले प्रधानमंत्री फसल बीमा योजना (PMFBY) में नामांकन करें।' },
                        { icon: '🏦', en: 'You pay only a small share of the premium — the government covers the rest.', hi: 'आपको प्रीमियम का बहुत छोटा हिस्सा ही देना होता है — बाकी सरकार वहन करती है।' },
                        { icon: '🌪️', en: 'If your crop is damaged by drought, flood, pests, or disease, report it to your bank or insurer within 72 hours.', hi: 'सूखा, बाढ़, कीट या रोग से फसल खराब होने पर 72 घंटे के अंदर बैंक या बीमा कंपनी को सूचित करें।' },
                        { icon: '📸', en: 'Take clear photos of the damaged field as proof when you report the loss.', hi: 'नुकसान की सूचना देते समय खराब फसल की स्पष्ट तस्वीरें सबूत के तौर पर लें।' },
                        { icon: '💵', en: 'After assessment, the claim amount is usually paid directly into your linked bank account.', hi: 'आकलन के बाद दावे की राशि आमतौर पर सीधे आपके जुड़े बैंक खाते में भेजी जाती है।' }
                    ],
                    tip: { en: 'Keep your Aadhaar, land records, and bank details updated — mismatched details are the most common reason claims get delayed.', hi: 'अपना आधार, भूमि रिकॉर्ड और बैंक विवरण अपडेट रखें — जानकारी न मिलने से ही ज़्यादातर दावों में देरी होती है।' }
                },
                cloud: {
                    courseNum: 4,
                    emoji: '☁️',
                    diagram: ['📱', '☁️', '📊', '🎓'],
                    steps: [
                        { icon: '📱', en: 'Use a smartphone or your nearest CSC (Common Service Centre) to access government agri-portals and apps.', hi: 'सरकारी कृषि पोर्टल और ऐप तक पहुंचने के लिए स्मार्टफोन या नज़दीकी CSC (कॉमन सर्विस सेंटर) का उपयोग करें।' },
                        { icon: '☁️', en: 'Save your soil health reports, insurance papers, and land records online so they are never lost.', hi: 'मिट्टी स्वास्थ्य रिपोर्ट, बीमा कागज़ात और भूमि रिकॉर्ड को ऑनलाइन सुरक्षित रखें ताकि वे कभी न खोएं।' },
                        { icon: '📊', en: 'Check mandi (market) prices online before deciding when and where to sell your produce.', hi: 'उपज कब और कहां बेचनी है, यह तय करने से पहले मंडी के भाव ऑनलाइन जांच लें।' },
                        { icon: '🎓', en: 'Watch free e-learning videos and webinars from agricultural universities (KVK) to learn new techniques.', hi: 'नई तकनीकें सीखने के लिए कृषि विश्वविद्यालयों (KVK) के मुफ्त ई-लर्निंग वीडियो और वेबिनार देखें।' },
                        { icon: '🔔', en: 'Turn on SMS or app alerts for weather warnings and scheme deadlines.', hi: 'मौसम की चेतावनी और योजनाओं की अंतिम तिथि के लिए SMS या ऐप अलर्ट चालू करें।' }
                    ],
                    tip: { en: 'A free app like Kisan Suvidha or eNAM puts market prices and weather alerts right in your pocket.', hi: 'किसान सुविधा या ई-नाम जैसे मुफ्त ऐप से बाज़ार भाव और मौसम अलर्ट सीधे आपकी जेब में मिलते हैं।' }
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
                            <span>${step[currentLang]}</span>
                        </div>
                    `).join('');

                techniqueTip.textContent = '💡 ' + guide.tip[currentLang];

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

            techniqueListenBtn.addEventListener('click', async () => {
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
                if (!content) return;

                techniqueListenBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
                techniqueListenBtn.classList.add('speaking');

                try {
                    const langCode = body.getAttribute('lang') === 'hi' ? 'hi-IN' : 'en-US';
                    const voiceName = langCode === 'hi-IN' ? 'Kore' : 'Zephyr';

                    const TTS_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${API_KEY}`;
                    const payload = {
                        contents: [{ parts: [{ text: content }] }],
                        generationConfig: {
                            responseModalities: ["AUDIO"],
                            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceName } } }
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

                        audioEl.src = URL.createObjectURL(wavBlob);
                        audioEl.play();

                        techniqueListenBtn.innerHTML = '<i class="fas fa-volume-off"></i>';

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
            /* ================= END EASY LEARNING GUIDE MODAL ================= */

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

            const sellImageInput = document.getElementById('sellImage');
            const sellImagePreview = document.getElementById('sellImagePreview');
            let sellImageDataUrl = '';

            sellImageInput.addEventListener('change', () => {
                const file = sellImageInput.files[0];
                if (!file) {
                    sellImageDataUrl = '';
                    sellImagePreview.style.display = 'none';
                    return;
                }
                const reader = new FileReader();
                reader.onload = (e) => {
                    sellImageDataUrl = e.target.result;
                    sellImagePreview.src = sellImageDataUrl;
                    sellImagePreview.style.display = 'block';
                };
                reader.readAsDataURL(file);
            });

            sellButton.addEventListener('click', function () {
                const name = document.getElementById('sellName').value.trim();
                const qty = document.getElementById('sellQty').value;
                const price = document.getElementById('sellPrice').value;
                if (!sellImageDataUrl) {
                    showToast(translations[currentLang]['toast-error-image'], false);
                    return;
                }
                addProductListing(name, qty, price, sellImageDataUrl);
                document.getElementById('sellName').value = "";
                document.getElementById('sellQty').value = "";
                document.getElementById('sellPrice').value = "";
                sellImageInput.value = "";
                sellImageDataUrl = '';
                sellImagePreview.style.display = 'none';
                sellImagePreview.src = '';
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
            const drawerImageLabel = document.getElementById('drawerImageLabel');
            const drawerImageInput = document.getElementById('drawerImage');
            const drawerImagePreview = document.getElementById('drawerImagePreview');
            let drawerImageDataUrl = '';

            drawerImageInput.addEventListener('change', () => {
                const file = drawerImageInput.files[0];
                if (!file) {
                    drawerImageDataUrl = '';
                    drawerImagePreview.style.display = 'none';
                    return;
                }
                const reader = new FileReader();
                reader.onload = (e) => {
                    drawerImageDataUrl = e.target.result;
                    drawerImagePreview.src = drawerImageDataUrl;
                    drawerImagePreview.style.display = 'block';
                };
                reader.readAsDataURL(file);
            });

            function openDrawer(type) {
                const isBuy = type === 'buy';
                drawerTitle.textContent = isBuy ? 'Quick Buy Product' : 'Quick Sell Product';
                drawerInstruction.textContent = isBuy 
                    ? 'Enter the product you want to buy and add it to your cart (mock transaction).'
                    : 'Enter the product you want to sell, set a price, and add a photo (mock listing).';
                
                drawerPriceInput.style.display = isBuy ? 'none' : 'block';
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
                    if (isNaN(price) || parseFloat(price) <= 0) {
                        showToast("Please enter a valid price to sell.", false);
                        return;
                    }
                    if (!drawerImageDataUrl) {
                        showToast(translations[currentLang]['toast-error-image'], false);
                        return;
                    }
                    addProductListing(name, qty, price, drawerImageDataUrl);
                } else {
                    const price = 100; // Default price for mock buy
                    addToCart(name, qty, price);
                }

                closeDrawer();
            });
        });
