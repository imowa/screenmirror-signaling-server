const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Client: FtpClient } = require('basic-ftp');
const { tusServer } = require('./tus-upload-server');

const PORT = process.env.PORT || 3001;

// Create Express app and HTTP server
const app = express();
const server = http.createServer(app);

// Attach Socket.IO to the HTTP server
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  // Increase timeouts for large file transfers
  pingTimeout: 3600000,  // 60 minutes (for 1GB+ files)
  pingInterval: 60000,   // 1 minute
  maxHttpBufferSize: 1e8  // 100MB max message size
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Make io available to TUS hooks
app.set('io', io);

// Store connected devices
const devices = new Map();

// Store pending file operation requests (for WebSocket-based file transfer)
const pendingRequests = new Map();

// Store monitored apps data: deviceId -> { apps: [], lastUpdate: timestamp }
const monitoredApps = new Map();

// Render Free Tier Optimization: Configuration
const CLEANUP_CONFIG = {
  DEVICE_TTL: 30 * 60 * 1000,        // 30 minutes - remove inactive devices
  MONITORED_APPS_TTL: 60 * 60 * 1000, // 1 hour - remove stale app data
  PENDING_REQUEST_TIMEOUT: 30 * 1000,  // 30 seconds - timeout pending requests
  CLEANUP_INTERVAL: 5 * 60 * 1000,     // 5 minutes - run cleanup
  MAX_DEVICES: 100,                     // Limit total devices
  MAX_MONITORED_APPS: 50                // Limit monitored apps
};

