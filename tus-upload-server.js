const { Server } = require('@tus/server');
const { FileStore } = require('@tus/file-store');
const path = require('path');
const fs = require('fs').promises;

// Configuration
const UPLOAD_DIR = path.join(__dirname, 'uploads/tus-temp');
const FINAL_DIR = path.join(__dirname, 'uploads/completed');
const MAX_FILE_SIZE = 10 * 1024 * 1024 * 1024; // 10GB
const EXPIRATION_TIME = 24 * 60 * 60 * 1000; // 24 hours

// Ensure directories exist
async function ensureDirectories() {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  await fs.mkdir(FINAL_DIR, { recursive: true });
  console.log('📁 TUS upload directories created');
}

ensureDirectories().catch(console.error);

// Create TUS server instance
const tusServer = new Server({
  path: '/tus',
  datastore: new FileStore({
    directory: UPLOAD_DIR,
    // Disk-based storage - no memory buffering
    expirationPeriodInMilliseconds: EXPIRATION_TIME
  }),

  // Memory-efficient settings for 1GB RAM VPS
  maxSize: MAX_FILE_SIZE,
  respectForwardedHeaders: true,

  // Hooks for custom logic
  async onUploadCreate(req, res, upload) {
    // Validate deviceId from metadata
    const deviceId = upload.metadata?.deviceId;
    if (!deviceId) {
      throw new Error('deviceId is required in metadata');
    }

    console.log(`📤 Upload created: ${upload.id} by device ${deviceId}`);
    console.log(`   Filename: ${upload.metadata?.filename || 'unknown'}`);
    console.log(`   Size: ${(upload.size / 1024 / 1024).toFixed(2)} MB`);

    // Store deviceId for later use
    upload.metadata.deviceId = deviceId;

    return res;
  },

  async onUploadFinish(req, res, upload) {
    console.log(`✅ Upload completed: ${upload.id}`);

    try {
      // Move file from temp to final location
      const tempPath = path.join(UPLOAD_DIR, upload.id);
      const filename = upload.metadata?.filename || `file_${Date.now()}`;
      const finalPath = path.join(FINAL_DIR, filename);

      await fs.rename(tempPath, finalPath);

      console.log(`   Moved to: ${finalPath}`);

      // Emit completion event via socket.io
      const io = req.app.get('io');
      if (io) {
        io.emit('ftp-upload-complete', {
          uploadId: upload.id,
          deviceId: upload.metadata?.deviceId,
          filename: filename,
          size: upload.size,
          path: finalPath
        });
      }

      // Clean up metadata file
      const metaPath = `${tempPath}.json`;
      await fs.unlink(metaPath).catch(() => {});

    } catch (err) {
      console.error(`❌ Error finalizing upload ${upload.id}:`, err);
      throw err;
    }

    return res;
  }
});

module.exports = { tusServer, UPLOAD_DIR, FINAL_DIR };
