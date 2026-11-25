import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js";

export const SUPER_ADMIN = "edenpemalang@gmail.com";

export const firebaseConfig = {
  apiKey: "AIzaSyCzX0UOkVwvRkUuGBWVcec92AWj2tjQeoE",
  authDomain: "territory-assistant-40a9b.firebaseapp.com",
  databaseURL: "https://territory-assistant-40a9b-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "territory-assistant-40a9b",
  storageBucket: "territory-assistant-40a9b.firebasestorage.app",
  messagingSenderId: "729411479743",
  appId: "1:729411479743:web:bc19a775993ff6bf897e0a"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getDatabase(app, firebaseConfig.databaseURL);