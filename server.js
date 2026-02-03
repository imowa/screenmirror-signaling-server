const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const express = require('express');
const http = require('http');
const { Client: FtpClient } = require('basic-ftp');

const PORT = process.env.PORT || 3001;

// Create Express app and HTTP server
const app = express();
const server = http.createServer(app);

// Attach Socket.IO to the HTTP server
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Store connected devices
const devices = new Map();

// Store pending file operation requests (for WebSocket-based file transfer)
const pendingRequests = new Map();

// Helper function to generate unique request IDs
function generateRequestId() {
  return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// FTP Helper Functions (legacy - kept for backward compatibility)
async function connectToDeviceFtp(deviceIp) {
  const client = new FtpClient();
  client.ftp.verbose = false;

  try {
    await client.access({
      host: deviceIp,
      port: 2121,
      user: "ftpuser",
      password: "ftp123456"
    });
    return client;
  } catch (err) {
    console.error(`❌ FTP connection failed to ${deviceIp}:`, err.message);
    throw err;
  }
}

async function listFtpDirectory(deviceIp, path = "/") {
  const client = await connectToDeviceFtp(deviceIp);
  try {
    const list = await client.list(path);
    return list.map(item => ({
      name: item.name,
      type: item.type === 1 ? 'file' : 'directory',
      size: item.size,
      modifiedAt: item.modifiedAt
    }));
  } finally {
    client.close();
  }
}

async function downloadFtpFile(deviceIp, remotePath, res) {
  const client = await connectToDeviceFtp(deviceIp);
  try {
    await client.downloadTo(res, remotePath);
  } finally {
    client.close();
  }
}


// HTTP API Endpoints
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Screen Mirror FTP Browser</title>
      <style>
        body { font-family: Arial, sans-serif; max-width: 1200px; margin: 0 auto; padding: 20px; }
        h1 { color: #333; }
        .device { border: 1px solid #ddd; padding: 15px; margin: 10px 0; border-radius: 5px; }
        .device h3 { margin-top: 0; }
        .files { margin-top: 10px; }
        .file-item { padding: 8px; border-bottom: 1px solid #eee; display: flex; justify-content: space-between; }
        .file-item:hover { background: #f5f5f5; }
        .directory { color: #0066cc; cursor: pointer; font-weight: bold; }
        .file { color: #333; }
        .download-btn { background: #4CAF50; color: white; border: none; padding: 5px 10px; cursor: pointer; border-radius: 3px; }
        .download-btn:hover { background: #45a049; }
        .breadcrumb { margin: 10px 0; color: #666; }
        .error { color: red; padding: 10px; background: #fee; border-radius: 5px; }
        .loading { color: #666; font-style: italic; }
      </style>
    </head>
    <body>
      <h1>📱 Screen Mirror FTP Browser</h1>
      <div id="devices"></div>

      <script>
        let currentDevice = null;
        let currentPath = '/';

        async function loadDevices() {
          const res = await fetch('/api/devices');
          const data = await res.json();
          const devicesDiv = document.getElementById('devices');

          if (data.devices.length === 0) {
            devicesDiv.innerHTML = '<p class="error">No devices connected</p>';
            return;
          }

          devicesDiv.innerHTML = data.devices.map(device => \`
            <div class="device">
              <h3>\${device.name} (\${device.id})</h3>
              <p>Type: \${device.type} | Status: \${device.status}</p>
              <p>IP: \${device.ipAddress || 'Unknown'}</p>
              <button onclick="browseDevice('\${device.id}')">
                Browse Files
              </button>
              <div id="files-\${device.id}" class="files"></div>
            </div>
          \`).join('');
        }

        async function browseDevice(deviceId, path = '/') {
          currentDevice = { id: deviceId };
          currentPath = path;

          const filesDiv = document.getElementById(\`files-\${deviceId}\`);
          filesDiv.innerHTML = '<p class="loading">Loading files...</p>';

          try {
            const res = await fetch(\`/api/ftp/browse?deviceId=\${deviceId}&path=\${encodeURIComponent(path)}\`);
            const data = await res.json();

            if (data.error) {
              filesDiv.innerHTML = \`<p class="error">\${data.error}</p>\`;
              return;
            }

            let html = \`<div class="breadcrumb">Path: \${path}\`;
            if (path !== '/') {
              const parentPath = path.split('/').slice(0, -1).join('/') || '/';
              html += \` <a href="#" onclick="browseDevice('\${deviceId}', '\${parentPath}'); return false;">⬆️ Up</a>\`;
            }
            html += '</div>';

            html += data.files.map(file => {
              if (file.type === 'directory') {
                const newPath = path === '/' ? \`/\${file.name}\` : \`\${path}/\${file.name}\`;
                return \`
                  <div class="file-item">
                    <span class="directory" onclick="browseDevice('\${deviceId}', '\${newPath}')">
                      📁 \${file.name}
                    </span>
                  </div>
                \`;
              } else {
                const filePath = path === '/' ? \`/\${file.name}\` : \`\${path}/\${file.name}\`;
                const sizeKB = (file.size / 1024).toFixed(2);
                return \`
                  <div class="file-item">
                    <span class="file">📄 \${file.name} (\${sizeKB} KB)</span>
                    <button class="download-btn" onclick="downloadFile('\${deviceId}', '\${filePath}', '\${file.name}')">
                      Download
                    </button>
                  </div>
                \`;
              }
            }).join('');

            filesDiv.innerHTML = html;
          } catch (err) {
            filesDiv.innerHTML = \`<p class="error">Error: \${err.message}</p>\`;
          }
        }

        function downloadFile(deviceId, remotePath, filename) {
          window.location.href = \`/api/ftp/download?deviceId=\${deviceId}&path=\${encodeURIComponent(remotePath)}&filename=\${encodeURIComponent(filename)}\`;
        }

        // Load devices on page load
        loadDevices();

        // Refresh devices every 5 seconds
        setInterval(loadDevices, 5000);
      </script>
    </body>
    </html>
  `);
});

app.get('/api/devices', (req, res) => {
  const deviceList = Array.from(devices.values()).map(d => ({
    id: d.id,
    name: d.name,
    type: d.type,
    status: d.status,
    ipAddress: d.ipAddress
  }));
  res.json({ devices: deviceList });
});

// HTTP endpoint for FTP-only device registration (doesn't interfere with WebSocket screen mirroring)
app.post('/api/ftp/register', (req, res) => {
  const { deviceId, deviceName, ipAddress } = req.body;

  if (!deviceId || !ipAddress) {
    return res.status(400).json({ error: 'deviceId and ipAddress are required' });
  }

  console.log(`📱 FTP Registration: ${deviceId} (${deviceName || 'Unknown'}) at ${ipAddress}`);

  // Store or update device info
  devices.set(deviceId, {
    id: deviceId,
    name: deviceName || 'Unknown Device',
    type: 'ftp-only',
    socketId: null,
    status: 'online',
    connectedAt: new Date(),
    ipAddress: ipAddress
  });

  console.log(`📊 Total devices: ${devices.size}`);

  // Broadcast updated device list
  broadcastDeviceList();

  res.json({ success: true, deviceId });
});

app.get('/api/ftp/browse', async (req, res) => {
  const { deviceId, path = '/' } = req.query;

  if (!deviceId) {
    return res.status(400).json({ error: 'deviceId is required' });
  }

  // Find device
  const device = devices.get(deviceId);
  if (!device) {
    return res.status(404).json({ error: 'Device not found or offline' });
  }

  if (!device.socketId) {
    return res.status(400).json({ error: 'Device not connected via WebSocket' });
  }

  try {
    // Generate unique request ID
    const requestId = generateRequestId();
    console.log(`📤 Sending file list request to ${deviceId}: path=${path}, requestId=${requestId}`);

    // Create promise to wait for response
    const responsePromise = new Promise((resolve, reject) => {
      pendingRequests.set(requestId, { resolve, reject });

      // Set timeout (30 seconds)
      setTimeout(() => {
        if (pendingRequests.has(requestId)) {
          pendingRequests.delete(requestId);
          reject(new Error('Request timeout'));
        }
      }, 30000);
    });

    // Send request to device via WebSocket
    io.to(device.socketId).emit('ftp-list-request', {
      requestId,
      path
    });

    // Wait for response
    const files = await responsePromise;
    res.json({ files });
  } catch (err) {
    console.error(`Error in /api/ftp/browse: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/ftp/download', async (req, res) => {
  const { deviceId, path, filename } = req.query;

  if (!deviceId || !path) {
    return res.status(400).json({ error: 'deviceId and path are required' });
  }

  // Find device
  const device = devices.get(deviceId);
  if (!device) {
    return res.status(404).json({ error: 'Device not found or offline' });
  }

  if (!device.socketId) {
    return res.status(400).json({ error: 'Device not connected via WebSocket' });
  }

  try {
    // Generate unique request ID
    const requestId = generateRequestId();
    console.log(`📤 Sending file download request to ${deviceId}: path=${path}, requestId=${requestId}`);

    // Set response headers for streaming
    res.setHeader('Content-Disposition', `attachment; filename="${filename || 'download'}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Transfer-Encoding', 'chunked');

    // Store response object for streaming (no buffering)
    pendingRequests.set(requestId, {
      response: res,
      startTime: Date.now()
    });

    // Set timeout (10 minutes for large files)
    const timeoutId = setTimeout(() => {
      if (pendingRequests.has(requestId)) {
        console.error(`⏱️ Download timeout for requestId=${requestId}`);
        pendingRequests.delete(requestId);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Request timeout' });
        } else {
          res.end();
        }
      }
    }, 600000); // 10 minutes

    // Store timeout ID so we can clear it later
    pendingRequests.get(requestId).timeoutId = timeoutId;

    // Send request to device via WebSocket
    io.to(device.socketId).emit('ftp-download-request', {
      requestId,
      path
    });

    // Response will be streamed as chunks arrive (no waiting)
    console.log(`🔄 Streaming download started for requestId=${requestId}`);
  } catch (err) {
    console.error(`Error in /api/ftp/download: ${err.message}`);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});


console.log(`🚀 Signaling server starting on port ${PORT}...`);
console.log(`🔧 Server version: Updated with register_device handler and enhanced logging`);

io.on('connection', (socket) => {
  const connectionTime = new Date().toISOString();
  console.log(`✅ Client connected: ${socket.id} at ${connectionTime}`);
  console.log(`📊 Current device count: ${devices.size}`);

  // Debug: Log all events received (helps diagnose missing events)
  // Note: onAny() requires Socket.io 4.x+
  try {
    if (typeof socket.onAny === 'function') {
      socket.onAny((eventName, ...args) => {
        console.log(`🔍 Event received: "${eventName}" from ${socket.id}`);
        if (args.length > 0) {
          try {
            console.log(`   Data:`, JSON.stringify(args[0], null, 2));
          } catch (e) {
            console.log(`   Data:`, args[0]);
          }
        }
      });
      console.log(`✅ Event logger enabled for ${socket.id}`);
    } else {
      console.warn(`⚠️  socket.onAny() not available - using individual event handlers only`);
    }
  } catch (e) {
    console.error(`❌ Error setting up event logger:`, e.message);
  }

  // Device registration (legacy - for backward compatibility)
  socket.on('register', (data) => {
    try {
      console.log(`📥 Received 'register' event from ${socket.id}`);
      console.log(`📥 Event data:`, JSON.stringify(data, null, 2));

      const deviceId = data.deviceId || uuidv4();

      if (!deviceId) {
        console.error(`❌ No deviceId provided, using UUID fallback`);
      }

      devices.set(deviceId, {
        id: deviceId,
        name: data.deviceName || 'Unknown Device',
        type: data.deviceType || 'unknown',
        socketId: socket.id,
        status: 'online',
        connectedAt: new Date(),
        ipAddress: data.ipAddress || null
      });

      socket.deviceId = deviceId;
      socket.emit('registered', { deviceId });

      console.log(`📱 Device registered (legacy): ${deviceId} (${data.deviceName || 'Unknown'})`);
      console.log(`📊 Total devices: ${devices.size}`);

      // Broadcast device list update
      broadcastDeviceList();
    } catch (error) {
      console.error(`❌ Error handling 'register' event:`, error);
      console.error(`❌ Error stack:`, error.stack);
    }
  });

  // Device registration with ANDROID_ID (new method)
  socket.on('register_device', (data) => {
    try {
      console.log(`📥 Received 'register_device' event from ${socket.id}`);
      console.log(`📥 Event data:`, JSON.stringify(data, null, 2));

      if (!data) {
        console.error(`❌ register_device: data is null or undefined`);
        return;
      }

      const deviceId = data.deviceId || uuidv4();

      if (!deviceId) {
        console.error(`❌ No deviceId provided, using UUID fallback`);
      }

      console.log(`📝 Registering device with ID: ${deviceId}`);

      devices.set(deviceId, {
        id: deviceId,
        name: data.deviceName || 'Unknown Device',
        type: data.deviceType || 'unknown',
        socketId: socket.id,
        status: 'online',
        connectedAt: new Date(),
        ipAddress: data.ipAddress || null
      });

      socket.deviceId = deviceId;
      
      console.log(`📤 Sending 'registered' response to ${socket.id}`);
      socket.emit('registered', { deviceId });

      console.log(`📱 Device registered: ${deviceId} (${data.deviceName || 'Unknown'})`);
      console.log(`📊 Total devices: ${devices.size}`);

      // Broadcast device list update
      broadcastDeviceList();
    } catch (error) {
      console.error(`❌ Error handling 'register_device' event:`, error);
      console.error(`❌ Error stack:`, error.stack);
      console.error(`❌ Error details:`, {
        message: error.message,
        name: error.name,
        data: data
      });
    }
  });

  // Get devices
  socket.on('get-devices', () => {
    const deviceList = Array.from(devices.values()).map(d => ({
      id: d.id,
      name: d.name,
      type: d.type,
      status: d.status
    }));
    socket.emit('devices', { devices: deviceList });
    console.log(`📋 Device list requested by ${socket.id}`);
  });

  // Relay offer
  socket.on('offer', (data) => {
    const targetDevice = devices.get(data.targetDeviceId);
    if (targetDevice) {
      io.to(targetDevice.socketId).emit('offer', {
        fromDeviceId: socket.deviceId,
        sdp: data.sdp
      });
      console.log(`📤 Offer relayed from ${socket.deviceId} to ${data.targetDeviceId}`);
    } else {
      console.log(`⚠️  Target device not found: ${data.targetDeviceId}`);
    }
  });

  // Relay answer
  socket.on('answer', (data) => {
    const targetDevice = devices.get(data.targetDeviceId);
    if (targetDevice) {
      io.to(targetDevice.socketId).emit('answer', {
        fromDeviceId: socket.deviceId,
        sdp: data.sdp
      });
      console.log(`📤 Answer relayed from ${socket.deviceId} to ${data.targetDeviceId}`);
    } else {
      console.log(`⚠️  Target device not found: ${data.targetDeviceId}`);
    }
  });

  // Relay ICE candidate
  socket.on('ice-candidate', (data) => {
    const targetDevice = devices.get(data.targetDeviceId);
    if (targetDevice) {
      io.to(targetDevice.socketId).emit('ice-candidate', {
        fromDeviceId: socket.deviceId,
        candidate: data.candidate
      });
      console.log(`🧊 ICE candidate relayed from ${socket.deviceId} to ${data.targetDeviceId}`);
    } else {
      console.log(`⚠️  Target device not found: ${data.targetDeviceId}`);
    }
  });

  // Handle keep-alive ping (prevents Render.com free tier from sleeping)
  socket.on('ping', (data) => {
    // Just acknowledge the ping to keep connection alive
    socket.emit('pong', { timestamp: Date.now() });
    // Log every ping to verify it's working (can reduce frequency later)
    const deviceId = socket.deviceId || data?.deviceId || 'unknown';
    console.log(`💓 Keep-alive ping from ${deviceId} (socket: ${socket.id.substring(0, 8)}...)`);
  });

  // Handle file listing response from device
  socket.on('ftp-list-response', (data) => {
    const { requestId, files, error } = data;
    console.log(`📂 Received file list response: requestId=${requestId}, files=${files?.length || 0}, error=${error || 'none'}`);

    // Resolve pending request if exists
    const pendingRequest = pendingRequests.get(requestId);
    if (pendingRequest) {
      if (error) {
        pendingRequest.reject(new Error(error));
      } else {
        pendingRequest.resolve(files);
      }
      pendingRequests.delete(requestId);
    }

    // Also emit to all connected web clients for real-time updates
    io.emit('ftp-list-response', {
      requestId,
      deviceId: socket.deviceId,
      files,
      error
    });
  });

  // Handle file download response from device (chunked streaming)
  socket.on('ftp-download-chunk', (data) => {
    const { requestId, chunk, isLast, error } = data;
    console.log(`📥 Received file chunk: requestId=${requestId}, size=${chunk?.length || 0}, isLast=${isLast}`);

    // Get pending request
    const pendingRequest = pendingRequests.get(requestId);
    if (pendingRequest) {
      const { response, timeoutId, startTime } = pendingRequest;

      if (error) {
        // Handle error
        console.error(`❌ Download error for requestId=${requestId}: ${error}`);
        clearTimeout(timeoutId);
        pendingRequests.delete(requestId);
        if (!response.headersSent) {
          response.status(500).json({ error });
        } else {
          response.end();
        }
      } else {
        // Stream chunk directly to client (no buffering)
        if (chunk) {
          const buffer = Buffer.from(chunk, 'base64');
          response.write(buffer);
          console.log(`✍️ Streamed ${buffer.length} bytes for requestId=${requestId}`);
        }

        // If this is the last chunk, end the response
        if (isLast) {
          response.end();
          clearTimeout(timeoutId);
          pendingRequests.delete(requestId);

          const duration = ((Date.now() - startTime) / 1000).toFixed(2);
          console.log(`✅ Download completed for requestId=${requestId} in ${duration}s`);
        }
      }
    } else {
      console.warn(`⚠️ Received chunk for unknown requestId=${requestId}`);
    }

    // Also emit to all connected web clients for real-time updates
    io.emit('ftp-download-chunk', {
      requestId,
      deviceId: socket.deviceId,
      chunk,
      isLast,
      error
    });
  });

  // Handle disconnect
  socket.on('disconnect', (reason) => {
    console.log(`❌ Client disconnected: ${socket.id}`);
    console.log(`   Reason: ${reason}`);
    
    if (socket.deviceId) {
      const device = devices.get(socket.deviceId);
      if (device) {
        console.log(`❌ Device disconnected: ${socket.deviceId} (${device.name})`);
      }
      devices.delete(socket.deviceId);
      console.log(`📊 Remaining devices: ${devices.size}`);
      broadcastDeviceList();
    } else {
      console.log(`⚠️  Socket ${socket.id} disconnected but had no deviceId`);
    }
  });

  // Handle errors
  socket.on('error', (error) => {
    console.error(`❌ Socket error from ${socket.id}:`, error);
    console.error(`   Error details:`, {
      message: error.message,
      name: error.name,
      stack: error.stack
    });
  });
});

function broadcastDeviceList() {
  const deviceList = Array.from(devices.values()).map(d => ({
    id: d.id,
    name: d.name,
    type: d.type,
    status: d.status
  }));
  
  console.log(`📢 Broadcasting device list (${deviceList.length} devices):`);
  if (deviceList.length === 0) {
    console.log(`   (no devices)`);
  } else {
    deviceList.forEach(d => {
      console.log(`   - ${d.id}: ${d.name} (${d.type}) [${d.status}]`);
    });
  }
  
  io.emit('devices', { devices: deviceList });
  console.log(`📢 Device list broadcasted to all clients`);
}

/**
 * Remote trigger function to start mirroring on a specific device.
 * 
 * @param {string} targetDeviceId - The ANDROID_ID of the target device
 * @param {object} options - Optional parameters (quality, etc.)
 * @returns {boolean} - true if request was sent, false if device not found
 */
function startMirroring(targetDeviceId, options = {}) {
  const device = devices.get(targetDeviceId);
  if (device) {
    const quality = options.quality || 'high';
    io.to(device.socketId).emit('REQUEST_MIRROR', { quality });
    console.log(`📤 Sent REQUEST_MIRROR to ${targetDeviceId} (${device.name}) with quality: ${quality}`);
    return true;
  } else {
    console.log(`⚠️  Device not found or offline: ${targetDeviceId}`);
    return false;
  }
}

// Export for use in other modules or API endpoints
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { startMirroring, devices };
}

// Start the HTTP server
server.listen(PORT, () => {
  console.log(`✨ Signaling server ready on port ${PORT}`);
  console.log(`📡 Waiting for connections...`);
  console.log(`🌐 Web interface: http://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  server.close();
  io.close();
  process.exit(0);
});
