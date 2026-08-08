// firebase stuff for AGRI दुनिया - syncs products/reviews/messages across devices
// this is a module (loaded with type="module") so it's separate from contents.js
// talks to contents.js using window.xxx functions

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
    getFirestore,
    collection,
    addDoc,
    deleteDoc,
    doc,
    updateDoc,
    writeBatch,
    onSnapshot,
    query,
    orderBy
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import {
    getAuth,
    signInAnonymously,
    onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";

const firebaseConfig = {
    apiKey: "AIzaSyBNOM0Xc038DzzfnwK8jPjZNqQWesz0NZA",
    authDomain: "agri-dunia.firebaseapp.com",
    projectId: "agri-dunia",
    storageBucket: "agri-dunia.firebasestorage.app",
    messagingSenderId: "313560093479",
    appId: "1:313560093479:web:f09429cb15c698729f8f02",
    measurementId: "G-R236FQ4N8C"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

const productsCol = collection(db, "productListings");
const reviewsCol = collection(db, "productReviews");
const messagesCol = collection(db, "buyerFarmerMessages");
const notificationsCol = collection(db, "farmerNotifications");

// no real login system, currentUser is just local and never sent anywhere
// so sign in anon just so firestore rules can check request.auth != null
// keeps random bots out without needing real accounts
let authReady = signInAnonymously(auth).catch((err) => {
    console.error("Anonymous sign-in failed:", err);
});

onAuthStateChanged(auth, (user) => {
    if (user) console.log("AGRI दुनिया: signed in anonymously for Firestore access.");
});

window.__agriLatestProducts = [];
window.__agriLatestReviews = [];
window.__agriLatestMessages = [];
window.__agriLatestNotifications = [];

// wait for auth before listening, otherwise it races the sign in
authReady.then(() => {
    onSnapshot(query(productsCol, orderBy("createdAt", "desc")), (snap) => {
        const products = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        window.__agriLatestProducts = products;
        if (typeof window.onProductsUpdated === "function") {
            window.onProductsUpdated(products);
        }
    }, (err) => console.error("Firestore listen error:", err));
});

authReady.then(() => {
    onSnapshot(query(reviewsCol, orderBy("createdAt", "desc")), (snap) => {
        const reviews = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        window.__agriLatestReviews = reviews;
        if (typeof window.onReviewsUpdated === "function") {
            window.onReviewsUpdated(reviews);
        }
    }, (err) => console.error("Firestore reviews listen error:", err));

    onSnapshot(query(messagesCol, orderBy("createdAt", "desc")), (snap) => {
        const messages = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        window.__agriLatestMessages = messages;
        if (typeof window.onMessagesUpdated === "function") {
            window.onMessagesUpdated(messages);
        }
    }, (err) => console.error("Firestore messages listen error:", err));
});

// notifications used to be in localStorage (only worked on same device)
// now in firestore so farmer sees them everywhere
authReady.then(() => {
    onSnapshot(query(notificationsCol, orderBy("createdAt", "desc")), (snap) => {
        const notifications = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        window.__agriLatestNotifications = notifications;
        if (typeof window.onNotificationsUpdated === "function") {
            window.onNotificationsUpdated(notifications);
        }
    }, (err) => console.error("Firestore notifications listen error:", err));
});

window.fbAddProduct = async function (data) {
    await authReady;
    return addDoc(productsCol, { ...data, createdAt: Date.now() });
};

window.fbRemoveProduct = async function (id) {
    await authReady;
    return deleteDoc(doc(db, "productListings", id));
};

window.fbUpdateProductQty = async function (id, newQty) {
    await authReady;
    return updateDoc(doc(db, "productListings", id), { qty: newQty });
};

window.fbAddReview = async function (data) {
    await authReady;
    return addDoc(reviewsCol, { ...data, createdAt: Date.now() });
};

window.fbAddMessage = async function (data) {
    await authReady;
    return addDoc(messagesCol, { ...data, createdAt: Date.now() });
};

window.fbAddNotification = async function (data) {
    await authReady;
    return addDoc(notificationsCol, { ...data, read: false, createdAt: Date.now() });
};

// mark a bunch of notifications read at once (batch write, one round trip)
window.fbMarkNotificationsRead = async function (ids) {
    await authReady;
    if (!ids || ids.length === 0) return;
    const batch = writeBatch(db);
    ids.forEach(id => batch.update(doc(db, "farmerNotifications", id), { read: true }));
    return batch.commit();
};

console.log("AGRI दुनिया: connected to Firebase for cross-device product sync.");
