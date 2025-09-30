const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const logger = require('../utils/logger');

const stat = promisify(fs.stat);

class VideoStreamService {
  /**
   * Parse Range header according to RFC 7233
   * @param {string} range - Range header value (e.g., "bytes=0-1023")
   * @param {number} fileSize - Total file size
   * @returns {Object} Parsed range object with start, end, and chunkSize
   */
  static parseRange(range, fileSize) {
    if (!range || !range.startsWith('bytes=')) {
      return null;
    }

    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    // Validate range
    if (isNaN(start) || isNaN(end) || start >= fileSize || end >= fileSize || start > end) {
      return null;
    }

    return {
      start,
      end,
      chunkSize: (end - start) + 1
    };
  }

  /**
   * Stream video file with Range Request support
   * @param {string} filePath - Path to video file
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   */
  static async streamVideo(filePath, req, res) {
    try {
      // Check if file exists
      const stats = await stat(filePath);
      const fileSize = stats.size;

      // Get range from request headers
      const range = req.headers.range;
      
      if (range) {
        // Handle Range Request (RFC 7233)
        const rangeData = this.parseRange(range, fileSize);
        
        if (!rangeData) {
          // Invalid range - return 416 Range Not Satisfiable
          res.status(416).set({
            'Content-Range': `bytes */${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Type': 'video/mp4'
          });
          return res.end();
        }

        const { start, end, chunkSize } = rangeData;

        // Set headers for partial content (206)
        res.status(206).set({
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize,
          'Content-Type': this.getVideoMimeType(filePath),
          'Cache-Control': 'public, max-age=3600',
          'Last-Modified': stats.mtime.toUTCString(),
          'ETag': `"${stats.size}-${stats.mtime.getTime()}"`
        });

        // Create read stream for the requested range
        const stream = fs.createReadStream(filePath, { start, end });
        
        // Handle stream errors
        stream.on('error', (error) => {
          logger.error('Stream error:', error);
          if (!res.headersSent) {
            res.status(500).end();
          }
        });

        // Pipe the stream to response
        stream.pipe(res);

        logger.info(`Streaming range ${start}-${end}/${fileSize} for ${path.basename(filePath)}`);
      } else {
        // No range header - stream entire file
        res.set({
          'Content-Length': fileSize,
          'Content-Type': this.getVideoMimeType(filePath),
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'public, max-age=3600',
          'Last-Modified': stats.mtime.toUTCString(),
          'ETag': `"${stats.size}-${stats.mtime.getTime()}"`
        });

        const stream = fs.createReadStream(filePath);
        
        stream.on('error', (error) => {
          logger.error('Stream error:', error);
          if (!res.headersSent) {
            res.status(500).end();
          }
        });

        stream.pipe(res);
        logger.info(`Streaming entire file ${path.basename(filePath)} (${fileSize} bytes)`);
      }
    } catch (error) {
      logger.error('Error streaming video:', error);
      
      if (error.code === 'ENOENT') {
        res.status(404).json({ error: 'Video file not found' });
      } else {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  }

  /**
   * Get appropriate MIME type for video file
   * @param {string} filePath - Path to video file
   * @returns {string} MIME type
   */
  static getVideoMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.mp4': 'video/mp4',
      '.webm': 'video/webm',
      '.ogg': 'video/ogg',
      '.avi': 'video/x-msvideo',
      '.mov': 'video/quicktime',
      '.mkv': 'video/x-matroska',
      '.m4v': 'video/x-m4v'
    };
    
    return mimeTypes[ext] || 'video/mp4';
  }

  /**
   * Get video metadata
   * @param {string} filePath - Path to video file
   * @returns {Object} Video metadata
   */
  static async getVideoMetadata(filePath) {
    try {
      const stats = await stat(filePath);
      return {
        filename: path.basename(filePath),
        size: stats.size,
        mimeType: this.getVideoMimeType(filePath),
        lastModified: stats.mtime,
        supportsRangeRequests: true
      };
    } catch (error) {
      logger.error('Error getting video metadata:', error);
      throw error;
    }
  }

  /**
   * Validate video file
   * @param {string} filePath - Path to video file
   * @returns {boolean} True if valid video file
   */
  static isValidVideoFile(filePath) {
    const allowedExtensions = ['.mp4', '.webm', '.ogg', '.avi', '.mov', '.mkv', '.m4v'];
    const ext = path.extname(filePath).toLowerCase();
    return allowedExtensions.includes(ext);
  }
}

module.exports = VideoStreamService;