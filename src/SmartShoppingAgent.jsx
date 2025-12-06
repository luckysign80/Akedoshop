import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, doc, setDoc, onSnapshot, collection, query, orderBy, limit, deleteDoc, getDoc, writeBatch } from 'firebase/firestore';
import { Upload, Edit, RefreshCw, Zap, Bot, Trash2 } from 'lucide-react'; // Added Trash2 icon

const appId = 'default-app-id';

// --- Global Context Variables
// const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
// const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {};

const firebaseConfig = {
    apiKey: process.env.REACT_APP_FIREBASE_API_KEY,
    authDomain: process.env.REACT_APP_FIREBASE_AUTH_DOMAIN,
    projectId: process.env.REACT_APP_FIREBASE_PROJECT_ID,
    storageBucket: process.env.REACT_APP_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.REACT_APP_FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.REACT_APP_FIREBASE_APP_ID,
};

// const apiKey = "";

// --- Initial Data Structures for Seeding the Database ---

const initialInventory = [
    { id: '1', name: 'Coffee Beans', quantity: 0.5, unit: 'bags', restockLevel: 1, dailyUse: 0.1, lastUsed: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString() }, 
    { id: '2', name: 'Toilet Paper', quantity: 4, unit: 'rolls', restockLevel: 8, dailyUse: 0.5, lastUsed: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString() },
    { id: '3', name: 'Milk', quantity: 1, unit: 'gallon', restockLevel: 2, dailyUse: 0.2, lastUsed: new Date().toISOString() },
    { id: '4', name: 'Dish Soap', quantity: 1, unit: 'bottle', restockLevel: 1, dailyUse: 0.05, lastUsed: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString() },
];

const initialHistory = [
    { id: 'h1', item: 'Toilet Paper', quantity: 12, vendor: 'Amazon', cost: 25.50, date: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(), method: 'Auto' },
    { id: 'h2', item: 'Milk', quantity: 3, vendor: 'Walmart', cost: 12.00, date: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(), method: 'Manual' },
];

const initialConfig = {
    spendCapMonthly: 500,
    currentMonthSpend: 150,
    vendorAllowlist: ['Amazon', 'Walmart'],
};


// --- Utility Functions (fetchWithRetry, imageToBase64, callVisionAPI - unchanged) ---

/**
 * Custom fetch wrapper with exponential backoff for API resilience.
 */
const fetchWithRetry = async (url, options, maxRetries = 5) => {
    for (let i = 0; i < maxRetries; i++) {
        try {
            const response = await fetch(url, options);
            if (!response.ok) {
                // If 4xx or 5xx error, throw it unless it's the last attempt
                if (response.status === 429 || response.status >= 500) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                return response;
            }
            return response;
        } catch (error) {
            if (i === maxRetries - 1) throw error;
            const delay = Math.pow(2, i) * 1000 + Math.random() * 1000;
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
};

/**
 * Converts File object to a base64 string for the Vision API.
 */
const imageToBase64 = (file) => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.onerror = (error) => reject(error);
        reader.readAsDataURL(file);
    });
};

/**
 * Calls the Gemini Vision API to extract structured data from a receipt image.
 */
const callVisionAPI = async (base64Image, mimeType) => {
    const model = 'gemini-2.5-flash-preview-09-2025';
    // const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const proxyUrl = '/api/gemini';

    const visionPrompt = `
        You are an OCR and data extraction system for a shopping agent.
        Analyze the provided image of a receipt. Identify and extract all shopping items, their purchased quantity, their individual cost, and the store name/vendor.
        The output must be a JSON array of objects, strictly adhering to the provided schema.
        Combine item lines if necessary, and use a reasonable approximation if exact quantity/cost is unclear.
    `;

    const payload = {
        contents: [{
            role: "user",
            parts: [
                { text: visionPrompt },
                { inlineData: { mimeType: mimeType, data: base64Image } }
            ]
        }],
        systemInstruction: { parts: [{ text: "Extract structured data from the receipt image. Output only the requested JSON structure." }] },
        generationConfig: {
            responseMimeType: "application/json",
            responseSchema: {
                type: "ARRAY",
                description: "A list of extracted items from the receipt.",
                items: {
                    type: "OBJECT",
                    properties: {
                        name: { type: "STRING", description: "The name of the purchased item (e.g., 'Milk')." },
                        quantity: { type: "NUMBER", description: "The purchased quantity (e.g., 2)." },
                        cost: { type: "NUMBER", description: "The individual item cost (e.g., 4.99). If line item total is provided, divide by quantity." },
                        vendor: { type: "STRING", description: "The store or vendor name (e.g., 'Walmart')." }
                    },
                    required: ["name", "quantity", "cost", "vendor"]
                }
            }
        }
    };

    try {
        const response = await fetchWithRetry(proxyUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, payload})
        });

        const result = await response.json();
        const jsonText = result?.candidates?.[0]?.content?.parts?.[0]?.text;

        if (jsonText) {
            return JSON.parse(jsonText);
        }
        return [];
    } catch (error) {
            console.error("LLM Vision Error:", error);
            return []; // Return empty array on error
    }
};

/**
 * Simulates the LLM's predictive engine to suggest items and provide behavioral run-out forecasts.
 * The model returns both the suggested cart items and the full inventory with predicted dates.
 */
