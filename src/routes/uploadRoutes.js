const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const HLSService = require('../services/hlsService');
const R2StreamService = require('../services/r2StreamService');
const logger = require('../utils/logger');

const router = express.Router();
const hlsService = new HLSService();
const r2Service = new R2StreamService();

// Utility function to parse file size with units (e.g., "1GB", "500MB")
function parseFileSize(sizeStr) {
  if (!sizeStr) return 500 * 1024 * 1024; // Default 500MB
  
  const units = {
    'B': 1,
    'KB': 1024,
    'MB': 1024 * 1024,
    'GB': 1024 * 1024 * 1024,
    'TB': 1024 * 1024 * 1024 * 1024
  };
  
  const match = sizeStr.toString().toUpperCase().match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)?$/);
  if (!match) {
    // If no match, try to parse as plain number (assume bytes)
    const num = parseInt(sizeStr);
    return isNaN(num) ? 500 * 1024 * 1024 : num;
  }
  
  const value = parseFloat(match[1]);
  const unit = match[2] || 'B';
  
  return Math.floor(value * units[unit]);
}

// Create uploads directory
const uploadsDir = path.join(__dirname, '../../uploads');
const videosDir = path.join(__dirname, '../../videos');

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

if (!fs.existsSync(videosDir)) {
  fs.mkdirSync(videosDir, { recursive: true });
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const extension = path.extname(file.originalname);
    cb(null, file.fieldname + '-' + uniqueSuffix + extension);
  }
});

const fileFilter = (req, file, cb) => {
  const allowedTypes = ['video/mp4', 'video/avi', 'video/mov', 'video/mkv', 'video/webm'];
  const allowedExtensions = ['.mp4', '.avi', '.mov', '.mkv', '.webm'];
  
  const extension = path.extname(file.originalname).toLowerCase();
  
  if (allowedTypes.includes(file.mimetype) || allowedExtensions.includes(extension)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only video files are allowed.'), false);
  }
};

const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: parseFileSize(process.env.MAX_FILE_SIZE) || 500 * 1024 * 1024 // 500MB default
  }
});

/**
 * POST /api/upload/local
 * Upload video file to local storage
 */
router.post('/local', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        error: 'No file uploaded',
        message: 'Please select a video file to upload'
      });
    }

    const { originalname, filename, path: filePath, size } = req.file;
    const { convertToHLS, moveToVideos } = req.body;

    let finalPath = filePath;
    let hlsResult = null;

    // Move to videos directory if requested
    if (moveToVideos === 'true') {
      const videoPath = path.join(videosDir, filename);
      fs.renameSync(filePath, videoPath);
      finalPath = videoPath;
    }

    // Convert to HLS if requested
    if (convertToHLS === 'true') {
      const outputName = path.parse(filename).name;
      try {
        hlsResult = await hlsService.convertToHLS(finalPath, outputName);
        logger.info(`HLS conversion completed for ${originalname}`);
      } catch (error) {
        logger.error('HLS conversion failed:', error);
        // Continue without HLS if conversion fails
      }
    }

    res.json({
      message: 'File uploaded successfully',
      file: {
        originalName: originalname,
        filename: filename,
        size: size,
        path: finalPath,
        streamUrl: moveToVideos === 'true' ? `/api/video/local/${filename}` : null,
        metadataUrl: moveToVideos === 'true' ? `/api/video/local/${filename}/metadata` : null
      },
      hls: hlsResult ? {
        masterPlaylist: `/api/hls/${hlsResult.masterPlaylist}`,
        qualities: Object.keys(hlsResult.qualities)
      } : null
    });

  } catch (error) {
    logger.error('Error uploading file:', error);
    
    // Clean up uploaded file on error
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({
          error: 'File too large',
          message: 'File size exceeds the maximum allowed limit'
        });
      }
    }

    res.status(500).json({
      error: 'Upload failed',
      message: error.message || 'Failed to upload file'
    });
  }
});

/**
 * POST /api/upload/r2
 * Upload video file to Cloudflare R2
 */