// Helper function to generate unique request IDs
function generateRequestId() {
  return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Render Free Tier Optimization: Cleanup Functions
function cleanupStaleDevices() {
  const now = Date.now();
  let removed = 0;

  for (const [deviceId, device] of devices.entries()) {
    const lastActivity = device.lastActivity || device.connectedAt?.getTime() || 0;
    if (now - lastActivity > CLEANUP_CONFIG.DEVICE_TTL) {
      devices.delete(deviceId);
      removed++;
      console.log(`🧹 Removed stale device: ${deviceId}`);
    }
  }

  // Enforce max devices limit
  if (devices.size > CLEANUP_CONFIG.MAX_DEVICES) {
    const sortedDevices = Array.from(devices.entries())
      .sort((a, b) => {
        const aTime = a[1].lastActivity || a[1].connectedAt?.getTime() || 0;
        const bTime = b[1].lastActivity || b[1].connectedAt?.getTime() || 0;
        return aTime - bTime;
      });

    const toRemove = devices.size - CLEANUP_CONFIG.MAX_DEVICES;
    for (let i = 0; i < toRemove; i++) {
      devices.delete(sortedDevices[i][0]);
      removed++;
    }
  }

  if (removed > 0) {
    console.log(`🧹 Cleanup: Removed ${removed} stale devices. Current: ${devices.size}`);
  }
}

function cleanupMonitoredApps() {
  const now = Date.now();
  let removed = 0;

  for (const [deviceId, data] of monitoredApps.entries()) {
    if (now - data.lastUpdate > CLEANUP_CONFIG.MONITORED_APPS_TTL) {
      monitoredApps.delete(deviceId);
      removed++;
      console.log(`🧹 Removed stale monitored apps for device: ${deviceId}`);
    }
  }

  // Enforce max limit
  if (monitoredApps.size > CLEANUP_CONFIG.MAX_MONITORED_APPS) {
    const sortedApps = Array.from(monitoredApps.entries())
      .sort((a, b) => a[1].lastUpdate - b[1].lastUpdate);

    const toRemove = monitoredApps.size - CLEANUP_CONFIG.MAX_MONITORED_APPS;
    for (let i = 0; i < toRemove; i++) {
      monitoredApps.delete(sortedApps[i][0]);
      removed++;
    }
  }

  if (removed > 0) {
    console.log(`🧹 Cleanup: Removed ${removed} stale app data. Current: ${monitoredApps.size}`);
  }
}

function cleanupPendingRequests() {
  const now = Date.now();
  let removed = 0;

  for (const [requestId, request] of pendingRequests.entries()) {
    const age = now - (request.timestamp || 0);
    if (age > CLEANUP_CONFIG.PENDING_REQUEST_TIMEOUT) {
      if (request.reject) {
        request.reject(new Error('Request timeout'));
      }
      pendingRequests.delete(requestId);
      removed++;
    }
  }

  if (removed > 0) {
    console.log(`🧹 Cleanup: Removed ${removed} timed-out requests. Current: ${pendingRequests.size}`);
  }
}

function logMemoryUsage() {
  const usage = process.memoryUsage();
  console.log(`📊 Memory: ${Math.round(usage.heapUsed / 1024 / 1024)}MB / ${Math.round(usage.heapTotal / 1024 / 1024)}MB | Devices: ${devices.size} | Apps: ${monitoredApps.size} | Requests: ${pendingRequests.size}`);
}

function runPeriodicCleanup() {
  cleanupStaleDevices();
  cleanupMonitoredApps();
  cleanupPendingRequests();
  logMemoryUsage();
}

// Start periodic cleanup
setInterval(runPeriodicCleanup, CLEANUP_CONFIG.CLEANUP_INTERVAL);
console.log(`✅ Periodic cleanup enabled (every ${CLEANUP_CONFIG.CLEANUP_INTERVAL / 1000}s)`);

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
      <title>Screen Mirror File Browser</title>
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }

        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          min-height: 100vh;
          padding: 20px;
        }

        .container {
          max-width: 1200px;
          margin: 0 auto;
        }

        .header {
          background: white;
          padding: 30px;
          border-radius: 15px;
          box-shadow: 0 10px 30px rgba(0,0,0,0.2);
          margin-bottom: 30px;
          text-align: center;
        }

        .header h1 {
          color: #667eea;
          font-size: 2.5em;
          margin-bottom: 10px;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 15px;
        }

        .header p {
          color: #666;
          font-size: 1.1em;
        }

        .device-card {
          background: white;
          border-radius: 15px;
          padding: 25px;
          margin-bottom: 20px;
          box-shadow: 0 5px 20px rgba(0,0,0,0.1);
          transition: transform 0.3s, box-shadow 0.3s;
        }

        .device-card:hover {
          transform: translateY(-5px);
          box-shadow: 0 10px 30px rgba(0,0,0,0.2);
        }

        .device-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 15px;
          padding-bottom: 15px;
          border-bottom: 2px solid #f0f0f0;
        }

        .device-info h3 {
          color: #333;
          font-size: 1.5em;
          margin-bottom: 5px;
        }

        .device-meta {
          display: flex;
          gap: 20px;
          flex-wrap: wrap;
          margin-top: 10px;
        }

        .meta-item {
          display: flex;
          align-items: center;
          gap: 8px;
          color: #666;
          font-size: 0.95em;
        }

        .status-badge {
          display: inline-block;
          padding: 5px 15px;
          border-radius: 20px;
          font-size: 0.85em;
          font-weight: 600;
        }

        .status-online {
          background: #d4edda;
          color: #155724;
        }

        .status-offline {
          background: #f8d7da;
          color: #721c24;
        }

        .browse-btn {
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
          border: none;
          padding: 12px 30px;
          border-radius: 25px;
          font-size: 1em;
          font-weight: 600;
          cursor: pointer;
          transition: transform 0.2s, box-shadow 0.2s;
        }

        .browse-btn:hover {
          transform: scale(1.05);
          box-shadow: 0 5px 15px rgba(102, 126, 234, 0.4);
        }

        .files-container {
          margin-top: 20px;
          background: #f8f9fa;
          border-radius: 10px;
          padding: 20px;
        }

        .breadcrumb {
          background: white;
          padding: 15px 20px;
          border-radius: 10px;
          margin-bottom: 15px;
          display: flex;
          align-items: center;
          gap: 10px;
          font-size: 0.95em;
          color: #666;
        }

        .breadcrumb a {
          color: #667eea;
          text-decoration: none;
          font-weight: 600;
          transition: color 0.2s;
        }

        .breadcrumb a:hover {
          color: #764ba2;
        }

        .file-list {
          display: grid;
          gap: 10px;
        }

        .file-item {
          background: white;
          padding: 15px 20px;
          border-radius: 10px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          transition: all 0.2s;
          cursor: pointer;
        }

        .file-item:hover {
          background: #f0f0f0;
          transform: translateX(5px);
        }

        .file-info {
          display: flex;
          align-items: center;
          gap: 15px;
          flex: 1;
        }

        .file-icon {
          font-size: 1.8em;
        }

        .file-details {
          flex: 1;
        }

        .file-name {
          font-weight: 600;
          color: #333;
          margin-bottom: 3px;
        }

        .file-size {
          font-size: 0.85em;
          color: #999;
        }

        .download-btn {
          background: #28a745;
          color: white;
          border: none;
          padding: 8px 20px;
          border-radius: 20px;
          font-size: 0.9em;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.2s;
        }

        .download-btn:hover {
          background: #218838;
          transform: scale(1.05);
        }

        .loading {
          text-align: center;
          padding: 40px;
          color: #666;
          font-style: italic;
        }

        .error {
          background: #f8d7da;
          color: #721c24;
          padding: 15px 20px;
          border-radius: 10px;
          border-left: 4px solid #f5c6cb;
        }

        .no-devices {
          text-align: center;
          padding: 60px 20px;
          background: white;
          border-radius: 15px;
          box-shadow: 0 5px 20px rgba(0,0,0,0.1);
        }

        .no-devices h2 {
          color: #666;
          margin-bottom: 10px;
        }

        .no-devices p {
          color: #999;
        }

        .server-status {
          margin-top: 20px;
          padding: 15px;
          background: #f8f9fa;
          border-radius: 10px;
          display: flex;
          justify-content: center;
          gap: 30px;
          flex-wrap: wrap;
          font-size: 0.9em;
        }

        .status-item {
          display: flex;
          align-items: center;
          gap: 8px;
          color: #555;
        }

        .status-item strong {
          color: #333;
        }

        .status-online-badge {
          display: inline-block;
          width: 8px;
          height: 8px;
          background: #28a745;
          border-radius: 50%;
          animation: pulse 2s infinite;
        }

        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }

        .render-warning {
          margin-top: 15px;
          padding: 12px;
          background: #fff3cd;
          border-left: 4px solid #ffc107;
          border-radius: 5px;
          font-size: 0.85em;
          color: #856404;
        }

        @media (max-width: 768px) {
          .header h1 { font-size: 1.8em; }
          .device-header { flex-direction: column; align-items: flex-start; gap: 15px; }
          .file-item { flex-direction: column; align-items: flex-start; gap: 10px; }
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>📱 Screen Mirror File Browser</h1>
          <p>Access and download files from your connected devices</p>
          <div id="server-status" class="server-status"></div>
          <div class="render-warning" style="display:none;" id="render-warning">
            ⚠️ <strong>Free Tier Notice:</strong> Server may spin down after 15 minutes of inactivity. First request after spin-down may take 30-50 seconds.
          </div>
        </div>
        <div id="devices"></div>
      </div>

      <script>
        let currentDevice = null;
        let currentPath = '/';

        async function loadServerStatus() {
          try {
            const res = await fetch('/health');
            const data = await res.json();

            const statusDiv = document.getElementById('server-status');
            const uptimeMinutes = Math.floor(data.uptime / 60);
            const uptimeHours = Math.floor(uptimeMinutes / 60);
            const displayUptime = uptimeHours > 0
              ? \`\${uptimeHours}h \${uptimeMinutes % 60}m\`
              : \`\${uptimeMinutes}m\`;

            statusDiv.innerHTML = \`
              <div class="status-item">
                <span class="status-online-badge"></span>
                <strong>Status:</strong> Online
              </div>
              <div class="status-item">
                <strong>⏱️ Uptime:</strong> \${displayUptime}
              </div>
              <div class="status-item">
                <strong>💾 Memory:</strong> \${data.memory.heapUsed}MB / \${data.memory.heapTotal}MB
              </div>
              <div class="status-item">
                <strong>📱 Devices:</strong> \${data.stats.devices}
              </div>
            \`;

            // Show Render warning if uptime is low (recently started)
            if (data.uptime < 300) { // Less than 5 minutes
              document.getElementById('render-warning').style.display = 'block';
            }
          } catch (err) {
            console.error('Failed to load server status:', err);
            document.getElementById('server-status').innerHTML = \`
              <div class="status-item" style="color: #dc3545;">
                ⚠️ Unable to fetch server status
              </div>
            \`;
          }
        }

        async function loadDevices() {
          const res = await fetch('/api/devices');
          const data = await res.json();
          const devicesDiv = document.getElementById('devices');

          if (data.devices.length === 0) {
            devicesDiv.innerHTML = \`
              <div class="no-devices">
                <h2>📱 No Devices Connected</h2>
                <p>Connect your Android device to start browsing files</p>
              </div>
            \`;
            return;
          }

          // Save current file browser state before re-rendering
          const savedStates = {};
          data.devices.forEach(device => {
            const filesDiv = document.getElementById(\`files-\${device.id}\`);
            if (filesDiv) {
              savedStates[device.id] = {
                display: filesDiv.style.display,
                innerHTML: filesDiv.innerHTML
              };
            }
          });

          devicesDiv.innerHTML = data.devices.map(device => {
            const statusClass = device.status === 'online' ? 'status-online' : 'status-offline';
            const statusText = device.status === 'online' ? '🟢 Online' : '🔴 Offline';

            return \`
              <div class="device-card">
                <div class="device-header">
                  <div class="device-info">
                    <h3>\${device.name}</h3>
                    <div class="device-meta">
                      <span class="meta-item">🆔 \${device.id}</span>
                      <span class="meta-item">📱 \${device.type}</span>
                      <span class="meta-item">🌐 \${device.ipAddress || 'Unknown'}</span>
                    </div>
                  </div>
                  <div>
                    <span class="status-badge \${statusClass}">\${statusText}</span>
                  </div>
                </div>
                <button class="browse-btn" onclick="browseDevice('\${device.id}')">
                  📂 Browse Files
                </button>
                <div id="files-\${device.id}" class="files-container" style="display:none;"></div>
              </div>
            \`;
          }).join('');

          // Restore file browser state after re-rendering
          data.devices.forEach(device => {
            if (savedStates[device.id]) {
              const filesDiv = document.getElementById(\`files-\${device.id}\`);
              if (filesDiv) {
                filesDiv.style.display = savedStates[device.id].display;
                filesDiv.innerHTML = savedStates[device.id].innerHTML;
              }
            }
          });
        }

        async function browseDevice(deviceId, path = '/', sortBy = 'date-desc', offset = 0, append = false) {
          console.log('🔍 browseDevice called:', { deviceId, path, sortBy, offset, append });
          currentDevice = { id: deviceId };
          currentPath = path;

          const filesDiv = document.getElementById(\`files-\${deviceId}\`);
          console.log('📂 filesDiv found:', filesDiv ? 'yes' : 'no');
          filesDiv.style.display = 'block';

          if (!append) {
            filesDiv.innerHTML = '<p class="loading">⏳ Loading files...</p>';
          }

          try {
            const res = await fetch(\`/api/ftp/browse?deviceId=\${deviceId}&path=\${encodeURIComponent(path)}&limit=200&offset=\${offset}&sortBy=\${sortBy}\`);
            const data = await res.json();

            if (data.error) {
              filesDiv.innerHTML = \`<div class="error">❌ \${data.error}</div>\`;
              return;
            }

            // Breadcrumb navigation with sort controls
            let html = '';
            if (!append) {
              html = \`<div class="breadcrumb">
                <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
                  <div>
                    📍 <strong>Path:</strong> \${path}
                    \${path !== '/' ? \`<a href="#" onclick="browseDevice('\${deviceId}', '/'); return false;">🏠 Home</a>\` : ''}
                    \${path !== '/' ? \`<a href="#" onclick="browseDevice('\${deviceId}', '\${path.split('/').slice(0, -1).join('/') || '/'}'); return false;">⬆️ Up</a>\` : ''}
                  </div>
                  <div style="display: flex; align-items: center; gap: 8px;">
                    <label style="font-size: 0.9em; color: #666;">Sort by:</label>
                    <select id="sort-\${deviceId}" onchange="browseDevice('\${deviceId}', '\${path}', this.value, 0, false)" style="padding: 5px 10px; border-radius: 5px; border: 1px solid #ddd; background: white; cursor: pointer;">
                      <option value="date-desc" \${sortBy === 'date-desc' ? 'selected' : ''}>Date (Newest)</option>
                      <option value="date-asc" \${sortBy === 'date-asc' ? 'selected' : ''}>Date (Oldest)</option>
                      <option value="size-desc" \${sortBy === 'size-desc' ? 'selected' : ''}>Size (Largest)</option>
                      <option value="size-asc" \${sortBy === 'size-asc' ? 'selected' : ''}>Size (Smallest)</option>
                      <option value="name-asc" \${sortBy === 'name-asc' ? 'selected' : ''}>Name (A-Z)</option>
                      <option value="name-desc" \${sortBy === 'name-desc' ? 'selected' : ''}>Name (Z-A)</option>
                    </select>
                  </div>
                </div>
              </div>\`;
            }

            // File list
            html += '<div class="file-list">';

            if (data.files.length === 0) {
              html += '<div class="error">📭 This folder is empty</div>';
            } else {
              html += data.files.map(file => {
                if (file.type === 'directory') {
                  // Always construct path from current path + file name (don't use file.path for navigation)
                  const newPath = path === '/' ? \`/\${file.name}\` : \`\${path}/\${file.name}\`;
                  return \`
                    <div class="file-item" onclick="browseDevice('\${deviceId}', '\${newPath}')">
                      <div class="file-info">
                        <div class="file-icon">📁</div>
                        <div class="file-details">
                          <div class="file-name">\${file.name}</div>
                          <div class="file-size">Folder</div>
                        </div>
                      </div>
                    </div>
                  \`;
                } else {
                  // For files, use file.path if available (for downloads)
                  const filePath = file.path || (path === '/' ? \`/\${file.name}\` : \`\${path}/\${file.name}\`);
                  const fileSize = formatFileSize(file.size);
                  const fileIcon = getFileIcon(file.name);

                  return \`
                    <div class="file-item">
                      <div class="file-info">
                        <div class="file-icon">\${fileIcon}</div>
                        <div class="file-details">
                          <div class="file-name">\${file.name}</div>
                          <div class="file-size">\${fileSize}</div>
                        </div>
                      </div>
                      <button class="download-btn" onclick="downloadFile('\${deviceId}', '\${filePath}', '\${file.name}'); event.stopPropagation();">
                        ⬇️ Download
                      </button>
                    </div>
                  \`;
                }
              }).join('');
            }

            html += '</div>';

            // Add "Load More" button if there are more files
            if (data.hasMore) {
              html += \`
                <div style="text-align: center; padding: 20px;">
                  <button class="download-btn" onclick="browseDevice('\${deviceId}', '\${path}', '\${sortBy}', \${offset + data.files.length}, true)" style="padding: 10px 30px; font-size: 1em;">
                    📄 Load More Files
                  </button>
                  <p style="color: #666; font-size: 0.9em; margin-top: 10px;">Showing \${offset + data.files.length} files</p>
                </div>
              \`;
            } else if (offset > 0) {
              html += \`
                <div style="text-align: center; padding: 20px;">
                  <p style="color: #666; font-size: 0.9em;">✅ All files loaded (\${offset + data.files.length} total)</p>
                </div>
              \`;
            }

            // Update DOM - append or replace
            if (append) {
              // Append mode: add new files to existing list
              const fileListDiv = filesDiv.querySelector('.file-list');
              if (fileListDiv) {
                const tempDiv = document.createElement('div');
                tempDiv.innerHTML = html;
                const newFileList = tempDiv.querySelector('.file-list');
                if (newFileList) {
                  fileListDiv.innerHTML += newFileList.innerHTML;
                }
                // Update or add "Load More" button
                const existingLoadMore = filesDiv.querySelector('.file-list').nextElementSibling;
                if (existingLoadMore) {
                  existingLoadMore.remove();
                }
                const loadMoreDiv = tempDiv.querySelector('.file-list').nextElementSibling;
                if (loadMoreDiv) {
                  filesDiv.appendChild(loadMoreDiv);
                }
              }
            } else {
              // Replace mode: show new content
              filesDiv.innerHTML = html;
            }

            console.log('✅ File list displayed:', data.files.length, 'items', append ? '(appended)' : '(replaced)');
          } catch (err) {
            console.error('❌ Error browsing device:', err);
            filesDiv.innerHTML = \`<div class="error">❌ Error: \${err.message}</div>\`;
          }
        }

        function formatFileSize(bytes) {
          if (bytes === 0) return '0 Bytes';
          const k = 1024;
          const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
          const i = Math.floor(Math.log(bytes) / Math.log(k));
          return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
        }

        function getFileIcon(filename) {
          const ext = filename.split('.').pop().toLowerCase();
          const iconMap = {
            // Images
            'jpg': '🖼️', 'jpeg': '🖼️', 'png': '🖼️', 'gif': '🖼️', 'bmp': '🖼️', 'svg': '🖼️', 'webp': '🖼️',
            // Videos
            'mp4': '🎥', 'avi': '🎥', 'mkv': '🎥', 'mov': '🎥', 'wmv': '🎥', 'flv': '🎥', 'webm': '🎥',
            // Audio
            'mp3': '🎵', 'wav': '🎵', 'flac': '🎵', 'aac': '🎵', 'ogg': '🎵', 'm4a': '🎵',
            // Documents
            'pdf': '📕', 'doc': '📘', 'docx': '📘', 'txt': '📄', 'rtf': '📄',
            'xls': '📊', 'xlsx': '📊', 'csv': '📊',
            'ppt': '📙', 'pptx': '📙',
            // Archives
            'zip': '📦', 'rar': '📦', '7z': '📦', 'tar': '📦', 'gz': '📦',
            // Code
            'js': '📜', 'html': '📜', 'css': '📜', 'json': '📜', 'xml': '📜',
            'java': '☕', 'py': '🐍', 'cpp': '⚙️', 'c': '⚙️',
            // APK
            'apk': '📱'
          };
          return iconMap[ext] || '📄';
        }

        function downloadFile(deviceId, remotePath, filename) {
          window.location.href = \`/api/ftp/download?deviceId=\${deviceId}&path=\${encodeURIComponent(remotePath)}&filename=\${encodeURIComponent(filename)}\`;
        }

        // Load devices on page load
        loadServerStatus();
        loadDevices();

        // Refresh devices every 5 seconds
        setInterval(loadServerStatus, 30000); // Update server status every 30 seconds
        setInterval(loadDevices, 5000);
      </script>
    </body>
    </html>
  `);
});

