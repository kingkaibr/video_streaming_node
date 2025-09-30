const { S3Client, GetObjectCommand, HeadObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const logger = require('../utils/logger');

class R2StreamService {
  constructor() {
    this.client = new S3Client({
      region: 'auto',
      endpoint: process.env.R2_ENDPOINT,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    });
    this.bucketName = process.env.R2_BUCKET_NAME;
  }

  /**
   * Stream video from R2 with Range Request support
   * @param {string} key - Object key in R2 bucket
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   */
  async streamVideo(key, req, res) {
    try {
      // First, get object metadata to determine file size
      const headCommand = new HeadObjectCommand({
        Bucket: this.bucketName,
        Key: key
      });

      const headResponse = await this.client.send(headCommand);
      const fileSize = headResponse.ContentLength;
      const contentType = headResponse.ContentType || 'video/mp4';
      const lastModified = headResponse.LastModified;
      const etag = headResponse.ETag;

      const range = req.headers.range;

      if (range) {
        // Handle Range Request
        const rangeData = this.parseRange(range, fileSize);
        
        if (!rangeData) {
          // Invalid range - return 416 Range Not Satisfiable
          res.status(416).set({
            'Content-Range': `bytes */${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Type': contentType
          });
          return res.end();
        }

        const { start, end, chunkSize } = rangeData;

        // Get object with range
        const getCommand = new GetObjectCommand({
          Bucket: this.bucketName,
          Key: key,
          Range: `bytes=${start}-${end}`
        });

        const response = await this.client.send(getCommand);

        // Set headers for partial content (206)
        res.status(206).set({
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize,
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=3600',
          'Last-Modified': lastModified?.toUTCString(),
          'ETag': etag
        });

        // Stream the response body
        response.Body.pipe(res);

        logger.info(`Streaming R2 range ${start}-${end}/${fileSize} for ${key}`);
      } else {
        // No range header - stream entire file
        const getCommand = new GetObjectCommand({
          Bucket: this.bucketName,
          Key: key
        });

        const response = await this.client.send(getCommand);

        res.set({
          'Content-Length': fileSize,
          'Content-Type': contentType,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'public, max-age=3600',
          'Last-Modified': lastModified?.toUTCString(),
          'ETag': etag
        });

        response.Body.pipe(res);
        logger.info(`Streaming entire R2 file ${key} (${fileSize} bytes)`);
      }
    } catch (error) {
      logger.error('Error streaming from R2:', error);
      
      if (error.name === 'NoSuchKey') {
        res.status(404).json({ error: 'Video file not found in R2' });
      } else if (error.name === 'InvalidRange') {
        res.status(416).json({ error: 'Invalid range request' });
      } else {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  }

  /**
   * Generate presigned URL for direct client access to R2
   * @param {string} key - Object key in R2 bucket
   * @param {number} expiresIn - URL expiration time in seconds (default: 3600)
   * @returns {string} Presigned URL
   */
  async getPresignedUrl(key, expiresIn = 3600) {
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: key
      });

      const url = await getSignedUrl(this.client, command, { expiresIn });
      logger.info(`Generated presigned URL for ${key}, expires in ${expiresIn}s`);
      return url;
    } catch (error) {
      logger.error('Error generating presigned URL:', error);
      throw error;
    }
  }

  /**
   * Get video metadata from R2
   * @param {string} key - Object key in R2 bucket
   * @returns {Object} Video metadata
   */
  async getVideoMetadata(key) {
    try {
      const command = new HeadObjectCommand({
        Bucket: this.bucketName,
        Key: key
      });

      const response = await this.client.send(command);
      
      return {
        filename: key.split('/').pop(),
        key: key,
        size: response.ContentLength,
        mimeType: response.ContentType || 'video/mp4',
        lastModified: response.LastModified,
        etag: response.ETag,
        supportsRangeRequests: true,
        metadata: response.Metadata || {}
      };
    } catch (error) {
      logger.error('Error getting R2 video metadata:', error);
      throw error;
    }
  }

  /**
   * Upload video to R2
   * @param {string} key - Object key in R2 bucket
   * @param {Buffer|Stream} body - File content
   * @param {Object} options - Upload options
   * @returns {Object} Upload result
   */
  async uploadVideo(key, body, options = {}) {
    try {
      const command = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: body,
        ContentType: options.contentType || 'video/mp4',
        Metadata: options.metadata || {},
        CacheControl: 'public, max-age=3600'
      });

      const response = await this.client.send(command);
      logger.info(`Successfully uploaded ${key} to R2`);
      
      return {
        key: key,
        etag: response.ETag,
        location: `${process.env.R2_ENDPOINT}/${this.bucketName}/${key}`
      };
    } catch (error) {
      logger.error('Error uploading to R2:', error);
      throw error;
    }
  }

  /**
   * Parse Range header according to RFC 7233
   * @param {string} range - Range header value
   * @param {number} fileSize - Total file size
   * @returns {Object|null} Parsed range object
   */
  parseRange(range, fileSize) {
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
   * List videos in R2 bucket
   * @param {string} prefix - Key prefix to filter results
   * @param {number} maxKeys - Maximum number of keys to return
   * @returns {Array} List of video objects
   */
  async listVideos(prefix = '', maxKeys = 100) {
    try {
      const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
      
      const command = new ListObjectsV2Command({
        Bucket: this.bucketName,
        Prefix: prefix,
        MaxKeys: maxKeys
      });

      const response = await this.client.send(command);
      
      return (response.Contents || [])
        .filter(obj => this.isVideoFile(obj.Key))
        .map(obj => ({
          key: obj.Key,
          filename: obj.Key.split('/').pop(),
          size: obj.Size,
          lastModified: obj.LastModified,
          etag: obj.ETag,
          streamUrl: `/api/video/r2/${encodeURIComponent(obj.Key)}`,
          metadataUrl: `/api/video/r2/${encodeURIComponent(obj.Key)}/metadata`
        }));
    } catch (error) {
      logger.error('Error listing R2 videos:', error);
      throw error;
    }
  }

  /**
   * Check if file is a video based on extension
   * @param {string} key - Object key
   * @returns {boolean} True if video file
   */
  isVideoFile(key) {
    const videoExtensions = ['.mp4', '.webm', '.ogg', '.avi', '.mov', '.mkv', '.m4v'];
    const extension = key.toLowerCase().substring(key.lastIndexOf('.'));
    return videoExtensions.includes(extension);
  }
}

module.exports = R2StreamService;