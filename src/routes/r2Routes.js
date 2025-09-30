const express = require('express');
const R2StreamService = require('../services/r2StreamService');
const logger = require('../utils/logger');

const router = express.Router();
const r2Service = new R2StreamService();

/**
 * GET /api/video/r2/:key
 * Stream video from R2 with Range Request support
 */
router.get('/r2/:key(*)', async (req, res) => {
  try {
    const key = decodeURIComponent(req.params.key);
    
    // Validate that it's a video file
    if (!r2Service.isVideoFile(key)) {
      return res.status(400).json({
        error: 'Invalid file type',
        message: 'Only video files are allowed'
      });
    }

    // Stream the video from R2
    await r2Service.streamVideo(key, req, res);

  } catch (error) {
    logger.error('Error in R2 video streaming:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to stream video from R2'
    });
  }
});

/**
 * GET /api/video/r2/:key/metadata
 * Get video metadata from R2
 */
router.get('/r2/:key(*)/metadata', async (req, res) => {
  try {
    const key = decodeURIComponent(req.params.key);
    
    const metadata = await r2Service.getVideoMetadata(key);
    res.json(metadata);

  } catch (error) {
    logger.error('Error getting R2 video metadata:', error);
    
    if (error.name === 'NoSuchKey') {
      res.status(404).json({
        error: 'Video not found',
        message: 'Video file not found in R2'
      });
    } else {
      res.status(500).json({
        error: 'Internal server error',
        message: 'Failed to get video metadata'
      });
    }
  }
});

/**
 * GET /api/video/r2/:key/presigned
 * Generate presigned URL for direct R2 access
 */
router.get('/r2/:key(*)/presigned', async (req, res) => {
  try {
    const key = decodeURIComponent(req.params.key);
    const expiresIn = parseInt(req.query.expires) || 3600; // Default 1 hour
    
    // Validate expiration time (max 7 days)
    if (expiresIn > 604800) {
      return res.status(400).json({
        error: 'Invalid expiration time',
        message: 'Maximum expiration time is 7 days (604800 seconds)'
      });
    }

    const presignedUrl = await r2Service.getPresignedUrl(key, expiresIn);
    
    res.json({
      url: presignedUrl,
      expiresIn: expiresIn,
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString()
    });

  } catch (error) {
    logger.error('Error generating presigned URL:', error);
    
    if (error.name === 'NoSuchKey') {
      res.status(404).json({
        error: 'Video not found',
        message: 'Video file not found in R2'
      });
    } else {
      res.status(500).json({
        error: 'Internal server error',
        message: 'Failed to generate presigned URL'
      });
    }
  }
});

/**
 * GET /api/video/r2-list
 * List all videos in R2 bucket
 */
router.get('/r2-list', async (req, res) => {
  try {
    const prefix = req.query.prefix || '';
    const maxKeys = parseInt(req.query.limit) || 100;
    
    const videos = await r2Service.listVideos(prefix, maxKeys);
    
    res.json({
      count: videos.length,
      prefix: prefix,
      videos: videos
    });

  } catch (error) {
    logger.error('Error listing R2 videos:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to list R2 videos'
    });
  }
});

/**
 * HEAD /api/video/r2/:key
 * Get video headers without body from R2
 */
router.head('/r2/:key(*)', async (req, res) => {
  try {
    const key = decodeURIComponent(req.params.key);
    
    if (!r2Service.isVideoFile(key)) {
      return res.status(400).end();
    }

    const metadata = await r2Service.getVideoMetadata(key);
    
    res.set({
      'Content-Length': metadata.size,
      'Content-Type': metadata.mimeType,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=3600',
      'Last-Modified': metadata.lastModified?.toUTCString(),
      'ETag': metadata.etag
    });

    res.end();

  } catch (error) {
    logger.error('Error in R2 HEAD request:', error);
    res.status(500).end();
  }
});

/**
 * GET /api/video/r2/:key/stream-info
 * Get streaming information and options for a video
 */
router.get('/r2/:key(*)/stream-info', async (req, res) => {
  try {
    const key = decodeURIComponent(req.params.key);
    
    const metadata = await r2Service.getVideoMetadata(key);
    const presignedUrl = await r2Service.getPresignedUrl(key, 3600);
    
    res.json({
      ...metadata,
      streamingOptions: {
        directStream: `/api/video/r2/${encodeURIComponent(key)}`,
        presignedUrl: presignedUrl,
        hlsPlaylist: `/api/hls/r2/${encodeURIComponent(key)}/playlist.m3u8`,
        supportsRangeRequests: true,
        recommendedChunkSize: '1MB'
      },
      clientRecommendations: {
        usePresignedForLargeFiles: metadata.size > 100 * 1024 * 1024, // > 100MB
        enableProgressiveDownload: true,
        bufferSize: '5MB'
      }
    });

  } catch (error) {
    logger.error('Error getting R2 stream info:', error);
    
    if (error.name === 'NoSuchKey') {
      res.status(404).json({
        error: 'Video not found',
        message: 'Video file not found in R2'
      });
    } else {
      res.status(500).json({
        error: 'Internal server error',
        message: 'Failed to get stream info'
      });
    }
  }
});

module.exports = router;