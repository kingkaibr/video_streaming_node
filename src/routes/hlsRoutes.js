const express = require('express');
const HLSService = require('../services/hlsService');
const logger = require('../utils/logger');

const router = express.Router();
const hlsService = new HLSService();

/**
 * GET /api/hls/:stream/master.m3u8
 * Serve master playlist for adaptive streaming
 */
router.get('/:stream/master.m3u8', async (req, res) => {
  try {
    const { stream } = req.params;
    
    if (!hlsService.streamExists(stream)) {
      return res.status(404).json({
        error: 'Stream not found',
        message: `HLS stream '${stream}' not found`
      });
    }

    const playlist = await hlsService.getPlaylist(`${stream}/master.m3u8`);
    
    res.set({
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Range'
    });

    res.send(playlist);
    logger.info(`Served master playlist for stream: ${stream}`);

  } catch (error) {
    logger.error('Error serving master playlist:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to serve master playlist'
    });
  }
});

/**
 * GET /api/hls/:stream/:quality/playlist.m3u8
 * Serve quality-specific playlist
 */
router.get('/:stream/:quality/playlist.m3u8', async (req, res) => {
  try {
    const { stream, quality } = req.params;
    
    if (!hlsService.streamExists(stream)) {
      return res.status(404).json({
        error: 'Stream not found',
        message: `HLS stream '${stream}' not found`
      });
    }

    const playlist = await hlsService.getPlaylist(`${stream}/${quality}/playlist.m3u8`);
    
    res.set({
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Cache-Control': 'public, max-age=10',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Range'
    });

    res.send(playlist);
    logger.info(`Served ${quality} playlist for stream: ${stream}`);

  } catch (error) {
    logger.error('Error serving quality playlist:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to serve playlist'
    });
  }
});

/**
 * GET /api/hls/:stream/:quality/:segment
 * Serve HLS segment (.ts file)
 */
router.get('/:stream/:quality/:segment', async (req, res) => {
  try {
    const { stream, quality, segment } = req.params;
    
    // Validate segment file extension
    if (!segment.endsWith('.ts')) {
      return res.status(400).json({
        error: 'Invalid segment',
        message: 'Only .ts segments are allowed'
      });
    }

    if (!hlsService.streamExists(stream)) {
      return res.status(404).json({
        error: 'Stream not found',
        message: `HLS stream '${stream}' not found`
      });
    }

    const segmentData = await hlsService.getSegment(`${stream}/${quality}/${segment}`);
    
    res.set({
      'Content-Type': 'video/mp2t',
      'Cache-Control': 'public, max-age=31536000', // 1 year cache for segments
      'Access-Control-Allow-Origin': '*',
      'Content-Length': segmentData.length
    });

    res.send(segmentData);
    logger.debug(`Served segment ${segment} for ${stream}/${quality}`);

  } catch (error) {
    logger.error('Error serving segment:', error);
    
    if (error.code === 'ENOENT') {
      res.status(404).json({
        error: 'Segment not found',
        message: 'The requested segment was not found'
      });
    } else {
      res.status(500).json({
        error: 'Internal server error',
        message: 'Failed to serve segment'
      });
    }
  }
});

/**
 * GET /api/hls/streams
 * List all available HLS streams
 */
router.get('/streams', async (req, res) => {
  try {
    const streams = await hlsService.listStreams();
    
    res.json({
      count: streams.length,
      streams: streams.map(stream => ({
        ...stream,
        masterPlaylistUrl: `/api/hls/${stream.name}/master.m3u8`,
        qualities: stream.qualities.map(quality => ({
          ...quality,
          playlistUrl: `/api/hls/${quality.playlist}`
        }))
      }))
    });

  } catch (error) {
    logger.error('Error listing HLS streams:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to list streams'
    });
  }
});

/**
 * GET /api/hls/:stream/info
 * Get detailed information about a specific stream
 */
router.get('/:stream/info', async (req, res) => {
  try {
    const { stream } = req.params;
    
    if (!hlsService.streamExists(stream)) {
      return res.status(404).json({
        error: 'Stream not found',
        message: `HLS stream '${stream}' not found`
      });
    }

    const qualities = await hlsService.getStreamQualities(stream);
    
    res.json({
      name: stream,
      masterPlaylistUrl: `/api/hls/${stream}/master.m3u8`,
      qualities: qualities.map(quality => ({
        ...quality,
        playlistUrl: `/api/hls/${quality.playlist}`,
        segmentsUrl: `/api/hls/${stream}/${quality.name}/`
      })),
      streamingInfo: {
        protocol: 'HLS',
        adaptiveStreaming: true,
        supportedPlayers: ['HTML5 Video', 'Video.js', 'HLS.js', 'Safari', 'iOS', 'Android'],
        recommendedBufferSize: '30 seconds'
      }
    });

  } catch (error) {
    logger.error('Error getting stream info:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to get stream info'
    });
  }
});

/**
 * DELETE /api/hls/:stream
 * Delete an HLS stream
 */
router.delete('/:stream', async (req, res) => {
  try {
    const { stream } = req.params;
    
    if (!hlsService.streamExists(stream)) {
      return res.status(404).json({
        error: 'Stream not found',
        message: `HLS stream '${stream}' not found`
      });
    }

    await hlsService.deleteStream(stream);
    
    res.json({
      message: `Stream '${stream}' deleted successfully`
    });

    logger.info(`Deleted HLS stream: ${stream}`);

  } catch (error) {
    logger.error('Error deleting stream:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to delete stream'
    });
  }
});

/**
 * POST /api/hls/convert
 * Convert video to HLS format
 */
router.post('/convert', async (req, res) => {
  try {
    const { inputPath, outputName, options } = req.body;
    
    if (!inputPath || !outputName) {
      return res.status(400).json({
        error: 'Missing parameters',
        message: 'inputPath and outputName are required'
      });
    }

    // Start conversion (this is async and can take time)
    res.json({
      message: 'HLS conversion started',
      outputName: outputName,
      status: 'processing'
    });

    // Convert in background
    hlsService.convertToHLS(inputPath, outputName, options)
      .then(result => {
        logger.info(`HLS conversion completed for ${outputName}:`, result);
      })
      .catch(error => {
        logger.error(`HLS conversion failed for ${outputName}:`, error);
      });

  } catch (error) {
    logger.error('Error starting HLS conversion:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to start conversion'
    });
  }
});

module.exports = router;