// Health check endpoint for Render free tier (prevents spin-down)
app.get('/health', (req, res) => {
  const uptime = process.uptime();
  const memory = process.memoryUsage();

  res.status(200).json({
    status: 'ok',
    uptime: Math.floor(uptime),
    memory: {
      heapUsed: Math.round(memory.heapUsed / 1024 / 1024),
      heapTotal: Math.round(memory.heapTotal / 1024 / 1024),
      rss: Math.round(memory.rss / 1024 / 1024)
    },
    stats: {
      devices: devices.size,
      monitoredApps: monitoredApps.size,
      pendingRequests: pendingRequests.size
    },
    timestamp: new Date().toISOString()
  });
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
    lastActivity: Date.now(),
    ipAddress: ipAddress
  });

  console.log(`📊 Total devices: ${devices.size}`);

  // Broadcast updated device list
  broadcastDeviceList();

  res.json({ success: true, deviceId });
});

app.get('/api/ftp/browse', async (req, res) => {
  const {
    deviceId,
    path = '/',
    limit = '200',
    offset = '0',
    sortBy = 'date-desc'
  } = req.query;

  if (!deviceId) {
    return res.status(400).json({ error: 'deviceId is required' });
  }

  // Parse pagination parameters
  const limitNum = parseInt(limit, 10);
  const offsetNum = parseInt(offset, 10);

  if (isNaN(limitNum) || limitNum < 1 || limitNum > 1000) {
    return res.status(400).json({ error: 'limit must be between 1 and 1000' });
  }

  if (isNaN(offsetNum) || offsetNum < 0) {
    return res.status(400).json({ error: 'offset must be >= 0' });
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
    console.log(`📤 Sending file list request to ${deviceId}: path=${path}, limit=${limitNum}, offset=${offsetNum}, sortBy=${sortBy}, requestId=${requestId}`);

    // Create promise to wait for response
    const responsePromise = new Promise((resolve, reject) => {
      pendingRequests.set(requestId, { resolve, reject, timestamp: Date.now() });

      // Set timeout (30 seconds)
      setTimeout(() => {
        if (pendingRequests.has(requestId)) {
          pendingRequests.delete(requestId);
          reject(new Error('Request timeout'));
        }
      }, 30000);
    });

    // Send request to device via WebSocket with pagination and sorting
    io.to(device.socketId).emit('ftp-list-request', {
      requestId,
      path,
      limit: limitNum,
      offset: offsetNum,
      sortBy
    });

    // Wait for response
    const result = await responsePromise;
    res.json(result);
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

    // Set timeout (60 minutes for 1GB+ files)
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
    }, 3600000); // 60 minutes

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

// VPS upload endpoint - request device to upload file to VPS
app.post('/api/vps/upload', async (req, res) => {
  const { deviceId, path } = req.body;

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
    console.log(`📤 Sending VPS upload request to ${deviceId}: path=${path}, requestId=${requestId}`);

    // Send request to device via WebSocket
    io.to(device.socketId).emit('vps-upload-request', {
      requestId,
      path
    });

    // Return requestId immediately - client will listen for response via WebSocket
    res.json({
      success: true,
      requestId,
      message: 'Upload request sent to device. Listen for vps-upload-response event.'
    });

    console.log(`✅ VPS upload request sent: requestId=${requestId}`);
  } catch (err) {
    console.error(`Error in /api/vps/upload: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// APP MONITORING ENDPOINTS
// ============================================

// Sync full app list from device
app.post('/api/apps/sync', (req, res) => {
  const { deviceId, apps, timestamp } = req.body;

  if (!deviceId || !apps) {
    return res.status(400).json({ error: 'deviceId and apps are required' });
  }

  console.log(`📱 App sync from ${deviceId}: ${apps.length} apps`);

  // Store app data
  monitoredApps.set(deviceId, {
    apps: apps,
    lastUpdate: timestamp || Date.now()
  });

  res.json({ success: true, appsReceived: apps.length });
});

// Update a single app
app.post('/api/apps/update', (req, res) => {
  const { deviceId, app } = req.body;

  if (!deviceId || !app) {
    return res.status(400).json({ error: 'deviceId and app are required' });
  }

  console.log(`📱 App update from ${deviceId}: ${app.appName}`);

  // Get existing data or create new
  const deviceData = monitoredApps.get(deviceId) || { apps: [], lastUpdate: Date.now() };

  // Find and update or add app
  const existingIndex = deviceData.apps.findIndex(a => a.packageName === app.packageName);
  if (existingIndex >= 0) {
    deviceData.apps[existingIndex] = app;
  } else {
    deviceData.apps.push(app);
  }

  deviceData.lastUpdate = Date.now();
  monitoredApps.set(deviceId, deviceData);

  res.json({ success: true });
});

// Remove an app
app.post('/api/apps/remove', (req, res) => {
  const { deviceId, packageName } = req.body;

  if (!deviceId || !packageName) {
    return res.status(400).json({ error: 'deviceId and packageName are required' });
  }

  console.log(`📱 App remove from ${deviceId}: ${packageName}`);

  const deviceData = monitoredApps.get(deviceId);
  if (deviceData) {
    deviceData.apps = deviceData.apps.filter(a => a.packageName !== packageName);
    deviceData.lastUpdate = Date.now();
    monitoredApps.set(deviceId, deviceData);
  }

  res.json({ success: true });
});

// Get app list for a device
app.get('/api/apps/list', (req, res) => {
  const { deviceId } = req.query;

  if (!deviceId) {
    return res.status(400).json({ error: 'deviceId is required' });
  }

  const deviceData = monitoredApps.get(deviceId);
  if (!deviceData) {
    return res.json({ apps: [], lastUpdate: null });
  }

  res.json({
    apps: deviceData.apps,
    lastUpdate: deviceData.lastUpdate,
    totalApps: deviceData.apps.length
  });
});

// ============================================
// TUS Upload Routes (Resumable Uploads)
// ============================================

// TUS upload endpoint - handles all TUS protocol requests
app.all('/tus/*', (req, res) => {
  tusServer.handle(req, res);
});

// Get upload status endpoint
app.get('/api/tus/status/:uploadId', async (req, res) => {
  try {
    const upload = await tusServer.getUpload(req.params.uploadId);
    res.json({
      id: upload.id,
      size: upload.size,
      offset: upload.offset,
      metadata: upload.metadata,
      percentage: Math.round((upload.offset / upload.size) * 100)
    });
  } catch (err) {
    res.status(404).json({ error: 'Upload not found' });
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
        lastActivity: Date.now(),
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
        lastActivity: Date.now(),
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
    const { requestId, files, hasMore, totalCount, error } = data;
    console.log(`📂 Received file list response: requestId=${requestId}, files=${files?.length || 0}, hasMore=${hasMore}, totalCount=${totalCount}, error=${error || 'none'}`);

    // Resolve pending request if exists
    const pendingRequest = pendingRequests.get(requestId);
    if (pendingRequest) {
      if (error) {
        pendingRequest.reject(new Error(error));
      } else {
        pendingRequest.resolve({ files, hasMore, totalCount });
      }
      pendingRequests.delete(requestId);
    }

    // Also emit to all connected web clients for real-time updates
    io.emit('ftp-list-response', {
      requestId,
      deviceId: socket.deviceId,
      files,
      hasMore,
      totalCount,
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

  // Handle VPS upload response from device
  socket.on('vps-upload-response', (data) => {
    const { requestId, downloadUrl, error } = data;
    console.log(`📤 Received VPS upload response: requestId=${requestId}, downloadUrl=${downloadUrl}, error=${error}`);

    // Emit to all connected web clients
    io.emit('vps-upload-response', {
      requestId,
      deviceId: socket.deviceId,
      downloadUrl,
      error
    });
  });

  // Handle TUS upload progress from device
  socket.on('ftp-upload-progress', (data) => {
    const { uploadId, bytesUploaded, totalBytes, percentage } = data;
    console.log(`📊 Upload progress: uploadId=${uploadId}, ${percentage}% (${bytesUploaded}/${totalBytes} bytes)`);

    // Broadcast to all connected web clients
    io.emit('ftp-upload-progress', {
      uploadId,
      deviceId: socket.deviceId,
      bytesUploaded,
      totalBytes,
      percentage
    });
  });

  // Handle file browse request from web client
  socket.on('browse-files-request', (data) => {
    const { requestId, deviceId, path } = data;
    console.log(`📁 Browse files request: deviceId=${deviceId}, path=${path}, requestId=${requestId}`);

    const device = devices.get(deviceId);
    if (!device) {
      socket.emit('browse-files-response', {
        requestId,
        error: 'Device not found'
      });
      return;
    }

    // Forward request to Android device
    io.to(device.socketId).emit('browse-files-request', {
      requestId,
      path
    });
  });

  // Handle file browse response from device
  socket.on('browse-files-response', (data) => {
    const { requestId, files, error } = data;
    console.log(`📁 Received browse files response: requestId=${requestId}, files=${files?.length || 0}, error=${error}`);

    // Emit to all connected web clients
    io.emit('browse-files-response', {
      requestId,
      deviceId: socket.deviceId,
      files,
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

// ============================================
// TUS Upload Cleanup Job
// ============================================

const fs = require('fs').promises;
const path = require('path');
const { UPLOAD_DIR } = require('./tus-upload-server');

// Clean up abandoned uploads every 6 hours
const CLEANUP_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours
const MAX_UPLOAD_AGE = 24 * 60 * 60 * 1000; // 24 hours

async function cleanupAbandonedUploads() {
  console.log('🧹 Running TUS upload cleanup...');

  try {
    const files = await fs.readdir(UPLOAD_DIR);
    const now = Date.now();
    let deletedCount = 0;

    for (const file of files) {
      const filePath = path.join(UPLOAD_DIR, file);
      const stats = await fs.stat(filePath);

      // Delete files older than 24 hours
      if (now - stats.mtimeMs > MAX_UPLOAD_AGE) {
        await fs.unlink(filePath);
        deletedCount++;
        console.log(`   Deleted abandoned upload: ${file}`);
      }
    }

    if (deletedCount > 0) {
      console.log(`✅ Cleanup completed: ${deletedCount} file(s) deleted`);
    } else {
      console.log('✅ Cleanup completed: No abandoned uploads found');
    }
  } catch (err) {
    console.error('❌ Cleanup error:', err);
  }
}

// Run cleanup on startup
cleanupAbandonedUploads();

// Schedule periodic cleanup
setInterval(cleanupAbandonedUploads, CLEANUP_INTERVAL);

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
