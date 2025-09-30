const express = require('express');
const path = require('path');
const fs = require('fs');
const VideoStreamService = require('../services/videoStreamService');
const logger = require('../utils/logger');

const router = express.Router();

// Create videos directory if it doesn't exist
const videosDir = path.join(__dirname, '../../videos');
if (!fs.existsSync(videosDir)) {
  fs.mkdirSync(videosDir, { recursive: true });
}

/**
 * GET /api/video/local/:filename
 * Stream local video file with Range Request support
 */
router.get('/local/:filename', async (req, res) => {
  try {
    const { filename } = req.params;
    
    // Sanitize filename to prevent directory traversal
    const sanitizedFilename = path.basename(filename);
    const filePath = path.join(videosDir, sanitizedFilename);

    // Validate file extension
    if (!VideoStreamService.isValidVideoFile(filePath)) {
      return res.status(400).json({
        error: 'Invalid file type',
        message: 'Only video files are allowed'
      });
    }

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        error: 'Video not found',
        message: `Video file '${sanitizedFilename}' not found`
      });
    }

    // Stream the video with Range Request support
    await VideoStreamService.streamVideo(filePath, req, res);

  } catch (error) {
    logger.error('Error in local video streaming:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to stream video'
    });
  }
});

/**
 * GET /api/video/local/:filename/metadata
 * Get video metadata
 */
router.get('/local/:filename/metadata', async (req, res) => {
  try {
    const { filename } = req.params;
    const sanitizedFilename = path.basename(filename);
    const filePath = path.join(videosDir, sanitizedFilename);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        error: 'Video not found',
        message: `Video file '${sanitizedFilename}' not found`
      });
    }

    const metadata = await VideoStreamService.getVideoMetadata(filePath);
    res.json(metadata);

  } catch (error) {
    logger.error('Error getting video metadata:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to get video metadata'
    });
  }
});

/**
 * GET /api/video/list
 * List all available local videos
 */
router.get('/list', (req, res) => {
  try {
    const files = fs.readdirSync(videosDir)
      .filter(file => VideoStreamService.isValidVideoFile(file))
      .map(file => {
        const filePath = path.join(videosDir, file);
        const stats = fs.statSync(filePath);
        return {
          filename: file,
          size: stats.size,
          mimeType: VideoStreamService.getVideoMimeType(filePath),
          lastModified: stats.mtime,
          streamUrl: `/api/video/local/${file}`,
          metadataUrl: `/api/video/local/${file}/metadata`
        };
      });

    res.json({
      count: files.length,
      videos: files
    });

  } catch (error) {
    logger.error('Error listing videos:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to list videos'
    });
  }
});

/**
 * HEAD /api/video/local/:filename
 * Get video headers without body (useful for checking file info)
 */
router.head('/local/:filename', async (req, res) => {
  try {
    const { filename } = req.params;
    const sanitizedFilename = path.basename(filename);
    const filePath = path.join(videosDir, sanitizedFilename);

    if (!VideoStreamService.isValidVideoFile(filePath)) {
      return res.status(400).end();
    }

    if (!fs.existsSync(filePath)) {
      return res.status(404).end();
    }

    const metadata = await VideoStreamService.getVideoMetadata(filePath);
    
    res.set({
      'Content-Length': metadata.size,
      'Content-Type': metadata.mimeType,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=3600',
      'Last-Modified': metadata.lastModified.toUTCString()
    });

    res.end();

  } catch (error) {
    logger.error('Error in HEAD request:', error);
    res.status(500).end();
  }
});

module.exports = router;