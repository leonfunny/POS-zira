// Connect to Zira App Local Server
let socket = null;
const RECONNECT_INTERVAL = 5000;

function connect() {
  console.log("Connecting to Zira App...");
  socket = new WebSocket('ws://localhost:19999');

  socket.onopen = () => {
    console.log("Connected to Zira App");
    // Send hello
    socket.send(JSON.stringify({ type: 'HELLO', message: 'Extension Connected' }));
  };

  socket.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      console.log("Received command:", msg);
      
      if (msg.type === 'EXECUTE') {
        handleCommand(msg);
      }
    } catch (e) {
      console.error("Error parsing message:", e);
    }
  };

  socket.onclose = () => {
    console.log("Disconnected. Reconnecting in 5s...");
    setTimeout(connect, RECONNECT_INTERVAL);
  };

  socket.onerror = (err) => {
    console.error("Socket error:", err);
    socket.close();
  };
}

function handleCommand(msg) {
  // msg = { type: 'EXECUTE', id: '123', action: 'get_posts', args: {} }
  
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs.length === 0) {
      reply(msg.id, { success: false, error: "No active tab" });
      return;
    }
    
    // Check if it's Facebook
    const tab = tabs[0];
    if (!tab.url.includes("facebook.com")) {
       reply(msg.id, { success: false, error: "Active tab is not Facebook" });
       return;
    }

    // Send to content script
    chrome.tabs.sendMessage(tab.id, { 
      action: msg.action, 
      ...msg.args 
    }, (response) => {
      // Handle response from content script
      if (chrome.runtime.lastError) {
        reply(msg.id, { success: false, error: chrome.runtime.lastError.message });
      } else {
        reply(msg.id, response);
      }
    });
  });
}

function reply(requestId, data) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({
      type: 'RESULT',
      id: requestId,
      data: data
    }));
  }
}

// Start connection
connect();