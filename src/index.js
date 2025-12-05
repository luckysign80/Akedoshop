import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './SmartShoppingAgent.jsx'; // Import your main application component

// Find the root element in index.html
const container = document.getElementById('root');

if (container) {
  // Create a root and render the application component
  const root = createRoot(container);
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
} else {
  console.error("Failed to find the root element to mount the React application.");
}