const callPredictiveEngine = async (inventory, purchaseHistory) => {
    const model = 'gemini-2.5-flash-preview-09-2025';
    // const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const proxyUrl = '/api/gemini'

    // Prepare data for the prompt
    // FIX: Add optional chaining to ensure name and other properties exist before accessing them.
    const inventorySummary = inventory
        .filter(item => item && item.name)
        .map(item => ({ 
            name: item.name, 
            quantity: item.quantity, 
            unit: item.unit, 
            lastUsed: item.lastUsed ? new Date(item.lastUsed).toISOString().substring(0, 10) : 'N/A' 
        }));
        
    const historySummary = purchaseHistory
        .filter(entry => entry && entry.item)
        .map(entry => ({ 
            item: entry.item, 
            quantity: entry.quantity, 
            date: new Date(entry.date).toISOString().substring(0, 10), 
            vendor: entry.vendor 
        }));

    const userQuery = `
        You are the predictive core logic engine of an autonomous home shopping agent.
        Analyze the provided Current Inventory and Recent Purchase History.
        
        Task 1: Generate a behavioral run-out forecast (YYYY-MM-DD) for *every* item in the inventory, based on the historical purchase frequency.
        Task 2: Predict and suggest up to 5 items that should be purchased soon (low stock or due for refill).
        
        Current Inventory: ${JSON.stringify(inventorySummary)}
        Recent Purchase History (last 10 entries): ${JSON.stringify(historySummary)}
    `;

    const systemPrompt = "Analyze history for consumption patterns. Output ONLY a concise JSON object that strictly adheres to the provided schema, containing both the suggested cart and the inventory forecasts.";

    const payload = {
        contents: [{ parts: [{ text: userQuery }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: {
            responseMimeType: "application/json",
            responseSchema: {
                type: "OBJECT",
                properties: {
                    suggestedCart: {
                        type: "ARRAY",
                        description: "List of 0-5 items recommended for immediate purchase.",
                        items: {
                            type: "OBJECT",
                            properties: {
                                name: { type: "STRING", description: "The name of the item." },
                                quantityToBuy: { type: "NUMBER", description: "The suggested quantity to add to the cart (e.g., 2)." },
                                reason: { type: "STRING", description: "A brief reason for the suggestion (e.g., 'Low stock', 'Bi-weekly refill needed')." },
                                vendor: { type: "STRING", enum: ["Amazon", "Walmart", "Unknown"], description: "The suggested vendor." }
                            },
                            required: ["name", "quantityToBuy", "reason"]
                        }
                    },
                    inventoryForecasts: {
                        type: "ARRAY",
                        description: "List of all inventory items with an AI-predicted run-out date.",
                        items: {
                            type: "OBJECT",
                            properties: {
                                name: { type: "STRING", description: "The name of the item matching inventory." },
                                predictedRunOutDate: { type: "STRING", description: "The predicted date (YYYY-MM-DD) the item will run out, based on purchase history analysis." }
                            },
                            required: ["name", "predictedRunOutDate"]
                        }
                    }
                },
                required: ["suggestedCart", "inventoryForecasts"]
            }
        }
    };

    try {
        const response = await fetchWithRetry(proxyUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, payload})
        });

        const result = await response.json();
        const jsonText = result?.candidates?.[0]?.content?.parts?.[0]?.text;

        if (jsonText) {
            return JSON.parse(jsonText);
        }
        return { suggestedCart: [], inventoryForecasts: [] };
    } catch (error) {
        console.error("LLM Prediction Error:", error);
        return { suggestedCart: [], inventoryForecasts: [] };
    }
};

// --- React Component ---