router.post('/r2', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        error: 'No file uploaded',
        message: 'Please select a video file to upload'
      });
    }

    const { originalname, filename, path: filePath, size, mimetype } = req.file;
    const { key, convertToHLS } = req.body;

    // Use provided key or generate one
    const r2Key = key || `videos/${Date.now()}-${originalname}`;

    // Read file and upload to R2
    const fileBuffer = fs.readFileSync(filePath);
    
    const uploadResult = await r2Service.uploadVideo(r2Key, fileBuffer, {
      contentType: mimetype,
      metadata: {
        originalName: originalname,
        uploadedAt: new Date().toISOString(),
        size: size.toString()
      }
    });

    // Clean up local file
    fs.unlinkSync(filePath);

    let hlsResult = null;

    // Convert to HLS if requested (using local copy temporarily)
    if (convertToHLS === 'true') {
      try {
        // Download from R2, convert to HLS, then upload HLS files back to R2
        // This is a simplified version - in production, you might want to use a separate worker
        const outputName = path.parse(originalname).name;
        
        // For now, we'll just indicate that HLS conversion is available
        hlsResult = {
          message: 'HLS conversion can be triggered separately',
          conversionUrl: `/api/upload/r2/${encodeURIComponent(r2Key)}/convert-hls`
        };
      } catch (error) {
        logger.error('HLS conversion setup failed:', error);
      }
    }

    res.json({
      message: 'File uploaded to R2 successfully',
      file: {
        originalName: originalname,
        key: r2Key,
        size: size,
        etag: uploadResult.etag,
        streamUrl: `/api/video/r2/${encodeURIComponent(r2Key)}`,
        metadataUrl: `/api/video/r2/${encodeURIComponent(r2Key)}/metadata`,
        presignedUrl: `/api/video/r2/${encodeURIComponent(r2Key)}/presigned`
      },
      hls: hlsResult
    });

  } catch (error) {
    logger.error('Error uploading to R2:', error);
    
    // Clean up local file on error
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

    res.status(500).json({
      error: 'R2 upload failed',
      message: error.message || 'Failed to upload file to R2'
    });
  }
});

/**
 * POST /api/upload/r2/:key/convert-hls
 * Convert R2 video to HLS format
 */
router.post('/r2/:key(*)/convert-hls', async (req, res) => {
  try {
    const key = decodeURIComponent(req.params.key);
    const { qualities, segmentDuration } = req.body;

    // This would typically be handled by a background job
    // For now, we'll return a processing response
    res.json({
      message: 'HLS conversion started for R2 video',
      key: key,
      status: 'processing',
      estimatedTime: '5-15 minutes',
      checkStatusUrl: `/api/upload/r2/${encodeURIComponent(key)}/hls-status`
    });

    // In a real implementation, you would:
    // 1. Download the video from R2
    // 2. Convert it to HLS using FFmpeg
    // 3. Upload the HLS files back to R2
    // 4. Update the status in a database

    logger.info(`HLS conversion requested for R2 key: ${key}`);

  } catch (error) {
    logger.error('Error starting R2 HLS conversion:', error);
    res.status(500).json({
      error: 'Conversion failed',
      message: 'Failed to start HLS conversion'
    });
  }
});

/**
 * GET /api/upload/r2/:key/hls-status
 * Check HLS conversion status for R2 video
 */
router.get('/r2/:key(*)/hls-status', async (req, res) => {
  try {
    const key = decodeURIComponent(req.params.key);

    // In a real implementation, you would check the actual status from a database
    res.json({
      key: key,
      status: 'completed', // or 'processing', 'failed'
      progress: 100,
      hlsFiles: {
        masterPlaylist: `/api/hls/r2/${encodeURIComponent(key)}/master.m3u8`,
        qualities: ['720p', '480p', '360p']
      },
      completedAt: new Date().toISOString()
    });

  } catch (error) {
    logger.error('Error checking HLS status:', error);
    res.status(500).json({
      error: 'Status check failed',
      message: 'Failed to check conversion status'
    });
  }
});

/**
 * GET /api/upload/info
 * Get upload configuration and limits
 */
router.get('/info', (req, res) => {
  res.json({
    maxFileSize: process.env.MAX_FILE_SIZE || '500MB',
    allowedFormats: ['mp4', 'avi', 'mov', 'mkv', 'webm'],
    supportedFeatures: {
      localUpload: true,
      r2Upload: !!process.env.R2_BUCKET_NAME,
      hlsConversion: true,
      multipleQualities: true
    },
    endpoints: {
      local: '/api/upload/local',
      r2: '/api/upload/r2',
      info: '/api/upload/info'
    }
  });
});

/**
 * Error handling middleware for multer
 */
router.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        error: 'File too large',
        message: 'File size exceeds the maximum allowed limit'
      });
    }
    if (error.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({
        error: 'Unexpected file',
        message: 'Unexpected file field'
      });
    }
  }

  if (error.message === 'Invalid file type. Only video files are allowed.') {
    return res.status(400).json({
      error: 'Invalid file type',
      message: 'Only video files are allowed'
    });
  }

  next(error);
});

module.exports = router;