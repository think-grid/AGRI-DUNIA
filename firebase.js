// ============================================================
// FIREBASE SETUP — shared product listings across every device
// ============================================================
// This is a standalone ES module (loaded via <script type="module">),
// kept separate from contents.js (a classic script) so the rest of the
// app doesn't need to be rewritten as a module. It talks to contents.js
// through a few small functions/variables attached to `window`.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
    getFirestore,
    collection,
    addDoc,
    deleteDoc,
    doc,
    updateDoc,
    onSnapshot,
    query,
    orderBy
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

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
const productsCol = collection(db, "productListings");

// Always holds the most recent synced list, in case contents.js hasn't
// registered its callback yet when the first snapshot arrives.
window.__agriLatestProducts = [];

onSnapshot(
    query(productsCol, orderBy("createdAt", "desc")),
    (snapshot) => {
        const products = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
        window.__agriLatestProducts = products;
        if (typeof window.onProductsUpdated === "function") {
            window.onProductsUpdated(products);
        }
    },
    (error) => {
        console.error("Firestore listen error:", error);
    }
);

// Add a new product listing. Returns the created document's data.
window.fbAddProduct = async function (data) {
    return addDoc(productsCol, { ...data, createdAt: Date.now() });
};

// Remove a listing entirely (farmer deletes it).
window.fbRemoveProduct = async function (id) {
    return deleteDoc(doc(db, "productListings", id));
};

// Update just the quantity field (buyer purchases / cart item removed).
window.fbUpdateProductQty = async function (id, newQty) {
    return updateDoc(doc(db, "productListings", id), { qty: newQty });
};

console.log("AGRI दुनिया: connected to Firebase for cross-device product sync.");