const App = () => {
    // --- Firebase/Auth State ---
    const [db, setDb] = useState(null);
    const [auth, setAuth] = useState(null);
    const [userId, setUserId] = useState(null);
    const [isAuthReady, setIsAuthReady] = useState(false);

    // --- Agent State (Stored in Firestore) ---
    const [inventory, setInventory] = useState([]);
    const [purchaseHistory, setPurchaseHistory] = useState([]);
    const [userConfig, setUserConfig] = useState(initialConfig);
    const [auditLog, setAuditLog] = useState([]);

    // --- UI/Runtime State ---
    const [activeTab, setActiveTab] = useState('dashboard');
    const [suggestedCart, setSuggestedCart] = useState([]);
    const [cartStatus, setCartStatus] = useState('Idle');
    const [logMessage, setLogMessage] = useState('');
    const [isProcessing, setIsProcessing] = useState(false);
    const [pendingDeleteId, setPendingDeleteId] = useState(null); // State for delete confirmation
    
    const [manualInput, setManualInput] = useState({
        name: '', quantity: 1, cost: 0.00, vendor: initialConfig.vendorAllowlist[0] || 'Unknown'
    });

    // --- CORE FIREBASE FUNCTIONS ---

    // 1. Initialize User Data (Seed database on first login)
    const initializeUserData = useCallback(async (firestoreDb, uid, baseUserPath) => {
        const configDocRef = doc(firestoreDb, `${baseUserPath}/config/userConfig`);
        
        try {
            const configSnap = await getDoc(configDocRef);

            if (!configSnap.exists()) {
                setLogMessage('First time user detected. Seeding initial data...');
                const batch = writeBatch(firestoreDb);

                // A. Set Config
                batch.set(configDocRef, initialConfig);

                // B. Set Inventory
                const invCollectionRef = collection(firestoreDb, `${baseUserPath}/inventory`);
                initialInventory.forEach(item => {
                    batch.set(doc(invCollectionRef, item.id), item);
                });

                // C. Set History
                const histCollectionRef = collection(firestoreDb, `${baseUserPath}/purchaseHistory`);
                initialHistory.forEach(item => {
                    batch.set(doc(histCollectionRef), item); // Firestore generates ID for history
                });

                await batch.commit();
                setLogMessage('Initial data setup complete. Loading agent...');
            } else {
                setLogMessage('Existing data found. Loading agent...');
            }
        } catch (e) {
            console.error("Error initializing user data:", e);
            setLogMessage('Error initializing user data. Check console.');
        }
    }, []);

    // 2. Firebase Initialization and Auth
    useEffect(() => {
        if (!firebaseConfig.apiKey) {
            setLogMessage('Error: Firebase configuration is missing.');
            return;
        }

        const app = initializeApp(firebaseConfig);
        const firestoreDb = getFirestore(app);
        const firebaseAuth = getAuth(app);
        setDb(firestoreDb);
        setAuth(firebaseAuth);

        const unsubscribe = onAuthStateChanged(firebaseAuth, async (user) => {
            if (user) {
                const uid = user.uid;
                setUserId(uid);
                const baseUserPath = `artifacts/${appId}/users/${uid}`;
                setLogMessage(`Authenticated successfully as User: ${uid.substring(0, 8)}...`);

                // Run initialization check immediately after successful auth
                await initializeUserData(firestoreDb, uid, baseUserPath);
            } else {
                try {
                    if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
                        await signInWithCustomToken(firebaseAuth, __initial_auth_token);
                    } else {
                        await signInAnonymously(firebaseAuth);
                    }
                } catch (error) {
                    console.error("Firebase Auth Error:", error);
                    setLogMessage(`Auth Failed. Running in local simulation mode. Error: ${error.message}`);
                    setUserId(crypto.randomUUID());
                }
            }
            setIsAuthReady(true);
        });

        return () => unsubscribe();
    }, [initializeUserData]);

    // 3. Agent Actions (Database Operations) 

    const updateInventory = useCallback(async (item) => {
        if (!db || !userId) return;
        
        // Ensure core fields are present for consistency
        const sanitizedItem = {
            id: item.id || crypto.randomUUID(),
            name: item.name,
            quantity: parseFloat(item.quantity) || 0,
            unit: item.unit || 'units',
            restockLevel: parseFloat(item.restockLevel) || 1,
            dailyUse: parseFloat(item.dailyUse) || 0.05,
            lastUsed: item.lastUsed || new Date().toISOString(),
            // Remove old AI prediction when manual change occurs, forcing a re-run
            predictedRunOutDate: null, 
        };

        const invRef = doc(db, `artifacts/${appId}/users/${userId}/inventory/${sanitizedItem.id}`);
        try {
            await setDoc(invRef, sanitizedItem);
            setLogMessage(`Inventory updated for: ${sanitizedItem.name}`);
            setPendingDeleteId(null); // Clear pending delete if editing
        } catch (e) {
            console.error("Error updating inventory:", e);
        }
    }, [db, userId]);

    const deleteInventoryItem = useCallback(async (itemId) => {
        if (!db || !userId) return;
        setIsProcessing(true);
        
        const invRef = doc(db, `artifacts/${appId}/users/${userId}/inventory/${itemId}`);
        try {
            await deleteDoc(invRef);
            setLogMessage(`Item with ID ${itemId} deleted successfully.`);
            logAudit('Inventory Deletion', { itemId });
        } catch (e) {
            console.error("Error deleting inventory item:", e);
            setLogMessage('Error deleting item. Check console.');
        } finally {
            setPendingDeleteId(null);
            setIsProcessing(false);
        }
    }, [db, userId]);


    const logAudit = useCallback(async (action, details) => {
        if (!db || !userId) return;
        const logRef = collection(db, `artifacts/${appId}/users/${userId}/auditLog`);
        try {
            // Note: Using setDoc with doc() will generate a new document ID automatically.
            await setDoc(doc(logRef), {
                timestamp: new Date().toISOString(),
                action,
                details: typeof details === 'string' ? details : JSON.stringify(details),
            });
        } catch (e) {
            console.error("Error logging audit:", e);
        }
    }, [db, userId]);

    const updateConfig = useCallback(async (newConfig) => {
        if (!db || !userId) return;
        const configDocRef = doc(db, `artifacts/${appId}/users/${userId}/config/userConfig`);
        try {
            await setDoc(configDocRef, newConfig, { merge: true });
            setLogMessage('Configuration saved successfully.');
            logAudit('Config Update', newConfig);
        } catch (e) {
            console.error("Error updating config:", e);
        }
    }, [db, userId, logAudit]);

    const runForecasting = useCallback(async () => {
        if (!db || !userId) return;

        // NEW FEATURE: Stop prediction if there is no household inventory
        if (inventory.length === 0) {
            setLogMessage('Forecasting stopped: No inventory items available to analyze.');
            setCartStatus('Idle (Inventory Empty)');
            return;
        }

        setIsProcessing(true);
        setCartStatus('Running AI prediction engine for forecast and cart...');

        // FIX: Filter out any items that are null/undefined or missing a 'name' property
        // This prevents the 'Cannot read properties of undefined (reading toLowerCase)' error.
        const safeInventory = inventory.filter(item => item && item.name);
        
        // 1. LLM-Based Prediction (Now returns BOTH cart suggestions and inventory forecasts)
        const llmResult = await callPredictiveEngine(safeInventory, purchaseHistory);
        const llmSuggestions = llmResult.suggestedCart;
        const inventoryForecasts = llmResult.inventoryForecasts;

        // FIX: Only map items that passed the filter
        const inventoryMap = new Map(
            safeInventory.map(item => [item.name.toLowerCase(), item])
        );

        const baseUserPath = `artifacts/${appId}/users/${userId}`;
        const batch = writeBatch(db);
        
        // 2. Process and Commit Behavioral Forecasts to Inventory
        setLogMessage('Updating inventory with AI-driven run-out dates...');
        
        for (const forecast of inventoryForecasts) {
            // FIX: Safely access name.toLowerCase() in case LLM output is malformed
            const existingItem = inventoryMap.get(forecast.name?.toLowerCase());
            
            if (existingItem) {
                const invRef = doc(db, `${baseUserPath}/inventory/${existingItem.id}`);
                
                // Use batch.set with merge: true to avoid 'No document to update' errors
                batch.set(invRef, { 
                    predictedRunOutDate: forecast.predictedRunOutDate 
                }, { merge: true });
            }
        }
        
        // Commit forecast updates (Triggers the inventory listener)
        try {
            await batch.commit();
            logAudit('Forecast Update', { count: inventoryForecasts.length, source: 'AI Behavioral Analysis' });
        } catch (e) {
            console.error("Batch update error for forecasts:", e);
        }

        // 3. Filter and Enforce Policies on Suggested Cart
        let newCart = [];
        let totalCost = 0; // Simulated cost

        for (const item of llmSuggestions) {
            const vendor = item.vendor && userConfig.vendorAllowlist.includes(item.vendor) ? item.vendor : userConfig.vendorAllowlist[0] || 'Unknown';
            const itemCost = item.quantityToBuy * (Math.random() * 5 + 5); // Price simulation
            if (userConfig.currentMonthSpend + totalCost + itemCost <= userConfig.spendCapMonthly) {
                newCart.push({
                    name: item.name,
                    quantity: item.quantityToBuy,
                    cost: parseFloat(itemCost.toFixed(2)),
                    vendor: vendor,
                    reason: item.reason,
                });
                totalCost += itemCost;
            } else {
                logAudit('Forecasting Blocked', { item: item.name, reason: 'Spend Cap Exceeded' });
            }
        }

        setSuggestedCart(newCart);
        setCartStatus(`Cart built: ${newCart.length} items. Total: $${totalCost.toFixed(2)}.`);
        logAudit('Cart Built', { count: newCart.length, total: totalCost.toFixed(2) });
        setIsProcessing(false);

    }, [db, userId, inventory, purchaseHistory, userConfig, logAudit]);

    // --- Firestore Data Listeners (Real-time Sync) ---
    useEffect(() => {
        if (!isAuthReady || !db || !userId) return;

        const baseUserPath = `artifacts/${appId}/users/${userId}`;

        // Inventory Listener (will now include predictedRunOutDate)
        const unsubscribeInv = onSnapshot(collection(db, `${baseUserPath}/inventory`), (snapshot) => {
            const data = snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id }));
            setInventory(data);
        }, (error) => console.error("Inventory sync error:", error));

        // History Listener
        const qHist = query(collection(db, `${baseUserPath}/purchaseHistory`), orderBy('date', 'desc'), limit(100));
        const unsubscribeHist = onSnapshot(qHist, (qSnapshot) => {
            const data = qSnapshot.docs.map(doc => ({ ...doc.data(), id: doc.id }));
            setPurchaseHistory(data);
        }, (error) => console.error("History sync error:", error));

        // Config Listener
        const configDocRef = doc(db, `${baseUserPath}/config/userConfig`);
        const unsubscribeConfig = onSnapshot(configDocRef, (docSnap) => {
            if (docSnap.exists()) {
                setUserConfig(docSnap.data());
            } 
        }, (error) => console.error("Config sync error:", error));

        // Audit Log Listener
        const qLog = query(collection(db, `${baseUserPath}/auditLog`), orderBy('timestamp', 'desc'), limit(50));
        const unsubscribeLog = onSnapshot(qLog, (qSnapshot) => {
            const data = qSnapshot.docs.map(doc => ({ ...doc.data(), id: doc.id }));
            setAuditLog(data);
        }, (error) => console.error("Audit log sync error:", error));

        return () => {
            unsubscribeInv();
            unsubscribeHist();
            unsubscribeConfig();
            unsubscribeLog();
        };
    }, [isAuthReady, db, userId]);

    // Auto-run forecasting on initial data load
    useEffect(() => {
        // Run only when auth is ready, inventory is populated (meaning data loaded), and cart is empty
        // We also check if any item is missing a predictedRunOutDate to ensure first run happens
        const needsForecast = inventory.some(item => !item.predictedRunOutDate);

        // FEATURE UPDATE: Added inventory.length > 0 check
        if (isAuthReady && inventory.length > 0 && purchaseHistory.length > 0 && (suggestedCart.length === 0 || needsForecast)) {
            runForecasting();
        }
    }, [isAuthReady, inventory, purchaseHistory, runForecasting, suggestedCart.length]);


    // --- Core Data Processing ---

    const processUpdates = useCallback(async (updates) => {
        if (!db || !userId || updates.length === 0) return;
        setIsProcessing(true);
        setLogMessage(`Processing ${updates.length} incoming item update(s) and logging history...`);

        // Use a batch for atomic updates
        const batch = writeBatch(db);
        const histRef = collection(db, `artifacts/${appId}/users/${userId}/purchaseHistory`);
        const baseUserPath = `artifacts/${appId}/users/${userId}`;

        // 1. Prepare History and Inventory Updates
        for (const u of updates) {
            const cost = parseFloat(u.cost) || 0;
            const quantity = parseFloat(u.quantity) || 1;

            // A. Add to History
            batch.set(doc(histRef), {
                item: u.name,
                quantity: quantity,
                vendor: u.vendor,
                cost: cost,
                date: new Date().toISOString(),
                method: u.method || 'Agent Input',
            });

            // B. Prepare Inventory Update
            // FIX: Use optional chaining to safely access name properties when checking for existing items.
            const existingItem = inventory.find(i => (i?.name?.toLowerCase() || '') === (u.name?.toLowerCase() || ''));
            
            if (existingItem) {
                // Item exists: increase quantity and clear old prediction
                const updatedItem = {
                    ...existingItem,
                    quantity: (existingItem.quantity || 0) + quantity,
                    lastUsed: new Date().toISOString(),
                    predictedRunOutDate: null, // Clear old AI forecast
                };
                const invRef = doc(db, `${baseUserPath}/inventory/${existingItem.id}`);
                batch.set(invRef, updatedItem);

            } else {
                // Item is NEW: add with sensible defaults for consistency
                const newId = crypto.randomUUID();
                const defaultUnit = quantity > 1 ? 'units' : 'unit';
                
                const newItem = {
                    id: newId,
                    name: u.name,
                    quantity: quantity,
                    unit: defaultUnit,
                    restockLevel: quantity * 2,
                    dailyUse: quantity / 30,
                    lastUsed: new Date().toISOString(),
                    predictedRunOutDate: null,
                };
                const invRef = doc(db, `${baseUserPath}/inventory/${newId}`);
                batch.set(invRef, newItem);
            }
        }

        // 2. Commit Batch
        try {
            await batch.commit();
            setLogMessage(`Successfully processed ${updates.length} item(s). Inventory and History updated.`);
            logAudit('Input Processed', { source: updates[0]?.method, items: updates.map(u => u.name) });
            runForecasting(); // Re-run prediction after restocking to update the forecast date
        } catch (error) {
            console.error("Batch commit error:", error);
            setLogMessage('Error processing batch updates. Check console.');
        } finally {
            setIsProcessing(false);
        }
        
    }, [db, userId, inventory, logAudit, runForecasting]);


    // --- Input Source Handlers (Unchanged) ---

    // 1. Image Upload (Vision API)
    const handleImageUpload = async (event) => {
        const file = event.target.files[0];
        if (!file) return;

        if (!file.type.startsWith('image/')) {
            setLogMessage('Error: Please upload a valid image file (JPEG or PNG).');
            event.target.value = '';
            return;
        }

        setIsProcessing(true);
        setLogMessage(`Uploading and sending image (${file.name}) to Vision API for OCR...`);
        try {
            const base64Image = await imageToBase64(file);
            const extractedItems = await callVisionAPI(base64Image, file.type);

            if (extractedItems.length > 0) {
                const updates = extractedItems.map(item => ({...item, method: 'Vision OCR'}));
                processUpdates(updates);
            } else {
                setLogMessage('Vision API failed to extract items from the receipt. Check console for details.');
            }
        } catch (error) {
            console.error("Image processing error:", error);
            setLogMessage('Error processing image file. Check console.');
        } finally {
            event.target.value = ''; // Clear file input
            setIsProcessing(false);
        }
    };

    // 2. Manual Input (Single Item)
    const addItemManually = () => {
        const { name, quantity, cost, vendor } = manualInput;
        if (!name || isNaN(quantity) || quantity <= 0 || isNaN(cost) || cost < 0) {
            setLogMessage('Please enter valid item name, quantity, and cost.');
            return;
        }

        const update = {
            name: name.trim(),
            quantity: parseFloat(quantity),
            cost: parseFloat(cost),
            vendor: vendor.trim(),
            method: 'Manual Input'
        };

        processUpdates([update]);
        setManualInput({ name: '', quantity: 1, cost: 0.00, vendor: userConfig.vendorAllowlist[0] || 'Unknown' });
    };

    // --- Cart Execution (Always Auto) ---

    const handleCheckout = async () => {
        if (suggestedCart.length === 0) return;
        
        // Always proceed to execution (Fully Autonomous Mode)
        setCartStatus('Agent is fully Autonomous. Executing Purchase...');
        logAudit('Purchase Executed (Auto)', { total: suggestedCart.reduce((sum, item) => sum + item.cost, 0).toFixed(2) });

        setIsProcessing(true);
        await new Promise(resolve => setTimeout(resolve, 1500)); // Simulate transaction delay

        const totalPurchased = suggestedCart.reduce((sum, item) => sum + item.cost, 0);
        const itemsToPurchase = suggestedCart;

        // Use a batch for atomic purchase logging/inventory update
        const batch = writeBatch(db);
        const histRef = collection(db, `artifacts/${appId}/users/${userId}/purchaseHistory`);
        const baseUserPath = `artifacts/${appId}/users/${userId}`;

        // 1. Log New History & Update Inventory
        for (const item of itemsToPurchase) {
            // Log History
            batch.set(doc(histRef), {
                item: item.name,
                quantity: item.quantity,
                vendor: item.vendor,
                cost: item.cost,
                date: new Date().toISOString(),
                method: 'Agent Auto',
            });

            // Update Inventory (Find current state and calculate new quantity)
            // FIX: Use optional chaining to safely access name properties when checking for existing items.
            const existingItem = inventory.find(i => (i?.name?.toLowerCase() || '') === (item.name?.toLowerCase() || ''));
            if (existingItem) {
                const invRef = doc(db, `${baseUserPath}/inventory/${existingItem.id}`);
                batch.set(invRef, {
                    ...existingItem,
                    quantity: (existingItem.quantity || 0) + item.quantity,
                    lastUsed: new Date().toISOString(),
                    predictedRunOutDate: null, // Clear AI forecast upon successful restock
                });
            }
        }

        // 2. Update Spend Cap in Config
        const configDocRef = doc(db, `artifacts/${appId}/users/${userId}/config/userConfig`);
        batch.update(configDocRef, { currentMonthSpend: userConfig.currentMonthSpend + totalPurchased });
        
        // 3. Commit Batch
        try {
            await batch.commit();

            // 4. Log Audit (Separate from batch as it runs after transaction)
            logAudit('Purchase Executed (Simulated)', { total: totalPurchased.toFixed(2), items: itemsToPurchase.map(i => i.name) });

            setSuggestedCart([]);
            setCartStatus(`Purchase Complete! Total: $${totalPurchased.toFixed(2)}.`);
            runForecasting(); // Re-run forecasting to get new predicted run-out dates
        } catch (error) {
            console.error("Checkout batch commit error:", error);
            setLogMessage('Error during purchase execution. Check console.');
        } finally {
            setIsProcessing(false);
        }
    };


    // --- UI Components ---

    const CartReview = useMemo(() => {
        const cartTotal = suggestedCart.reduce((sum, item) => sum + item.cost, 0).toFixed(2);
        
        const badgeText = 'Autonomous Mode';

        return (
            <div className="bg-white p-6 rounded-xl shadow-lg border-2 border-green-200">
                <h2 className="text-xl font-bold mb-4 flex items-center justify-between">
                    Suggested Shopping Cart
                    <span className={`px-3 py-1 text-sm font-medium rounded-full bg-green-100 text-green-800 flex items-center`}>
                        <Zap className="w-4 h-4 mr-1"/>{badgeText}
                    </span>
                </h2>
                <div className="space-y-3 min-h-[100px]">
                    {suggestedCart.length === 0 ? (
                        <p className="text-gray-500 italic">No current items suggested. Run the prediction engine to check.</p>
                    ) : (
                        suggestedCart.map((item, index) => (
                            <div key={index} className="flex justify-between items-center border-b pb-2 last:border-b-0">
                                <div className="flex-1">
                                    <p className="font-semibold text-gray-800">{item.name}</p>
                                    <p className="text-xs text-indigo-600">{item.reason}</p>
                                </div>
                                <div className="text-right">
                                    <p className="text-sm text-gray-600">{item.quantity} x {item.vendor}</p>
                                    <p className="font-bold text-green-700">${item.cost.toFixed(2)}</p>
                                </div>
                            </div>
                        ))
                    )}
                </div>

                <div className="mt-6 pt-4 border-t border-gray-200">
                    <p className="text-lg font-bold flex justify-between">
                        Total Estimated Cost: <span className="text-indigo-700">${cartTotal}</span>
                    </p>
                    <p className="text-sm mt-2 mb-4 text-green-600 font-medium">Policy: Fully Autonomous (No Manual Review)</p>

                    <button
                        onClick={handleCheckout}
                        disabled={suggestedCart.length === 0 || isProcessing}
                        className={`w-full py-3 rounded-xl font-bold transition duration-150 ${suggestedCart.length === 0 || isProcessing
                            ? 'bg-gray-300 text-gray-600 cursor-not-allowed'
                            : 'bg-green-600 text-white hover:bg-green-700 shadow-md hover:shadow-lg'
                            }`}
                    >
                        {'Execute Purchase (Fully Autonomous)'}
                    </button>
                    <button
                        onClick={() => setSuggestedCart([])}
                        className="w-full mt-2 py-2 text-sm text-gray-600 hover:text-red-500"
                    >
                        Dismiss Cart
                    </button>
                </div>
            </div>
        );
    }, [suggestedCart, handleCheckout, isProcessing]); 

    const InventoryTable = useMemo(() => {
        // Now uses the AI-predicted date if available
        const getForecastDisplay = (item) => {
            if (item.predictedRunOutDate) {
                const date = new Date(item.predictedRunOutDate);
                const today = new Date();
                const diffTime = date.getTime() - today.getTime();
                const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

                if (diffDays <= 0) {
                    return <span className="text-red-600 font-bold">Today/Overdue</span>;
                } else if (diffDays <= 7) {
                    return <span className="text-orange-500 font-bold">{diffDays} days ({date.toLocaleDateString()})</span>;
                }
                return `${diffDays} days (${date.toLocaleDateString()})`;
            }
            return 'Running AI forecast...';
        };

        return (
            <div className="bg-white p-6 rounded-xl shadow-lg">
                <h2 className="text-xl font-semibold mb-4 text-gray-700 flex items-center">
                    Household Inventory
                    <Bot className="w-5 h-5 ml-2 text-blue-500" />
                </h2>
                <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200">
                        <thead className="bg-gray-50">
                            <tr>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Item</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Quantity</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Restock Level</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Run-Out Forecast (AI)</th>
                                <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">Edit</th>
                                <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">Delete</th>
                            </tr>
                        </thead>
                        <tbody className="bg-white divide-y divide-gray-200">
                            {inventory.map((item) => (
                                <tr key={item.id} className={(item.quantity || 0) < (item.restockLevel || 0) ? 'bg-red-50' : 'hover:bg-gray-50'}>
                                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{item.name}</td>
                                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                                        {(item.quantity || 0).toFixed(2)} {item.unit}
                                        {(item.quantity || 0) < (item.restockLevel || 0) && <span className="ml-2 text-xs font-bold text-red-600">(LOW)</span>}
                                    </td>
                                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{(item.restockLevel || 1).toFixed(2)} {item.unit}</td>
                                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{getForecastDisplay(item)}</td>
                                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-center">
                                        <button
                                            onClick={() => updateInventory({ ...item, quantity: (item.quantity || 0) + 1, lastUsed: new Date().toISOString() })}
                                            className="text-indigo-600 hover:text-indigo-900 text-lg font-bold mr-2"
                                        >
                                            +
                                        </button>
                                        <button
                                            onClick={() => updateInventory({ ...item, quantity: Math.max(0, (item.quantity || 0) - 1), lastUsed: new Date().toISOString() })}
                                            className="text-red-600 hover:text-red-900 text-lg font-bold"
                                        >
                                            -
                                        </button>
                                    </td>
                                    <td className="px-6 py-4 whitespace-nowrap text-sm text-center">
                                        {pendingDeleteId === item.id ? (
                                            <div className="flex space-x-1 justify-center">
                                                <button
                                                    onClick={() => deleteInventoryItem(item.id)}
                                                    className="bg-red-500 text-white hover:bg-red-700 p-1.5 rounded-lg text-xs font-semibold shadow-md transition duration-150"
                                                    disabled={isProcessing}
                                                >
                                                    Confirm Delete?
                                                </button>
                                                <button
                                                    onClick={() => setPendingDeleteId(null)}
                                                    className="bg-gray-200 text-gray-700 hover:bg-gray-300 p-1.5 rounded-lg text-xs transition duration-150"
                                                    disabled={isProcessing}
                                                >
                                                    Cancel
                                                </button>
                                            </div>
                                        ) : (
                                            <button
                                                onClick={() => setPendingDeleteId(item.id)}
                                                className="text-red-500 hover:text-red-700 transition duration-150 p-2 rounded-full hover:bg-red-100"
                                                disabled={isProcessing}
                                            >
                                                <Trash2 className="w-4 h-4" />
                                            </button>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
                <p className="mt-4 text-xs text-gray-500 italic">Note: Run-Out Forecast is now an **AI-driven behavioral prediction** based on your logged purchase history.</p>
            </div>
        );
    }, [inventory, updateInventory, pendingDeleteId, deleteInventoryItem, isProcessing]);

    const InputSources = useMemo(() => {
        const vendorOptions = userConfig.vendorAllowlist || [];
        return (
            <div className="bg-white p-6 rounded-xl shadow-lg space-y-6">
                <h2 className="text-xl font-semibold text-gray-700 border-b pb-3">Data Input Sources</h2>
                {isProcessing && (
                    <div className="flex items-center space-x-2 text-indigo-600 font-medium">
                        <RefreshCw className="w-5 h-5 animate-spin" />
                        <span>Processing Input... Please wait.</span>
                    </div>
                )}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {/* 1. Image Upload (Receipt OCR) */}
                    <div className="border border-indigo-200 p-4 rounded-lg bg-indigo-50 shadow-inner">
                        <label htmlFor="receipt-upload" className="block text-sm font-bold text-indigo-700 mb-2 flex items-center"><Upload className="w-4 h-4 mr-2" /> 1. Upload Receipt</label>
                        <p className="text-xs text-indigo-600 mb-3">Upload your receipt here.</p>
                        <input
                            type="file"
                            id="receipt-upload"
                            accept="image/jpeg, image/png"
                            onChange={handleImageUpload}
                            disabled={isProcessing}
                            className="hidden"
                        />
                        <label
                            htmlFor="receipt-upload"
                            className={`w-full py-2 flex items-center justify-center rounded-md font-medium transition duration-150 ${isProcessing ? 'bg-gray-400 cursor-not-allowed' : 'bg-indigo-600 text-white hover:bg-indigo-700 cursor-pointer'}`}
                        >
                            {isProcessing ? 'Waiting...' : 'Select Image'}
                        </label>
                    </div>

                    {/* 2. Manual Input */}
                    <div className="border border-purple-200 p-4 rounded-lg bg-purple-50 shadow-inner">
                        <label className="block text-sm font-bold text-purple-700 mb-2 flex items-center"><Edit className="w-4 h-4 mr-2" /> 2. Manual Single Item Entry</label>
                        <p className="text-xs text-purple-600 mb-3">Quickly log one item purchase/restock without needing a receipt or image.</p>

                        <input type="text" placeholder="Item Name" value={manualInput.name} onChange={(e) => setManualInput({ ...manualInput, name: e.target.value })} className="w-full p-1.5 border rounded-md text-sm mb-1" />
                        <div className="flex space-x-2 mb-2">
                            <input type="number" placeholder="Qty" value={manualInput.quantity} onChange={(e) => setManualInput({ ...manualInput, quantity: e.target.value })} min="1" className="w-1/3 p-1.5 border rounded-md text-sm" />
                            <input type="number" placeholder="Cost" value={manualInput.cost} onChange={(e) => setManualInput({ ...manualInput, cost: e.target.value })} min="0" step="0.01" className="w-1/3 p-1.5 border rounded-md text-sm" />
                            <select value={manualInput.vendor} onChange={(e) => setManualInput({ ...manualInput, vendor: e.target.value })} className="w-1/3 p-1.5 border rounded-md text-sm bg-white">
                                {vendorOptions.map(v => <option key={v}>{v}</option>)}
                            </select>
                        </div>
                        <button
                            onClick={addItemManually}
                            disabled={isProcessing || !manualInput.name}
                            className={`w-full py-2 rounded-md font-medium transition duration-150 ${isProcessing || !manualInput.name ? 'bg-gray-400 cursor-not-allowed' : 'bg-purple-600 text-white hover:bg-purple-700'}`}
                        >
                            Add to Inventory/History
                        </button>
                    </div>
                </div>

                <button
                    onClick={runForecasting}
                    disabled={isProcessing || inventory.length === 0} // Disable if processing or no inventory
                    className="w-full py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition duration-150 font-medium mt-4"
                >
                    <div className="flex items-center justify-center">
                        <RefreshCw className="w-4 h-4 mr-2" /> Run Prediction & Cart Build
                    </div>
                </button>
                {inventory.length === 0 && <p className="text-xs text-red-500 mt-2 text-center">Cannot run prediction: Inventory is empty. Add items first.</p>}
            </div>
        );
    }, [isProcessing, manualInput, userConfig.vendorAllowlist, handleImageUpload, addItemManually, runForecasting, inventory.length]);

    const DashboardView = (
        <div className="space-y-8">
            <div className="grid lg:grid-cols-3 gap-6">
                <div className="p-6 bg-white rounded-xl shadow-lg border-l-4 border-green-500">
                    <p className="text-sm font-medium text-gray-500">Monthly Spend Cap</p>
                    <p className="text-2xl font-bold text-gray-900">${userConfig.spendCapMonthly.toFixed(2)}</p>
                </div>
                <div className="p-6 bg-white rounded-xl shadow-lg border-l-4 border-indigo-500">
                    <p className="text-sm font-medium text-gray-500">Current Spend</p>
                    <p className={`text-2xl font-bold ${userConfig.currentMonthSpend > userConfig.spendCapMonthly * 0.8 ? 'text-red-600' : 'text-gray-900'}`}>
                        ${userConfig.currentMonthSpend.toFixed(2)}
                    </p>
                </div>
                <div className="p-6 bg-white rounded-xl shadow-lg border-l-4 border-yellow-500">
                    <p className="text-sm font-medium text-gray-500">Cart Status</p>
                    <p className="text-xl font-bold text-gray-900">{cartStatus}</p>
                </div>
            </div>

            <div className="grid lg:grid-cols-2 gap-8">
                {InputSources}
                {CartReview}
            </div>

            {InventoryTable}
        </div>
    );

    const SettingsView = (
        <div className="bg-white p-8 rounded-xl shadow-xl max-w-2xl mx-auto space-y-6">
            <h2 className="text-2xl font-bold text-gray-800 border-b pb-3">Agent Configuration & Policy</h2>
            <p className="text-sm text-gray-500">Configure financial guardrails and vendor preferences for autonomous operation.</p>

            {/* Spend Cap */}
            <div>
                <label htmlFor="spendCap" className="block text-sm font-medium text-gray-700">Monthly Spend Cap ($)</label>
                <input
                    type="number"
                    id="spendCap"
                    value={userConfig.spendCapMonthly}
                    onChange={(e) => updateConfig({ ...userConfig, spendCapMonthly: parseFloat(e.target.value) || 0 })}
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 p-2 border"
                    min="0"
                />
                <p className="mt-1 text-xs text-gray-500">Current Spend: ${userConfig.currentMonthSpend.toFixed(2)}</p>
            </div>

            {/* Vendor Allowlist */}
            <div>
                <label className="block text-sm font-medium text-gray-700">Vendor Allowlist</label>
                <div className="mt-1 space-y-2">
                    {['Amazon', 'Walmart', 'Local Grocer'].map(vendor => (
                        <div key={vendor} className="flex items-center">
                            <input
                                id={`vendor-${vendor}`}
                                type="checkbox"
                                checked={userConfig.vendorAllowlist.includes(vendor)}
                                onChange={() => {
                                    let list = userConfig.vendorAllowlist;
                                    if (list.includes(vendor)) {
                                        list = list.filter(v => v !== vendor);
                                    } else {
                                        list = [...list, vendor];
                                    }
                                    updateConfig({ ...userConfig, vendorAllowlist: list });
                                }}
                                className="h-4 w-4 text-indigo-600 border-gray-300 rounded focus:ring-indigo-500"
                            />
                            <label htmlFor={`vendor-${vendor}`} className="ml-3 text-sm text-gray-700">{vendor} (Simulated Sandbox)</label>
                        </div>
                    ))}
                </div>
            </div>

            {/* Autonomous Mode Status */}
            <div className="p-4 bg-green-50 rounded-lg border border-green-200 flex items-center space-x-3">
                <Zap className="w-6 h-6 text-green-600" />
                <div>
                    <p className="font-semibold text-green-800">Purchase Approval Mode</p>
                    <p className="text-sm text-green-700">Fully Autonomous: The agent executes purchases immediately after prediction, only constrained by the Monthly Spend Cap.</p>
                </div>
            </div>
        </div>
    );

    const AuditLogView = (
        <div className="bg-white p-6 rounded-xl shadow-xl">
            <h2 className="text-2xl font-bold mb-4 text-gray-800">Agent Audit Log</h2>
            <div className="overflow-y-scroll max-h-[60vh] border rounded-lg">
                <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50 sticky top-0">
                        <tr>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Time</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Action</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Details</th>
                        </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                        {auditLog.map((log, index) => (
                            <tr key={log.id || index} className="hover:bg-gray-50">
                                <td className="px-6 py-4 whitespace-nowrap text-xs text-gray-500">{new Date(log.timestamp).toLocaleTimeString()}</td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{log.action}</td>
                                <td className="px-6 py-4 text-sm text-gray-500 max-w-xs truncate">{log.details}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <p className="mt-4 text-xs text-gray-500 italic">This log tracks all system actions, including predictions, cart builds, approvals, and configuration changes.</p>
        </div>
    );

    // --- Main Render ---

    return (
        <div className="min-h-screen bg-gray-100 font-sans text-gray-800 p-4 sm:p-8">
            <header className="mb-8">
                <h1 className="text-3xl font-extrabold text-indigo-700">AKEDOshop MVP</h1>
                <p className="text-sm text-gray-500 mt-1">
                    User ID: <span className="font-mono bg-gray-200 px-1 rounded">{userId || 'Loading...'}</span> |
                    Status: <span className="font-medium text-green-600">{logMessage || (isAuthReady ? 'Ready' : 'Authenticating...')}</span>
                </p>
                <div className="mt-4 flex space-x-2 border-b border-gray-300">
                    <button
                        className={`py-2 px-4 rounded-t-lg font-semibold transition duration-150 ${activeTab === 'dashboard' ? 'bg-white border-t border-x border-gray-300 text-indigo-600' : 'text-gray-600 hover:text-indigo-600'}`}
                        onClick={() => setActiveTab('dashboard')}
                    >
                        Dashboard & Input
                    </button>
                    <button
                        className={`py-2 px-4 rounded-t-lg font-semibold transition duration-150 ${activeTab === 'settings' ? 'bg-white border-t border-x border-gray-300 text-indigo-600' : 'text-gray-600 hover:text-indigo-600'}`}
                        onClick={() => setActiveTab('settings')}
                    >
                        Policies & Config
                    </button>
                    <button
                        className={`py-2 px-4 rounded-t-lg font-semibold transition duration-150 ${activeTab === 'audit' ? 'bg-white border-t border-x border-gray-300 text-indigo-600' : 'text-gray-600 hover:text-indigo-600'}`}
                        onClick={() => setActiveTab('audit')}
                    >
                        Audit Log
                    </button>
                </div>
            </header>

            <main className="pb-8">
                {activeTab === 'dashboard' && DashboardView}
                {activeTab === 'settings' && SettingsView}
                {activeTab === 'audit' && AuditLogView}
            </main>
        </div>
    );
};

export default App;
