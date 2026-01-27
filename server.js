const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 3001;

const io = new Server(PORT, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Store connected devices
const devices = new Map();

console.log(`🚀 Signaling server starting on port ${PORT}...`);

io.on('connection', (socket) => {
  console.log(`✅ Client connected: ${socket.id}`);

  // Device registration
  socket.on('register', (data) => {
    const deviceId = data.deviceId || uuidv4();

    devices.set(deviceId, {
      id: deviceId,
      name: data.deviceName || 'Unknown Device',
      type: data.deviceType || 'unknown',
      socketId: socket.id,
      status: 'online',
      connectedAt: new Date()
    });

    socket.deviceId = deviceId;
    socket.emit('registered', { deviceId });

    console.log(`📱 Device registered: ${deviceId} (${data.deviceName})`);

    // Broadcast device list update
    broadcastDeviceList();
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

  // Handle disconnect
  socket.on('disconnect', () => {
    if (socket.deviceId) {
      const device = devices.get(socket.deviceId);
      if (device) {
        console.log(`❌ Device disconnected: ${socket.deviceId} (${device.name})`);
      }
      devices.delete(socket.deviceId);
      broadcastDeviceList();
    }
    console.log(`❌ Client disconnected: ${socket.id}`);
  });

  // Handle errors
  socket.on('error', (error) => {
    console.error(`❌ Socket error from ${socket.id}:`, error);
  });
});

function broadcastDeviceList() {
  const deviceList = Array.from(devices.values()).map(d => ({
    id: d.id,
    name: d.name,
    type: d.type,
    status: d.status
  }));
  io.emit('devices', { devices: deviceList });
  console.log(`📢 Device list broadcasted (${deviceList.length} devices)`);
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  io.close();
  process.exit(0);
});

console.log(`✨ Signaling server ready on port ${PORT}`);
console.log(`📡 Waiting for connections...`);
